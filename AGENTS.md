# Arthur Gorries Website

## Project

Arthur Gorries is a punk/garage-rock band website:

https://arthurgorries.com/

Keep the site simple, fast, and easy to maintain. Avoid adding frameworks, services, abstractions, or dependencies unless they solve a current requirement.

## Stack

* Hugo
* Hugoplate theme
* Tailwind CSS v4
* Vanilla JavaScript
* GitHub
* Cloudflare Workers + Static Assets
* Cloudflare D1
* Brevo for mailing-list management and email delivery

Production deploys automatically from GitHub through Cloudflare.

---

# Hugo project rules

## Hugo 0.146+ template system

This project uses Hugo's newer template system.

Use the current Hugo documentation as the source of truth:

https://gohugo.io/documentation/

Important project conventions:

* Partials belong under `layouts/_partials/`
* Homepage layout is `layouts/home.html`
* `layouts/baseof.html` is top-level
* Do not change these to older Hugo conventions such as:

  * `layouts/partials/`
  * `layouts/index.html`
  * `layouts/_default/baseof.html`

Do not modify files inside `themes/hugoplate/` unless there is no reasonable project-level override.

Prefer overrides in the site's own:

```text
layouts/
assets/
content/
data/
config/
```

## Tailwind CSS

This project uses Tailwind CSS v4.

Tailwind configuration is CSS-first and uses the existing Hugoplate theme system.

Do not create a `tailwind.config.js`.

Use Tailwind utilities for styling wherever practical.

Prefer Tailwind's standard:

* spacing
* width
* colour
* typography
* responsive breakpoint

scales over arbitrary values.

Use custom CSS only when Tailwind is unsuitable.

---

# Package manager

Detect the package manager instead of assuming one.

Priority:

1. `package.json` → `packageManager`
2. lock file:

   * `pnpm-lock.yaml` → pnpm
   * `package-lock.json` → npm
   * `yarn.lock` → yarn
   * `bun.lock` / `bun.lockb` → bun
3. otherwise inspect the existing project before choosing

Do not change package managers unless explicitly requested.

---

# Development

Before completing changes, run an appropriate build check.

At minimum:

```sh
hugo
```

If the project has an existing package-script build process that performs additional required Tailwind/theme generation, use that as well.

Do not rewrite working build tooling unnecessarily.

Do not commit generated `public/` files unless the repository already intentionally tracks them.

---

# General development principles

* Prefer the simplest implementation that solves the task.
* Preserve the existing architecture.
* Do not introduce React, Vue, Next.js, or another frontend framework.
* Prefer Hugo templates and vanilla JavaScript.
* Keep changes focused on the requested task.
* Do not perform unrelated refactors.
* Keep content editable through Hugo front matter when practical.
* Preserve the site's existing dark, minimal punk/garage-rock visual style.

---

# Cloudflare

The site uses Cloudflare Workers with static assets.

Worker entry point:

```text
src/index.js
```

Static site assets are served through:

```js
env.ASSETS
```

API requests are handled by the Worker.

Cloudflare configuration lives in:

```text
wrangler.jsonc
```

Do not put secrets in `wrangler.jsonc`.

---

# Newsletter signup

Current endpoint:

```text
POST /api/subscribe
```

Successful signup redirects to:

```text
/?signup=success#newsletter
```

Invalid and failed submissions use equivalent `signup` query-string states.

The website signup flow is:

```text
Website form
    |
    v
Cloudflare Worker
    |
    +--> D1
    |
    +--> Brevo API
```

## D1 is guaranteed capture

D1 is the site's guaranteed subscriber record.

Database:

```text
arthurgorries-db
```

Worker binding:

```text
DB
```

Table:

```text
subscribers
```

Existing core fields:

```text
id
name
email
created_at
```

Normalize email addresses to lowercase before storage and comparison.

A successful D1 write means the website signup is successful.

A Brevo failure must not cause a successful D1 signup to be reported as failed.

---

# Brevo

Brevo contact list ID:

```text
2
```

The Brevo API key is available through the Cloudflare Worker secret:

```text
BREVO_API_KEY
```

Never hard-code, print, or commit this value.

Website subscribers are synced to Brevo through the Contacts API using:

```js
listIds: [2]
updateEnabled: true
```

Brevo is the operational authority for whether somebody should currently receive marketing email.

D1 remains the site's record of the subscription lifecycle.

---

# Error handling

## Validation or D1 failure

If form processing or D1 storage fails:

* log the error
* do not report signup success
* redirect using the existing error state

## Brevo failure

If D1 succeeds but Brevo fails:

* retain the D1 subscriber
* still report signup success to the visitor
* log the Brevo failure
* track the failed sync once sync-status tracking exists

Do not throw Brevo API failures into the outer D1/form failure handler.

---

# Pending work

## 1. Track Brevo sync status in D1

Add persistent sync tracking.

Suggested fields:

```text
brevo_synced INTEGER NOT NULL DEFAULT 0
brevo_synced_at TEXT NULL
```

After a successful Brevo API response:

```text
brevo_synced = 1
brevo_synced_at = current timestamp
```

A failed Brevo request must leave the subscriber identifiable as unsynced.

Do not overwrite an existing successful sync status with `0` simply because the same subscriber submits again.

Do not implement automatic retry/reconciliation unless explicitly requested.

---

## 2. Brevo unsubscribe webhook

Implement:

```text
POST /api/brevo-webhook
```

Desired flow:

```text
Brevo unsubscribe
    |
    v
/api/brevo-webhook
    |
    v
D1 subscriber updated
```

Do not delete subscribers when they unsubscribe.

Add explicit subscription state such as:

```text
status = subscribed | unsubscribed
unsubscribed_at
```

Requirements:

* verify the current Brevo webhook payload against Brevo documentation
* process unsubscribe events relevant to list ID `2`
* normalize emails before lookup
* make processing idempotent
* ignore unrelated events safely
* protect the webhook using an appropriate Brevo-compatible security mechanism
* never hard-code webhook secrets

---

## 3. Welcome email

Brevo should eventually send a welcome email automatically when a new contact is added to list `2`.

This is configured in Brevo rather than implemented in the website Worker unless explicitly requested otherwise.

---

## 4. Existing pre-Brevo subscribers

Some subscribers may exist in D1 from before Brevo integration was enabled.

Do not assume all existing D1 subscribers already exist in Brevo.

For the current small list, manual reconciliation is acceptable.

---

# D1 schema changes

Schema changes must be additive and safe.

Do not run destructive production database operations unless explicitly requested.

When a task requires a schema change:

1. modify project migration/schema files if the project uses them
2. provide the exact SQL required for production D1
3. explain how to verify the migration

Do not delete subscriber records as part of unsubscribe handling.

---

# Secrets

Never commit:

* Brevo API keys
* webhook secrets
* Cloudflare API tokens
* credentials
* private tokens

Secrets belong in Cloudflare Worker secrets/environment configuration.

---

# Git

Do not:

* rewrite Git history
* commit secrets
* create unrelated changes

Before finishing a task:

* run relevant checks
* inspect the diff
* report files changed
* report any SQL that must be run
* report any Cloudflare or Brevo configuration the user must perform manually
