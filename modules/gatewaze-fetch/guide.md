# Web Fetch

External-facing web fetch and content extraction. It lets external AI agents fetch URLs over REST or MCP using a platform API key, wrapping the internal fetch backend in a per-tenant surface with quotas, domain governance, robots.txt enforcement, audit logging, and an append-only billing ledger. The module is hidden and disabled by default; operators enable it per environment.

## How It Works

Every request is authenticated by a platform API key whose scopes gate what it can do. The REST surface mounts under `/api/v1/fetch` and the MCP surface exposes the same capability as tools (`fetch_url`, `extract_content`, `screenshot`, `get_quota`). Both ultimately call the same internal fetch backend; the module never exposes that backend's shared token to callers.

### Request pipeline (`publicApi.ts`)

`POST /api/v1/fetch` runs a fixed sequence of checks before and after the upstream call:

1. **Validation** — zod schema for `url`, `mode`, `extract[]`, `timeout_ms`, `screenshot`, `user_agent` (anti-spoofing: printable ASCII, no well-known crawler identifiers), and `response_storage`.
2. **Scope mapping** — `stealth`/`browser`/`screenshot`/`extract`/`ignore-robots` each require their own scope on the key.
3. **URL parse + normalize** — lowercased, Punycoded host (`lib/normalize.ts`).
4. **Circuit breaker** — if the upstream is unhealthy, returns `503` with `Retry-After` (`lib/circuitBreaker.ts`).
5. **Idempotency** — an `Idempotency-Key` header within the TTL window replays the prior response without re-billing (`lib/idempotency.ts`).
6. **Domain governance** — instance and per-key allow/deny lists are evaluated against the requested host (`lib/domains.ts`).
7. **robots.txt** — unless `ignore_robots` (and the scope) is set, robots.txt is fetched through the same backend and cached (`lib/robots.ts`, `fetch.robots_cache`).
8. **Debit + audit-start** — quota is debited, a ledger debit row and an audit row are written in one step (`lib/db.ts`, `lib/ledger.ts`).
9. **Upstream fetch** — the backend renders/scrapes the page; success/failure feeds the circuit breaker.
10. **Reconcile** — actual browser-seconds and proxy-bytes are reconciled against the reservation in the ledger.
11. **Post-fetch governance** — the final URL host (after redirects) is re-checked against the deny lists.
12. **Content-type check + extraction** — text extraction runs only on allowed content types; `lib/extract.ts` produces markdown / metadata / links / JSON-LD / Next data.
13. **Finalize + respond** — the audit row is finalized; the response envelope includes `data`, `billing` deltas, and any `warnings`.

Refunds are issued automatically when an upstream call is retryable, the media type is unsupported, or the final URL is blocked.

### Endpoints

| Endpoint | Scope | Notes |
|---|---|---|
| `POST /api/v1/fetch` | `read` | Core fetch. `mode: fast` default; `stealth`/`browser` and `screenshot` need extra scopes. |
| `POST /api/v1/fetch/screenshot` | `screenshot` | Convenience wrapper; forces `mode: browser` and reshapes into the canonical fetch body. |
| `GET /api/v1/fetch/quota` | `read` | Current monthly quota state (requests, browser-minutes, proxy-GB) and per-minute rate cap. |
| `GET /api/v1/fetch/audit` | `read` | Tenant-scoped audit log; filterable by host, mode, blocked-reason, error class, and time range. |

MCP tool output is truncated at 256 KiB; agents are directed to the REST endpoint with `response_storage: signed_url` for larger payloads.

### Data model (`fetch` schema)

| Table | Purpose |
|---|---|
| `fetch.quotas` | Fast per-key monthly counter used for rate-limit decisions. |
| `fetch.instance_domain_rules` / `fetch.key_domain_rules` | Allow/deny patterns at instance and per-key scope. A monotonic `domain_rules_version` feeds the idempotency cache key so rule changes invalidate cached responses. The instance denylist is seeded with loopback, link-local, mDNS, and cloud-metadata hosts. |
| `fetch.audit_log` | One row per request with blocked-reason, stage, byte/timing counters, and error class. |
| `fetch.robots_cache` | Parsed robots.txt per origin with a configurable TTL. |
| `fetch.usage_ledger` | Append-only billing source of truth (`debit` / `reconcile` / `refund` / `adjustment`). Update/delete are revoked from app roles; `(request_id, kind)` is unique to prevent double-refunds. |

## Configuration

Required environment variables (read at boot — the module throws if missing):

| Variable | Purpose |
|---|---|
| `GATEWAZE_FETCH_BACKEND_URL` | URL of the internal fetch backend service. |
| `SCRAPLING_INTERNAL_TOKEN` | Shared token for authenticating to that backend. |
| `GATEWAZE_INSTANCE_HOST` | Host (no scheme) substituted into the robots-fetch user-agent template. Defaults to `localhost`. |

MCP-only environment variables:

| Variable | Purpose |
|---|---|
| `GATEWAZE_FETCH_API_KEY` | API key used by the stdio MCP server (read once at boot). HTTP MCP instead reads the per-request `X-Gatewaze-Fetch-Key` header. |
| `GATEWAZE_API_PUBLIC_BASE_URL` / `GATEWAZE_API_BASE_URL` | Public base URL the MCP tools call; defaults to `http://localhost:3000`. |

Operator-tunable settings (exposed in the module settings form; richer settings such as domain lists, cost rates, and storage buckets are read from `moduleConfig` JSON with the defaults in `lib/settings.ts`):

| Setting | Default | Description |
|---|---|---|
| `default_quota_requests_per_month` | `10000` | Default monthly request limit per key. |
| `default_quota_browser_minutes_per_month` | `60` | Default monthly browser-mode minutes per key. |
| `default_quota_proxy_gb_per_month` | `5` | Default monthly proxy bandwidth per key (decimal GB). |
| `robots_cache_ttl_hours` | `24` | How long parsed robots.txt is cached. |
| `robots_strict_on_5xx` | `false` | Deny fetches when robots.txt returns 5xx. |
| `idempotency_ttl_seconds` | `300` | Idempotency-Key replay window. |

## Features

- `gatewaze-fetch` — The external fetch surface. Disabled by default; enabled per environment by operators.

Public API scopes: `read`, `stealth`, `browser`, `screenshot`, `extract`, `ignore-robots`.

## Dependencies

None declared. The module relies on the platform's API-keys infrastructure, which the module loader treats as a platform prerequisite (no explicit module dependency entry).
