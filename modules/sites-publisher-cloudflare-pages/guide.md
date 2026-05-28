# Sites Publisher: Cloudflare Pages

External publisher adapter that deploys sites built by the `sites` module to Cloudflare Pages. It implements the `IExternalPublisher` interface and is mounted by the platform's publisher loader when a site's publishing target selects this publisher. This is a premium integration.

## How It Works

The module is a manifest plus an adapter. The platform's publisher loader imports the adapter (`CloudflarePagesPublisher`) at dispatch time — not into the admin UI bundle — and calls its lifecycle methods. Per the sites-module contract, the adapter never reads environment variables: all credentials arrive via the `secrets` argument, and the injected `fetch` lets the platform wrap calls with telemetry, timeouts, and retries.

The request shapers in `lib/api/` are pure functions that build the URL, method, headers, and body for each Cloudflare API v4 call; the adapter composes them with the injected transport and unwraps the v4 response envelope.

### Deploy flow (direct-upload manifest)

1. The renderer has already written the built files into the artifact directory; `prepareArtifact` is a no-op that just echoes the file manifest.
2. `deploy` creates a Pages deployment, sending the artifact's file manifest (each entry's relative path, SHA-256 hash, and size) as the deployment manifest. Cloudflare replies with an upload JWT and the set of file hashes it does not yet have.
3. The adapter uploads only the missing files, serially (to avoid bursting Cloudflare's upload host), each with a content type derived from its extension.
4. It returns the deployment's public URL, deploy id, and CDN aliases.

Previews use the same flow against a non-production branch named after the page, yielding a unique `<branch>.<project>.pages.dev` URL. Preview cleanup is delegated to the platform sweeper.

### Domains and cache

- `addDomain` / `getDomainStatus` / `removeDomain` manage custom domains via the Pages domains API and return DNS instructions; Cloudflare statuses map to the platform's domain states (`verified`, `pending_verification`, `misconfigured`, `pending_dns`).
- `invalidateCache` purges by path, but only if a `zoneId` is configured (it requires Zone cache-purge permission). Paths are batched at 30 per call. Without a zone, purge is skipped and the platform's TTL fallback handles eventual consistency.
- `syncMedia` returns `inline-in-artifact` — Cloudflare Pages publishes media through the deploy manifest, so there is no separate CDN bucket to sync.

## Configuration

This publisher has no module config or environment variables. Credentials are supplied per-site as a secrets bundle through the sites admin publishing tab (rendered from the module's exported JSON schema; runtime validation lives in `lib/api/secrets.ts`):

| Secret | Required | Description |
|---|---|---|
| `apiToken` | Yes | Cloudflare API token with `Pages:Edit` (and `Zone:Cache Purge` if `zoneId` is set). Stored masked. Minimum length 20. |
| `accountId` | Yes | Cloudflare account id (32 hex chars). |
| `projectName` | Yes | The Pages project slug (created in the Cloudflare dashboard). |
| `zoneId` | No | Required only for cache purge (32 hex chars). |
| `productionBranch` | No | Production branch name; defaults to `main`. |

## Features

- `sites.publishing.cloudflare-pages` — Cloudflare Pages publishing target for the sites module.

## Dependencies

- `sites` — Provides the `IExternalPublisher` interface, build artifacts, and the publisher loader that mounts this adapter.
