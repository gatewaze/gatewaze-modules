# Host Media

Shared media management for content-bearing modules. Host Media owns one polymorphic `host_media` table plus the API, admin tab, and upload pipeline (image variants, YouTube delegation, ZIP unpack, chunked upload), reference tracking, and per-host storage quotas. Consumer modules (sites, events, newsletters, blog, podcasts) opt in via a registry block rather than each shipping their own media stack.

## How It Works

All media for every host kind lives in one polymorphic table, keyed by `(host_kind, host_id)`.

**`host_media`** stores the file (`storage_path`, `filename`, `mime_type`, `bytes`, `width`, `height`), pre-computed responsive `variants` (JSONB), an `access_level` (`public` / `authenticated` / `signed`), a `used_in` JSONB array of references back into content rows, optional album membership (`album_id`), sponsor tagging (`sponsor_id`), and a full set of YouTube columns (`youtube_video_id`, upload status, retry bookkeeping). There is intentionally **no CHECK constraint on `host_kind`** — RLS dispatch is the source of truth, so adding a new host kind never requires a migration here.

**`host_media_albums`** (and item links) group media into albums for hosts whose registry entry sets `enableAlbums: true`.

**`host_media_zip_uploads`** tracks ZIP unpack jobs; the ZIP edge function walks the archive, emitting `host_media` rows (and album items) as it goes, while the admin tab polls this table for progress.

**`host_media_chunked_uploads`** tracks in-flight chunked-upload sessions for large files: `chunked-init` creates a row, `chunked-commit` combines the parts, and the cleanup cron reaps expired sessions.

**`host_media_quotas`** holds per-host storage caps (total bytes, per-file CDN/repo caps, repo-dir cap). Uploads run a pre-flight `host_media_quota_check(...)` and decrement on failure.

### The consumer registry

Consumer modules call `registerHostMediaConsumer(...)` (from `lib/registry.ts`) at module-load / `onEnable` time, declaring which per-kind features are enabled:

```typescript
registerHostMediaConsumer({
  hostKind: 'event',
  enableAlbums: true,
  enableSponsorTagging: true,
  enableYouTube: true,
  enableZipUnpack: true,
  contentTables: [ /* tables whose content references media, walked by used-in rebuild */ ],
});
```

The API and the admin `HostMediaTab` read this registry at request time to enable or disable features per kind. Host Media does not own a top-level admin nav entry; the tab is exposed as the `host-media:tab` admin slot and mounted inside each consumer's detail page.

### Permissions (RLS dispatch)

A single dispatch function `can_admin_host_media(host_kind, host_id)` branches on `host_kind` and delegates to the consumer module's own predicate (`can_admin_site`, `can_admin_newsletter`, `can_admin_event`, ...). Unknown kinds return `false`, so RLS denies all operations. Reads delegate to `templates.can_read_host(...)`.

### API routes

All routes mount under `/api/admin/:hostKind/:hostId/...` and require a JWT (`requireJwt()` applied to the router):

- `GET|POST /media`, `GET|PATCH|DELETE /media/:id`, `GET /media/:id/contents`, `POST /media/:id/signed-url`
- `GET|POST /albums`, `PATCH|DELETE /albums/:id`, `POST /albums/:id/items`, `DELETE /albums/:id/items/:mediaId`
- `POST /media/chunked-init`, `POST /media/chunked-commit/:uploadId`

The default media adapter writes to Supabase Storage. Uploads pass through a multer multipart parser scoped to the upload route only.

### Background workers and crons

| Worker | Schedule | Purpose |
|---|---|---|
| `host-media:used-in-rebuild` | nightly (`0 3 * * *`) | Rebuild `used_in` from scratch as a guard against trigger drift |
| `host-media:youtube-poll` | every 5 min | Reconcile pending/failed YouTube uploads |
| `host-media:chunked-cleanup` | hourly | Reap expired chunked-upload sessions |

The `used_in` array is normally kept current by per-consumer triggers calling `host_media_sync_refs()`; the nightly rebuild is belt-and-braces.

## Configuration

This module has no `configSchema`. Behavior is driven by the consumer registry. Two environment variables affect storage:

| Variable | Default | Purpose |
|---|---|---|
| `HOST_MEDIA_BUCKET` | `media` | Storage bucket override; new deployments should leave it unset (single `media` bucket per instance). |
| `SUPABASE_PUBLIC_URL` | falls back to `SUPABASE_URL` | External hostname used to build browser-resolvable CDN URLs (the internal `SUPABASE_URL` may be a Docker hostname the browser cannot resolve). |

Per-host quotas default to 1 GB total, 5 MB per CDN file, 2 MB per in-repo file, and 200 MB per repo dir; they are editable per host in the `host_media_quotas` table.

## Features

- `host-media` — Core polymorphic media table, API routes, admin tab, and the Supabase Storage upload pipeline with Sharp-generated variants.
- `host-media.albums` — Album grouping for hosts that enable it.
- `host-media.youtube` — Delegated YouTube upload with poll-based status reconciliation.
- `host-media.zip-unpack` — Bulk ZIP archive ingest, exploded into individual media rows.
- `host-media.chunked-upload` — Chunked upload sessions for large files, combined on commit.

## Dependencies

None. Host Media declares no hard module dependencies. It has a soft dependency on each consumer module's permission predicate (e.g. `can_admin_event`, `can_admin_site`), which the RLS dispatch function calls when present; unknown host kinds simply default-deny.
