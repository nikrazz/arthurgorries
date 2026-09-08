import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../src/index.js";

const migration = await readFile(
  new URL("../migrations/0001_subscriber_brevo_sync.sql", import.meta.url),
  "utf8",
);
const subscriptionMigration = await readFile(
  new URL("../migrations/0002_subscriber_subscription_state.sql", import.meta.url),
  "utf8",
);

function setup(t, { failCapture = false, failTracking = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Minimal existing schema required by the Worker's current upsert.
  db.exec(`CREATE TABLE subscribers (
    id INTEGER PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO subscribers (name, email) VALUES ('Legacy', 'legacy@example.com');`);
  db.exec(migration);
  db.exec(subscriptionMigration);
  const errors = t.mock.method(console, "error", () => {});
  const env = {
    BREVO_API_KEY: "deliberately-invalid-test-key",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                if (failCapture && sql.includes("INSERT INTO")) {
                  throw new Error("Capture unavailable");
                }
                if (failTracking && sql.includes("UPDATE subscribers")) {
                  throw new Error("Tracking unavailable");
                }
                return db.prepare(sql).run(...values);
              },
            };
          },
        };
      },
    },
  };
  return {
    db, errors,
    row: () => db.prepare("SELECT * FROM subscribers WHERE email = ?").get("test@example.com"),
    submit: (email = " Test@Example.COM ") => worker.fetch(new Request(
      "https://example.com/api/subscribe",
      { method: "POST", body: new URLSearchParams({ name: "Test", email }) },
    ), env),
  };
}

function assertRedirect(response, state) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), `https://example.com/?signup=${state}#newsletter`);
}

test("migration retains legacy subscribers with unknown sync state", (t) => {
  const { db } = setup(t);
  const row = db.prepare("SELECT * FROM subscribers").get();
  assert.equal(row.name, "Legacy");
  assert.equal(row.brevo_synced, 0);
  assert.equal(row.brevo_synced_at, null);
  assert.ok(row.created_at);
  assert.equal(row.status, "subscribed");
  assert.equal(row.unsubscribed_at, null);
});

for (const status of [201, 204]) {
  test(`Brevo ${status} records successful sync after capture`, async (t) => {
    const { submit, row, errors } = setup(t);
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(row().brevo_synced, 0);
      assert.equal(row().brevo_synced_at, null);
      assert.equal(url, "https://api.brevo.com/v3/contacts");
      assert.deepEqual(JSON.parse(options.body), {
        email: "test@example.com", attributes: { FIRSTNAME: "Test" },
        listIds: [2], updateEnabled: true,
      });
      return new Response(null, { status });
    });
    assertRedirect(await submit(), "success");
    assert.equal(row().brevo_synced, 1);
    assert.equal(row().status, "subscribed");
    assert.match(row().brevo_synced_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(errors.mock.callCount(), 0);
  });
}

for (const failure of ["HTTP", "network"]) {
  test(`${failure} failure keeps captured subscriber pending and signup successful`, async (t) => {
    const { submit, row, db, errors } = setup(t);
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new Error("Network unavailable");
      return new Response("Unauthorized", { status: 401 });
    });
    assertRedirect(await submit(), "success");
    assert.equal(row().brevo_synced, 0);
    assert.equal(row().brevo_synced_at, null);
    const pending = db.prepare(`SELECT id, name, email, created_at
      FROM subscribers WHERE brevo_synced = 0 ORDER BY created_at DESC`).all();
    assert.ok(pending.some((subscriber) => subscriber.email === "test@example.com"));
    assert.equal(errors.mock.calls[0].arguments[0], "Brevo sync failed:");
  });
}

test("duplicate submissions retain a successful sync on later Brevo failure", async (t) => {
  const { submit, row, db } = setup(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assertRedirect(await submit(), "success");
  db.exec("UPDATE subscribers SET brevo_synced_at = '2020-01-01 00:00:00' WHERE email = 'test@example.com'");
  const original = row();
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 500 }));
  assertRedirect(await submit("TEST@example.com"), "success");
  assert.deepEqual(row(), original);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM subscribers").get().total, 2);
});

test("pending existing subscribers can become synced by resubmitting", async (t) => {
  const { submit, db } = setup(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assertRedirect(await submit("LEGACY@example.com"), "success");
  const row = db.prepare("SELECT * FROM subscribers").get();
  assert.equal(row.id, 1);
  assert.equal(row.name, "Test");
  assert.equal(row.brevo_synced, 1);
  assert.ok(row.brevo_synced_at);
});

test("tracking write failure preserves capture and signup success with a distinct log", async (t) => {
  const { submit, row, errors } = setup(t, { failTracking: true });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assertRedirect(await submit(), "success");
  assert.equal(row().brevo_synced, 0);
  assert.equal(row().brevo_synced_at, null);
  assert.equal(errors.mock.calls[0].arguments[0], "Brevo sync status update failed:");
});

test("capture failure still returns signup error and skips Brevo", async (t) => {
  const { submit, row } = setup(t, { failCapture: true });
  const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected Brevo request"));
  assertRedirect(await submit(), "error");
  assert.equal(row(), undefined);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("signup preserves a Brevo unsubscribe even when contact sync succeeds", async (t) => {
  const { submit, db } = setup(t);
  db.exec(`UPDATE subscribers SET status = 'unsubscribed',
    unsubscribed_at = '2026-09-01 00:00:00' WHERE email = 'legacy@example.com'`);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal("emailBlacklisted" in JSON.parse(options.body), false);
    return new Response(null, { status: 204 });
  });
  assertRedirect(await submit("legacy@example.com"), "success");
  const row = db.prepare("SELECT * FROM subscribers").get();
  assert.equal(row.status, "unsubscribed");
  assert.equal(row.unsubscribed_at, "2026-09-01 00:00:00");
  assert.equal(row.brevo_synced, 1);
});
