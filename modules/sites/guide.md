# Sites

Multi-site web builder. Pages, page composition, custom domains, draft preview, schema-driven content authoring, A/B experiments, analytics, and publishing to portal / k8s-internal / external (Cloudflare Pages, Netlify) targets.

## Overview

The sites module turns gatewaze into a web-builder: each row in `public.sites` is a website. Sites have pages (`public.pages`), pages have content (either schema-driven JSONB on `pages.content` or blocks-based composition via `page_blocks` + `page_block_bricks`), and the publish-worker assembles everything into a Next.js content tree that gets committed to a per-site git repo and deployed by the configured publisher.

A site's content schema is supplied by a templates_library (via the templates module). Operators can either provision a starter library inline or **connect their own external git repo as the source of truth** — gatewaze ingests the JSON Schema, mirrors the working tree into an internal bare repo, and stores the PAT for future refreshes.

Each site gets:
- A subdomain `slug.sites.<brand>.<tld>` reserved for it (Traefik regex; no per-site config).
- An internal bare git repo provisioned at site creation (`gatewaze_internal_repos` row, `barePath` on the platform's PVC).
- Auto-provisioned Umami "website" entry if `umami` is installed and configured; the `<script>` tag lands on every emitted page automatically.
- Lifecycle cleanup on archive: site row marked `archived`, internal repo soft-deleted (30-day retention), Umami website removed, in-flight A/B tests concluded.

The seeded **Portal** site (slug `portal`) represents the platform's own admin/member UI. Its tabs are read-only — pages are managed in the portal Next.js codebase, publishing flows through the platform's deploy pipeline.

## End-to-end user journey

### 1. Create a site

`/sites → "+ New Site" → name + slug + description`. Behind the scenes:

1. INSERTs into `public.sites` with `theme_kind='website'` and `publishing_target={kind:'portal'}`.
2. Auto-provisions a starter `templates_libraries` row (host_kind='site') + a default `<html>` wrapper with a `{{>head}}` slot + a `templates_sources` (`kind='inline'`) + a `templates_content_schemas` row holding a minimal hero+sections schema. Updates `sites.templates_library_id`.
3. Calls `POST /admin/sites/:id/internal-repo:ensure` — `gitServer.createRepo` registers `gatewaze_internal_repos` and `git init --bare`s the repo on the platform's PVC.
4. Calls `POST /admin/sites/:id/integrations:provision` — if `umami` is enabled, posts to the Umami API to create a website with `domain=slug.sites.<brand>.<tld>` and stores `umamiWebsiteId` on `sites.config.analytics.umami`.

Failures in steps 2–4 are non-fatal — the site row exists and is usable; operators can re-trigger via the per-tab actions.

### 2. Bind a templates library — two paths

#### Path A: starter library (instant, schema-driven)

Already done in step 1. The starter ships a hero+sections schema so the SchemaEditor renders something useful without a theme repo. Operators replace it with their own theme's schema via Path B.

#### Path B: connect an external git template

`Source tab → "Connect external repo"`:
1. Operator pastes HTTPS URL + PAT + branch + schema path (default `content/schema.json`).
2. Server `git clone --depth=1 --branch=<branch>` the upstream into a tmpdir.
3. Reads the schema file: `.json` is parsed directly; `.ts` / `.tsx` is transpiled via the `typescript` package and evaluated in a `node:vm` sandbox to extract the default export.
4. Computes `sha256` of the canonical schema, INSERTs `templates_content_schemas` (version = max+1, `is_current=true`).
5. Creates / updates the `templates_sources` row (kind='git') with the URL + branch + `installed_git_sha`.
6. PAT is stored encrypted in `sites_secrets` under `git_pat_<source_id>`.
7. **Force-pushes the cloned tree into the site's internal bare repo** — apply-theme drift checks now have a baseline.
8. Tmpdir is `rm -rf`'d in `finally`.

The Source tab then shows the connected source with `↻` (refresh) and `🔑` (rotate PAT) buttons:
- **Refresh** (`POST /admin/sites/:id/source/:sourceId/refresh-git`) re-clones using the stored PAT, ingests a new schema version (prior versions retained, `is_current=true` flips), force-pushes the fresh tree into internal.
- **Rotate PAT** overwrites the stored secret; the next refresh uses the new token.

### 3. Create a page

`Pages tab → "+ New Page"`. Fields: title (auto-fills slug + full_path), full path, library, composition mode (`schema` default — the schema-driven editor; `blocks` for legacy block-list rendering), homepage flag.

`POST /api/modules/sites/admin/pages` validates via `validateCreatePage`, inserts into `public.pages`, returns the row, the UI navigates to `/sites/:slug/pages/:pageId`.

### 4. Edit page content

`PageEditor` dispatches on `composition_mode`:
- **schema** → `<SchemaEditor>` reads `templates_content_schemas` for the route's library + version, renders typed inputs per field. Save → `POST /admin/sites/:siteSlug/content:batch` upserts a `pages_nextjs_drafts` row keyed on `(page_id, editor_id)`. Drafts are private until publish.
- **blocks** → falls back to the host theme's block-list editor (operator-supplied via `<HtmlBlockListEditor>` prop).

### 5. Run an A/B test on a page

`Experiments tab → "+ New experiment"`:
1. Pick a page, set name, define ≥2 variants with weights summing to 100%, set the goal event (e.g. `signup_clicked`).
2. INSERTs `templates_ab_tests` (`scope_kind='page'`, `scope_id=<page.id>`, `host_kind='site'`, `engine_id='builtin'`, `status='draft'`).
3. Per-variant content (optional but recommended) — for each variant click "Edit" and either use the SchemaEditor (matching the page's bound schema) or the JSON textarea fallback. Saves into `pages_content_variants` with `field_path='/'` and `match_context={ab_test_id, variant}`.
4. Click ▶ to flip status to `running`. The renderer picks up the test on next publish.

When a winner is clear, click **Promote** on a variant card:
- Copies that variant's content into `pages.content`.
- Sets `templates_ab_tests.status='concluded'` + `winner_variant=<key>` + `ended_at=now()`.
- Operator re-publishes to ship the new default.

#### What flows where at runtime

The publish-worker writes into the site's git repo:
- `content/pages/<slug>.json` — the default content.
- `content/pages/<slug>.<variant>.json` — one per variant with a `pages_content_variants` row.
- `public/_gatewaze/ab-bindings.json` — `{ '<full_path>': { testId, goalEvent } }` map for routes with running tests.
- `public/_gatewaze/site-config.json` — `{ apiOrigin, analytics, abBindingsUrl }`.
- `app/layout.tsx` (blocks-mode sites with a wrapper) — emits the analytics + A/B inline `<script>` server-side.

For schema-mode sites without a publish-worker-emitted layout (the common case — operator's theme owns its layout), they import `<GatewazeHead />` from `@gatewaze-modules/site-runtime` (see [site-runtime guide](../site-runtime/guide.md)).

The bootstrap script in either path:
1. Mints / reads a localStorage `gatewaze_ab_session` UUID.
2. Loads `/_gatewaze/ab-bindings.json`, looks up `pathname` for a binding.
3. POST `${apiOrigin}/api/ab/<testId>/assign` → returns sticky variant.
4. Sets `<body data-ab-variant="…" data-ab-test-id="…">`.
5. POST `/api/ab/<testId>/impression` once per page-load.
6. Fetches `/content/pages/<slug>.<variant>.json`, exposes content at `window.gatewazeAB.variantContent`.
7. Fires `CustomEvent('gatewaze:ab-ready', { detail: window.gatewazeAB })` for theme code to subscribe.
8. Exposes `window.gatewazeAB.recordConversion(goalEvent?)` — POST to `/api/ab/<testId>/conversion` (defaults to the test's configured `goalEvent`).

Operator theme code can choose to:
- React to `data-ab-variant` via CSS only (`body[data-ab-variant="b"] .hero { ... }`).
- Listen for `gatewaze:ab-ready` and re-render with `event.detail.variantContent`.
- Both.

### 6. Configure publishing target

`Publishing tab → Publishing target`:
- **External** (Cloudflare Pages or Netlify): pick the publisher, fill the schema-driven secrets form (API token, account id, project name), Test connection (validates form + low-impact ping), Save.
- **Portal**: served inline by this gatewaze instance. Default for the seeded Portal site; available for custom sites that the platform should host directly.

Secrets are encrypted server-side and stored in `sites_secrets`. Existing tokens aren't echoed back to the form on re-edit.

### 7. Publish

`Publishing tab → "Publish"` button (top-right of the Rollouts card). Behind the scenes:
1. Hits `POST /api/admin/sites/:id/publish` with `{ reason: 'admin-triggered' }`.
2. The republish-routes endpoint inserts a row into the publish queue, the publish-worker picks it up.
3. Worker calls `buildSiteContentFiles(siteId)` which:
   - SELECTs published pages.
   - For schema-mode pages: writes `content/pages/<slug>.json` with `pages.content`.
   - For blocks-mode pages: assembles `page_blocks` + `page_block_bricks` (joining to `templates_block_defs.key` and `templates_brick_defs.key`) into a structured `content/pages/<slug>.json` with the block list + nested bricks.
   - Writes per-variant `content/pages/<slug>.<variant>.json` for every running test.
   - Writes `public/_gatewaze/ab-bindings.json` and `public/_gatewaze/site-config.json`.
   - For sites with a wrapper, emits `app/layout.tsx` with the inline analytics + A/B bootstrap.
4. Worker calls `gitServer.publishCommit({ repo, branch: 'publish', files, message, tag, author })` — atomic write + commit + tag + push under a per-repo Postgres advisory lock.
5. Publisher (Cloudflare Pages / Netlify) builds + deploys via the operator's external repo flow, OR the portal serves directly.

The **Rollouts** card shows publish history (last 25 jobs) with status badges, deployment URLs, errors. Each succeeded job has a `↶` Rollback button → clones that job's `draft_content_snapshot` into a new queued job.

### 8. Roll back

`↶` on any succeeded job in the Rollouts list → `POST /admin/sites/:id/publish-jobs/:jobId/rollback` → INSERTs a new `sites_publish_jobs` row with the prior content snapshot. The publish-worker re-executes the same content path against the publisher; for git-driven publishers this means the prior commit gets re-applied to the publish branch as a NEW commit (forward-only history, no force-push).

### 9. Archive

Archive flow on the listing page: `POST /admin/sites/:id/archive`:
1. Sets `sites.status='archived'`.
2. Marks the internal repo for soft-delete (30-day retention; restore via a future Restore action within the window).
3. Calls `deleteWebsite` on the umami client to remove the Umami website if `umamiWebsiteId` is recorded.
4. Concludes any in-flight A/B tests (`status` ∈ `{draft, running, paused}` → `concluded` with `ended_at=now()`).

Templates libraries, page rows, and publish-job history are preserved (referenced by FKs).

## Composition modes

A page is either:

- **`composition_mode='schema'`** (default) — `pages.content` is a JSONB document conforming to the route's `templates_content_schemas` row. Renderer: schema-driven editor; published as `content/pages/<slug>.json` with `{ slug, full_path, title, content, schema_version }`.
- **`composition_mode='blocks'`** — page is composed from ordered `page_blocks` rows, each pointing at a `templates_block_defs` row by `block_def_id`. Optional `page_block_bricks` per block. Renderer: block-list editor (operator theme-supplied). Published as `content/pages/<slug>.json` with `{ slug, full_path, title, composition_mode: 'blocks', blocks: [...] }`.

Composition mode is immutable post-create. The DB enforces it via `trg_page_blocks_match_composition_mode` — INSERT into `page_blocks` for a `composition_mode='schema'` page raises `page_blocks_forbidden_for_schema_page`.

## Theme kinds

`templates_libraries.theme_kind`:
- **`website`** — schema-driven; consumed by sites. `templates_content_schemas` rows hold the JSON Schema; `pages.content` conforms.
- **`email`** — marker-grammar HTML; consumed by newsletters / events / calendars.

Sites are uniformly `theme_kind='website'`. The DB constraint `sites_theme_kind_check` enforces this. Provisioning a new site auto-creates a `theme_kind='website'` library.

## Internal vs external git provenance

Every site has an internal bare git repo (created at site creation). `git_provenance` is either:
- **`internal`** (default) — the platform's internal git server is the source of truth. Operators commit via the Source tab's git endpoint or via Connect-git import.
- **`external`** — the internal repo mirrors a fixed external git URL. Used after `graduate-git` (push internal → external) so the operator can manage the repo on GitHub etc.

Connect-git import populates the internal repo with the upstream's working tree. After import, drift checks (`/admin/sites/:id/drift`) compare main vs publish branches inside the internal repo.

## API reference

All admin endpoints require a JWT (platform's `requireJwt` middleware). Public endpoints are anonymous + rate-limited.

### Site lifecycle (admin)

| Verb | Path | Body | Notes |
|------|------|------|-------|
| POST | `/admin/sites/:siteId/internal-repo:ensure` | `{}` | Idempotently provisions the bare repo. |
| POST | `/admin/sites/:siteId/integrations:provision` | `{}` | Dispatches per-integration provisioning (Umami etc.). |
| POST | `/admin/sites/:siteId/archive` | `{}` | Cascading cleanup (repo + Umami + tests). |

### Pages (admin)

| Verb | Path | Body | Notes |
|------|------|------|-------|
| GET | `/admin/pages?host_kind=site&host_id=…` | — | List pages for a site. |
| POST | `/admin/pages` | `CreatePageInput` | Includes `composition_mode` ∈ `{schema, blocks}`. |
| PATCH | `/admin/pages/:pageId` | `UpdatePageInput` | Partial; mass-assignment-protected. |
| DELETE | `/admin/pages/:pageId` | — | Soft-delete (`status='archived'`). |
| POST | `/admin/pages/:pageId/preview-tokens` | `{}` | Mints cleartext token returned ONCE. |
| DELETE | `/admin/pages/:pageId/preview-tokens/:tokenId` | — | Revoke. |
| POST | `/admin/sites/:siteSlug/content:batch` | `{ drafts: [...] }` | Schema-mode draft save (`pages_nextjs_drafts`). |

### Publishing (admin)

| Verb | Path | Body | Notes |
|------|------|------|-------|
| POST | `/api/admin/sites/:siteId/publish` | `{ reason?, force? }` | Queues a publish job. |
| POST | `/admin/sites/:siteId/publish-jobs/:jobId/rollback` | `{}` | Clones snapshot to new queued job. |
| PUT | `/admin/sites/:siteId/secrets` | `{ key, values }` | Encrypted at rest. |
| POST | `/admin/sites/:siteId/publisher:validate` | `{ publisherId, values? }` | Static + live ping. |

### Source / git (admin)

| Verb | Path | Body | Notes |
|------|------|------|-------|
| GET | `/api/admin/sites/:id/drift` | — | Compare main vs publish. |
| POST | `/api/admin/sites/:id/apply-theme` | `{ fastTrack?, expectedHeadSha? }` | 200 clean, 409 conflicts. |
| POST | `/api/admin/sites/:id/apply-theme/resolve` | `{ resolutions: [...] }` | Per-conflict resolution. |
| POST | `/api/admin/sites/:id/graduate-git` | `{ git_url, pat }` | Promote internal → external. |
| POST | `/admin/sites/:siteId/source:import-git` | `{ git_url, pat, branch?, schema_path? }` | Clone + ingest schema + mirror to internal. |
| POST | `/admin/sites/:siteId/source/:sourceId/refresh-git` | `{ schema_path? }` | Re-clone with stored PAT, bump schema version. |

### A/B engine (public — anonymous, rate-limited 60 req/min per session key)

| Verb | Path | Body | Notes |
|------|------|------|-------|
| POST | `/api/ab/:testId/assign` | `{ sessionKey }` | Returns sticky `{ variant, sticky }`. |
| POST | `/api/ab/:testId/impression` | `{ sessionKey, variant, properties? }` | 204. |
| POST | `/api/ab/:testId/conversion` | `{ sessionKey, variant, goalEvent, properties? }` | 204. Goal must match test's configured goal_event. |

## Configuration

Module config (set under `gatewaze.config.yaml` or via the platform Settings UI):

| Key | Default | Notes |
|-----|---------|-------|
| `publisher_build_dir` | `/data/publisher-builds` | Container-visible PVC path for ephemeral build artifacts. |
| `sites_scratch_dir` | `/tmp/sites-scratch` | Per-request scratch space for renderer / preview. |
| `build_concurrency` | `2` | How many sites can build in parallel. |
| `build_timeout_ms` | `300000` | Per-build hard timeout. |
| `build_node_heap_mb` | `512` | `--max-old-space-size` for build subprocesses. |
| `egress_allowlist` | `''` | CSV of hostnames external publishers can reach. |

Environment variables (set in `<brand>.local.env` / `<brand>.production.env`):

| Var | Default | Notes |
|-----|---------|-------|
| `PUBLIC_API_ORIGIN` | falls back to `API_URL` | Where rendered sites POST A/B events. |
| `SITES_INTERNAL_GIT_ROOT` | `/var/gatewaze/git` | Bare repo PVC root. |
| `SITES_GIT_SIGNING_KEY` | random per restart | HMAC key for signed URLs. Set in production. |
| `SITES_BOILERPLATE_URL` | `https://github.com/gatewaze/gatewaze-template-site.git` | Cloned into the site's bare repo on creation. Override per brand. |
| `SITES_BOILERPLATE_TAG` | `main` | Pinned tag of the boilerplate. Bump after operators verify a new version. |
| `SITES_SKIP_BOILERPLATE` | `0` | Set to `1` to create empty bare repos (operators bring their own theme via Connect-git). |

## Boilerplates

Two starter repos ship with the platform:

| Repo | Purpose | Theme kind |
|------|---------|------------|
| `gatewaze-template-site` | Next.js site starter — content/schema.json, pages/[slug].json renderer, GatewazeHead integration. | `website` |
| `gatewaze-template-email` | HTML email starter — single source.html with WRAPPER + BLOCK + BRICK markers. | `email` |

When a site is created, gatewaze clones `gatewaze-template-site` at the configured tag as the initial commit of the site's bare internal repo. Operators iterate locally, push their changes, and the platform's drift / apply-theme flow tracks upstream changes.

Email theme repos are referenced as `templates_sources` (kind=`git`) on a newsletter / event / calendar collection. The templates parser walks the source.html marker grammar and ingests block / brick / wrapper definitions.

## Features

- `sites` — Core site management
- `sites.editor` — Page editor (schema + blocks)
- `sites.publishing.portal` — Portal-target publishing
- `sites.publishing.k8s` — k8s-internal target (deferred)

External publisher features are contributed by sub-modules (`sites.publishing.cloudflare-pages`, `sites.publishing.netlify`).

## Dependencies

- `templates` — schema authoring, A/B engine, content schemas, version pinning.

Optional integrations:
- `umami` — auto-provisions Umami websites on site creation; injects tracking script.
- `sites-publisher-cloudflare-pages` — Cloudflare Pages adapter.
- `sites-publisher-netlify` — Netlify adapter.

## Migrations

001–006: core tables, RLS, theme_kind discriminator.
007: Next.js path tables (`pages_nextjs_drafts`, `pages_content_variants`, `pages_content_versions`, `sites_publish_jobs`, `sites_webhook_seen`, `sites_runtime_api_keys`).
008–009: writes via admin, host registration.
010–011: theme_kind rename (`html→email`, `nextjs→website`), Portal seed.
012: per-page `composition_mode`.
