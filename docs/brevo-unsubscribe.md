# Brevo unsubscribe synchronization

`POST /api/brevo-webhook` mirrors Brevo marketing unsubscribe events for list `2`
into D1. It never deletes or creates subscribers and never calls Brevo.
The existing signup handler preserves subscription state on duplicate submissions;
a successful contact sync does not reset an unsubscribe. Brevo remains the
authority for marketing delivery. Resubscription and historical reconciliation
are outside this change.

## Production migration and secret

Run from the repository root before deploying this Worker change:

```sh
npx wrangler d1 migrations apply arthurgorries-db --remote
npx wrangler d1 execute arthurgorries-db --remote --command "PRAGMA table_info(subscribers);"
```

The new migration is `migrations/0002_subscriber_subscription_state.sql`:

```sql
ALTER TABLE subscribers ADD COLUMN status TEXT NOT NULL DEFAULT 'subscribed';
ALTER TABLE subscribers ADD COLUMN unsubscribed_at TEXT NULL;
```

Verify `status` is `TEXT`, `notnull = 1`, default `'subscribed'`, and
`unsubscribed_at` is nullable `TEXT`. Existing rows and sync metadata are retained.
Existing rows default to subscribed because D1 has no historical unsubscribe data;
this default is not proof of current consent and must not override Brevo's state.
Wrangler records applied migrations; do not also run the same ALTER statements
manually. This assumes the existing subscribers table and migration `0001` setup.

Generate a separate high-entropy token in your password manager (at least 32 random
bytes, represented as hex or base64). Save it there and set it through Wrangler's
hidden prompt:

```sh
npx wrangler secret put BREVO_WEBHOOK_TOKEN
```

Paste only the token, without `Bearer `. This configures the existing production
Worker. Do not reuse or change `BREVO_API_KEY`, put the token in a URL, or commit it
to any file. No change to `wrangler.jsonc` is needed: `/api/*` already runs through
the Worker. Deploy the code through the existing GitHub workflow after applying
the migration and configuring the secret, then configure Brevo below.

References: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Brevo setup

Use Brevo's current outbound-webhook interface:

1. Click your account name, then **Integrations > Webhooks**.
2. Click **Add webhook**, select **Outbound webhook**, then **Add webhook**.
3. Name it **Arthur Gorries D1 unsubscribe** and click **Continue**.
4. Set the URL to `https://arthurgorries.com/api/brevo-webhook`.
5. Choose **Token authentication** and paste the same token stored in
   `BREVO_WEBHOOK_TOKEN` (without the `Bearer ` prefix). Do not select no authentication.
6. Choose **Send one at a time**, then **Continue**. Batches are not supported by
   this endpoint.
7. Select **Marketing emails** and enable only the unsubscribe event
   (**Unsubscribed**). Turn off the other events enabled by default.
8. Optionally use the event's three-dot menu > **Send test request** to check
   delivery, then click **Activate webhook**.

No list filter is required in Brevo: the Worker checks the incoming `list_id`
array for integer `2`. A generic test payload may use a different list or email;
HTTP 204 alone therefore proves delivery, not a subscriber update.

These steps follow [Brevo's current setup guide](https://help.brevo.com/hc/en-us/articles/27824932835474-Create-outbound-webhooks-to-send-real-time-data-from-Brevo-to-an-external-app).
Brevo documents [bearer token authentication](https://developers.brevo.com/docs/secured-webhooks).
For API configuration, the equivalent fields for `POST /v3/webhooks` are:

```json
{
  "description": "Arthur Gorries D1 unsubscribe",
  "url": "https://arthurgorries.com/api/brevo-webhook",
  "type": "marketing",
  "channel": "email",
  "events": ["unsubscribed"],
  "batched": false,
  "auth": { "type": "bearer", "token": "REPLACE_WITH_THE_SAME_PRIVATE_TOKEN" }
}
```

Use either the UI or the API to create one webhook, not both.
The API configuration event is `unsubscribed`; the delivered event is
`unsubscribe`. See [Create a webhook](https://developers.brevo.com/reference/create-webhook)
and the [marketing unsubscribe payload](https://developers.brevo.com/docs/marketing-webhooks#unsubscribe).

## Event handling and timestamps

The documented payload fields used are `event`, `email`, `list_id`, `ts_event`, and
`ts`. Emails are trimmed and lowercased before lookup. Integer Unix seconds from
`ts_event` take precedence over `ts`. D1 stores UTC as `YYYY-MM-DD HH:MM:SS`.
If neither timestamp is usable, D1 uses receipt time (`CURRENT_TIMESTAMP`) and
the Worker logs that fallback. Brevo's `date_event` has no timezone, so the Worker
does not guess its UTC offset.

The first recorded unsubscribe timestamp is preserved. Repeated or out-of-order
events do not change a complete unsubscribe record. The single conditional UPDATE
also makes concurrent duplicate deliveries harmless. The sync flag and timestamp
remain unchanged.

| Response | Meaning |
| --- | --- |
| 204 | Updated, already unsubscribed, unknown email, or unrelated event/list |
| 400 | Invalid JSON, non-object/batched payload, or invalid email on a relevant event |
| 401 | Missing or incorrect bearer token |
| 405 | Endpoint called with a method other than POST |
| 500 | D1 update failed; delivery was not acknowledged as successful |
| 503 | Worker's webhook token is not configured |

Webhook logs contain only fixed messages and an updated-row count, never the
token, headers, email, raw payload, or raw database errors. `updated: 0` means an
unknown email or an already complete unsubscribe. No application retry job is added.

## Safe verification

Before deployment, run in your IDE terminal (Node 22.13+):

```sh
node --test tests/brevo-webhook.test.mjs
node --test tests/*.test.mjs
```

Expect all tests to pass with zero failures. Tests invoke the actual Worker handler
with a dummy token and an in-memory SQLite database using both migrations. They
cover authenticated updates, timestamp fallback, duplicate/out-of-order delivery,
unrelated lists/events, unknown subscribers, bad authentication, malformed requests,
D1 failure and redelivery, signup after unsubscribe, and static asset routing.
They do not read real secrets, access production D1, or send email. The Node
module-type warning for `src/index.js` is harmless; the project also contains
CommonJS build scripts, so its package module type is left unchanged.

For a live end-to-end check after deployment and webhook activation:

1. Sign up with a dedicated email address you own and verify it exists in Brevo
   list `2` and D1. Do not use an actual subscriber's address.
2. Send a marketing campaign only to that test contact in list `2`, then use its
   unsubscribe link. This checks the real marketing unsubscribe flow; a preview
   email or manual contact edit may not produce that event.
3. In Cloudflare's `arthurgorries-db` console, replace the example address below
   with the lowercase test address and run:

   ```sql
   SELECT id, name, email, created_at, status, unsubscribed_at,
          brevo_synced, brevo_synced_at
   FROM subscribers
   WHERE email = 'your-test-address@example.com';
   ```

   Expect the original row, `status = 'unsubscribed'`, and a non-null timestamp.
   Check the contact's unsubscribe state in Brevo as well.
4. Inspect Worker logs with `npx wrangler tail` or Cloudflare's logs, and Brevo's
   webhook delivery statistics. A processed event with `updated: 1` confirms the
   D1 write. Keep this test contact unsubscribed; there is no need to delete it.

Unsubscribes that happened before this webhook was enabled are not backfilled.
Use Brevo for marketing eligibility even while D1 history is incomplete.
