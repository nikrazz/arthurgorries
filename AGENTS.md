# Arthur Gorries Website

## Project

Arthur Gorries is a Brisbane punk/garage-rock band website.

Production: https://arthurgorries.com/

Keep changes simple, focused, and consistent with the existing site. Inspect the current implementation before changing it instead of assuming generic Hugo or Hugoplate conventions.

## Stack

- Hugo
- Hugoplate
- Tailwind CSS v4
- Vanilla JavaScript
- pnpm
- GitHub
- Cloudflare Workers + Static Assets
- Cloudflare D1
- Brevo

Production deploys from GitHub through Cloudflare.

## Project structure

Important files currently include:

```text
content/_index.md
layouts/baseof.html
layouts/home.html
layouts/_partials/
assets/images/
assets/css/custom.css
src/index.js
wrangler.jsonc
hugo.toml
package.json
pnpm-lock.yaml
```

This project uses Hugo's newer template system.

Use:

```text
layouts/baseof.html
layouts/home.html
layouts/_partials/
```

Do not move these to older Hugo locations such as:

```text
layouts/_default/baseof.html
layouts/index.html
layouts/partials/
```

Do not modify files inside `themes/hugoplate/` unless there is no reasonable project-level override.

## Homepage

Homepage content lives in:

```text
content/_index.md
```

and is rendered by:

```text
layouts/home.html
```

The homepage currently uses these front-matter sections:

```text
banner
next_gig
newsletter
```

Keep editable copy, image paths, links, and CTA text in front matter where practical.

Do not rename or restructure these sections without a concrete reason.

## Images

Site images are stored under:

```text
assets/images/
```

Homepage front matter currently references images using paths such as:

```text
/images/arthur-gorries-logo.png
```

The site already uses the Hugoplate image partial:

```go-html-template
{{ partial "image" (...) }}
```

Reuse it instead of introducing another image system.

Use meaningful alt text and lazy loading for below-the-fold images.

## Tailwind and CSS

This project uses Tailwind CSS v4 with the existing Hugoplate CSS-first setup.

Do not create `tailwind.config.js`.

Project-specific CSS overrides live in:

```text
assets/css/custom.css
```

Preserve the existing dark, minimal punk/garage-rock visual style.

Avoid unnecessary arbitrary values, `!important`, or unrelated CSS refactors.

## Package manager and commands

This repository uses pnpm, confirmed by:

```text
pnpm-lock.yaml
```

Useful scripts from `package.json`:

```sh
pnpm dev
pnpm build
pnpm preview
pnpm format
```

Use `pnpm build` as the main production build verification because it runs the theme generator and Hugo production build together.

Do not change package managers.

## Hugo configuration

Main Hugo configuration:

```text
hugo.toml
```

Current production base URL:

```text
https://arthurgorries.com/
```

Taxonomy and term pages are disabled.

The Hugo security configuration explicitly allows the Tailwind CLI.

Do not change Hugo version/configuration as part of unrelated work.

## Copy style

Arthur Gorries copy should be:

- short
- dry
- direct
- young
- understated
- slightly abrasive
- occasionally self-deprecating

Avoid generic music-marketing language such as "unforgettable night", "electrifying performance", "amazing crowd", or "taking the scene by storm".

Existing tone examples include:

- "gave him a bass, and made the problem worse"
- "Come see whether this was a good idea."
- "The name came from the prison down the road. Wacol has worse landmarks."

## Cloudflare

Cloudflare Worker entry point:

```text
src/index.js
```

Cloudflare configuration:

```text
wrangler.jsonc
```

Static Hugo output is served from:

```text
./public
```

through the `ASSETS` binding.

API routes run through the Worker first for:

```text
/api/*
```

D1 binding:

```text
DB
```

Database:

```text
arthurgorries-db
```

Never commit API keys, webhook tokens, Cloudflare credentials, or other secrets.

## Newsletter

Newsletter signup endpoint:

```text
POST /api/subscribe
```

Current flow:

```text
website form
-> D1 subscriber write
-> Brevo contact sync
-> redirect to /?signup=success#newsletter
```

D1 is the guaranteed capture. A Brevo API failure must not turn a successful D1 signup into a failed website signup.

Brevo list ID:

```text
2
```

Brevo API secret:

```text
BREVO_API_KEY
```

The Worker already tracks successful Brevo syncs using:

```text
brevo_synced
brevo_synced_at
```

Do not treat sync-status tracking as pending work.

## Brevo unsubscribe webhook

The Worker already contains:

```text
POST /api/brevo-webhook
```

and expects the secret:

```text
BREVO_WEBHOOK_TOKEN
```

The code attempts to update D1 subscriber fields including:

```text
status
unsubscribed_at
```

Known issue: an unsubscribe performed in Brevo has not yet been confirmed to register correctly in D1. Do not assume the webhook flow is working end-to-end. When this issue is revisited, diagnose the existing implementation before rewriting it.

## General development rules

- Inspect relevant existing files before editing.
- Make the smallest change that solves the task.
- Preserve the existing architecture.
- Do not introduce React, Vue, Next.js, or another frontend framework.
- Prefer Hugo templates, Tailwind, and vanilla JavaScript.
- Do not perform unrelated refactors.
- Do not modify generated `public/` output unless specifically required.
- Do not commit secrets.
- Do not rewrite Git history.

Before finishing a coding task:

1. run `pnpm build`
2. confirm there are no Hugo/template/build errors
3. inspect the diff
4. report which files changed
5. report any manual Cloudflare, Brevo, or D1 steps still required
