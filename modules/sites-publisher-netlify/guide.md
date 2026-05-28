# Sites Publisher: Netlify

External publisher adapter that deploys sites built by the `sites` module to Netlify. It implements the `IExternalPublisher` interface and is mounted by the platform's publisher loader when a site's publishing target selects this publisher. This is a premium integration.

## How It Works

The module is a manifest plus an adapter. The platform's publisher loader imports the adapter (`NetlifyPublisher`) at dispatch time — not into the admin UI bundle — and calls its lifecycle methods. Per the sites-module contract, the adapter never reads environment variables: all credentials arrive via the `secrets` argument, and `fetch` is injected so the platform can wrap calls with telemetry, timeouts, and retries. The request shapers in `lib/api/` are pure functions; the adapter composes them with the injected transport.

### Deploy flow (SHA-1 digest mode)

Netlify uses SHA-1 for content addressing, while the platform's artifact manifest uses SHA-256 for delta computation. To avoid storing two digests per file, the adapter re-hashes at deploy time (`lib/api/sha1-manifest.ts`, using Web Crypto so it bundles for both Node and browser builds):

1. `prepareArtifact` is a no-op that echoes the file manifest (the renderer has already written the files).
2. `deploy` reads each file's bytes, computes a SHA-1 manifest, and POSTs it to create a deploy. Netlify replies with a `required` list of the SHA-1s it does not already have.
3. The adapter uploads only the required files, then returns the deploy's public URL (preferring the SSL URL), deploy id, and duration.

Previews use the same flow with `draft: true`, yielding a unique draft deploy URL that is not promoted to production. Netlify auto-prunes draft deploys via its retention policy, so the platform sweeper does not clean them.

### Domains and cache

- `addDomain` reads the current site, then either sets `custom_domain` (if unset) or appends to `domain_aliases`, swapping them atomically via a site update. It then eagerly triggers Let's Encrypt SSL provisioning (idempotent) and returns DNS instructions.
- `getDomainStatus` reports `verified` / `pending_verification` / `misconfigured` based on the attached domain's SSL state.
- `removeDomain` clears `custom_domain` or drops the alias.
- `invalidateCache` is best-effort: Netlify has no granular per-path purge, so the adapter triggers a no-op build to nudge the edge cache.
- `syncMedia` returns `inline-in-artifact` — Netlify publishes media through the deploy API, so there is no separate CDN bucket to sync.

## Configuration

This publisher has no module config or environment variables. Credentials are supplied per-site as a secrets bundle through the sites admin publishing tab (rendered from the module's exported JSON schema; runtime validation lives in `lib/api/secrets.ts`):

| Secret | Required | Description |
|---|---|---|
| `apiToken` | Yes | Netlify personal access token with deploy and domains scopes. Stored masked. Minimum length 20. |
| `siteId` | Yes | Netlify site id (UUID or 24 hex chars). Found in Site configuration → Site information. |
| `teamSlug` | No | Used by team-level cleanup APIs. |

## Features

- `sites.publishing.netlify` — Netlify publishing target for the sites module.

## Dependencies

- `sites` — Provides the `IExternalPublisher` interface, build artifacts, and the publisher loader that mounts this adapter.
