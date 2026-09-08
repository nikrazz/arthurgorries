import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../src/index.js";

const migrations = await Promise.all([
  "0001_subscriber_brevo_sync.sql",
  "0002_subscriber_subscription_state.sql",
].map((name) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")));

const token = "local-test-token-not-a-real-secret";
const payload = {
  event: "unsubscribe",
  email: " Subscriber@Example.COM ",
  list_id: [3, 2],
  ts_event: 1604933737,
  ts: 1604937337,
};

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE subscribers (
    id INTEGER PRIMARY KEY, name TEXT, email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO subscribers (name, email) VALUES ('Subscriber', 'subscriber@example.com');`);
  for (const migration of migrations) db.exec(migration);
  db.exec("UPDATE subscribers SET brevo_synced = 1, brevo_synced_at = '2020-01-01 00:00:00'");
  const logs = ["info", "warn", "error"].map((method) => t.mock.method(console, method, () => {}));
  t.mock.method(globalThis, "fetch", () => assert.fail("Webhook must not call Brevo"));
  const env = {
    BREVO_WEBHOOK_TOKEN: token,
    DB: {
      prepare(sql) {
        return { bind: (...values) => ({
          async run() {
            const result = db.prepare(sql).run(...values);
            return { success: true, meta: { changes: result.changes } };
          },
        }) };
      },
    },
    ASSETS: { fetch: async () => new Response("static asset") },
  };
  const row = () => db.prepare("SELECT * FROM subscribers").get();
  const original = row();
  return {
    db, env, row, original, logs,
    send: (body = payload, authorization = `Bearer ${token}`) => worker.fetch(new Request(
      "https://example.com/api/brevo-webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify(body),
      },
    ), env),
  };
}

test("unsubscribe normalizes email, preserves subscriber history, and prefers event time", async (t) => {
  const { send, row, original, db, logs } = setup(t);
  assert.equal((await send()).status, 204);
  assert.deepEqual({ ...row() }, {
    ...original, status: "unsubscribed", unsubscribed_at: "2020-11-09 14:55:37",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM subscribers").get().total, 1);
  assert.deepEqual(logs[0].mock.calls[0].arguments, ["Brevo unsubscribe processed:", { updated: 1 }]);
});

test("repeated and out-of-order deliveries preserve the first recorded unsubscribe", async (t) => {
  const { send, row, logs } = setup(t);
  await send();
  const original = row();
  for (const ts_event of [payload.ts_event, payload.ts_event + 100, payload.ts_event - 100]) {
    assert.equal((await send({ ...payload, ts_event })).status, 204);
    assert.deepEqual(row(), original);
    assert.equal(logs[0].mock.calls.at(-1).arguments[1].updated, 0);
  }
});

test("missing ts_event falls back to documented ts", async (t) => {
  const { send, row } = setup(t);
  assert.equal((await send({ ...payload, ts_event: undefined })).status, 204);
  assert.equal(row().unsubscribed_at, "2020-11-09 15:55:37");
});

test("unusable timestamps fall back to receipt time without changing it on replay", async (t) => {
  const { send, row, db } = setup(t);
  const event = { ...payload, ts_event: "bad", ts: 1e20, date_event: "2020-10-09 00:00:00" };
  const before = db.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now;
  assert.equal((await send(event)).status, 204);
  const original = row();
  const after = db.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now;
  assert.ok(original.unsubscribed_at >= before && original.unsubscribed_at <= after);
  assert.equal((await send(event)).status, 204);
  assert.deepEqual(row(), original);
});

for (const changes of [
  { event: "opened" }, { event: "unsubscribed" }, { event: "contact_deleted" },
  { list_id: [3, 42] }, { list_id: [] }, { list_id: undefined },
  { list_id: ["2"] }, { list_id: 2 }, { list_id: undefined, listIds: [2] },
]) {
  test(`ignores unrelated or undocumented event/list shape ${JSON.stringify(changes)}`, async (t) => {
    const { send, row, original, env } = setup(t);
    env.DB.prepare = () => assert.fail("Ignored events must not access D1");
    assert.equal((await send({ ...payload, ...changes })).status, 204);
    assert.deepEqual(row(), original);
  });
}

test("unknown subscriber is acknowledged without creating or deleting records", async (t) => {
  const { send, row, original, db } = setup(t);
  assert.equal((await send({ ...payload, email: "unknown@example.com" })).status, 204);
  assert.deepEqual(row(), original);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM subscribers").get().total, 1);
});

test("missing or wrong authorization cannot access D1", async (t) => {
  const { send, env, logs } = setup(t);
  env.DB.prepare = () => assert.fail("Unauthorized request accessed D1");
  for (const authorization of [null, "Bearer wrong", `Basic ${token}`]) {
    assert.equal((await send(payload, authorization)).status, 401);
  }
  assert.ok(!JSON.stringify(logs.flatMap((log) => log.mock.calls)).includes(token));
});

test("missing configured token fails closed", async (t) => {
  const { send, env } = setup(t);
  delete env.BREVO_WEBHOOK_TOKEN;
  env.DB.prepare = () => assert.fail("Unconfigured webhook accessed D1");
  assert.equal((await send()).status, 503);
});

test("malformed JSON, non-object payloads, batches, and invalid emails return 400", async (t) => {
  const { send, env, row, original } = setup(t);
  for (const body of [null, [], [payload], "event", { ...payload, email: null }, { ...payload, email: "invalid" }]) {
    assert.equal((await send(body)).status, 400);
  }
  const response = await worker.fetch(new Request("https://example.com/api/brevo-webhook", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{",
  }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(row(), original);
});

test("D1 failure returns 500 without leaking error details and a redelivery can succeed", async (t) => {
  const { send, env, row, original, logs } = setup(t);
  const prepare = env.DB.prepare;
  env.DB.prepare = () => { throw new Error(`private DB error ${token}`); };
  const response = await send();
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(token));
  assert.deepEqual(row(), original);
  assert.deepEqual(logs[2].mock.calls[0].arguments, ["Brevo unsubscribe failed: D1 update failed"]);
  env.DB.prepare = prepare;
  assert.equal((await send()).status, 204);
  assert.equal(row().status, "unsubscribed");
});

test("webhook only accepts POST and static asset routing remains intact", async (t) => {
  const { env } = setup(t);
  const response = await worker.fetch(new Request("https://example.com/api/brevo-webhook"), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.equal(await (await worker.fetch(new Request("https://example.com/"), env)).text(), "static asset");
});
