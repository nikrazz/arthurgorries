# Brevo sync tracking

D1 capture determines website signup success. Brevo failures and sync-status
write failures are logged separately and do not change the success redirect.
New and pre-existing rows default to `brevo_synced = 0` and
`brevo_synced_at = NULL`. Existing rows are not assumed to exist in Brevo.
A successful Contacts API response records `1` and `CURRENT_TIMESTAMP`.
Duplicate submissions preserve previous sync status until another success updates
the timestamp. There is no automatic retry or reconciliation.

The flag records a confirmed past sync, not current marketing consent or the
outcome of every later attempt. If recording a successful response fails, the row
keeps its previous state; an unsynced row may therefore already exist in Brevo.

## Production migration

Apply this additive migration to the existing `arthurgorries-db` **before deploying
the Worker change**. It assumes the `subscribers` table already exists; it does not
bootstrap a fresh database. No production database changes are made by the tests.

Using an authenticated Wrangler CLI from the project root:

```sh
wrangler d1 migrations apply arthurgorries-db --remote
wrangler d1 execute arthurgorries-db --remote --command "PRAGMA table_info(subscribers);"
```

Wrangler uses the default `migrations/` directory and tracks applied migrations.
See [Cloudflare's migration documentation](https://developers.cloudflare.com/d1/reference/migrations/).

The exact SQL in `migrations/0001_subscriber_brevo_sync.sql` is:

```sql
ALTER TABLE subscribers ADD COLUMN brevo_synced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN brevo_synced_at TEXT NULL;
```

Verify `PRAGMA table_info` shows `brevo_synced` as `INTEGER`, not-null, default `0`,
and `brevo_synced_at` as nullable `TEXT`. Apply via Wrangler rather than also
executing the same SQL manually; the raw `ALTER TABLE` statements are not rerunnable.
No new Cloudflare secrets or Brevo configuration are required.

## Verify a live successful sync

After migration and deployment, submit the newsletter form with a new email
address you control. Expect `/?signup=success#newsletter`. In the D1 console run
the following, replacing the example with the lowercase test address:

```sql
SELECT id, name, email, created_at, brevo_synced, brevo_synced_at
FROM subscribers
WHERE email = 'your-test-address@example.com';
```

Expect `brevo_synced = 1`, a non-null timestamp, and the contact in Brevo list `2`.
Resubmit the same address to verify it stays one row and records another successful
sync. Old subscribers stay unconfirmed until a successful sync is recorded.

Find pending or failed syncs with:

```sql
SELECT id, name, email, created_at
FROM subscribers
WHERE brevo_synced = 0
ORDER BY created_at DESC;
```

## Deliberately verify failure without touching the real key

The tests use Node's built-in test runner and `node:sqlite` (Node 22.13+), an
in-memory database, a dummy key, and mocked Brevo responses. They never read the
real key, contact Brevo, or access production D1.

```sh
node --test tests/subscribe.test.mjs
node --test --test-name-pattern='HTTP failure|network failure' tests/subscribe.test.mjs
```

The filtered tests deliberately return HTTP 401 or throw a network error. Each
asserts a success redirect, a retained row with `0`/`NULL`, inclusion in the pending
query, and a Brevo failure log. The full suite also checks successful 201/204
responses, legacy rows, duplicate submissions after success, and both initial
capture and sync-status write failures. These are simulated failure checks of the
actual Worker handler, not a live Cloudflare/Brevo integration test.
