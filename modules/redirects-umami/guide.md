# Redirect Adapter: Umami Links

Self-hosted short links backed by the analytics module's Umami instance —
a drop-in alternative to the Short.io/Bitly adapters with no external
provider, quota, or cost.

## How it works

- `POST /api/redirects/create-bulk` (platform API, JWT-gated) mints one
  Umami link per URL (`POST /api/links` with the requested slug), upserts a
  row in `public.redirects` (`provider = 'umami'`), and returns short URLs
  of the form `https://<api-host>/a/q/<slug>`.
- The analytics module serves `GET /a/q/:slug` publicly, proxying Umami's
  `/q/{slug}` redirect with the real client IP + User-Agent forwarded so
  click sessions get correct geo/device attribution. Umami itself stays
  cluster-internal.
- Clicks are ordinary Umami events keyed by the link id — per-link stats
  are available via the standard `/api/websites/{linkId}/stats` surface.

## Requirements

- The `analytics` module deployed with its Umami instance, and
  `UMAMI_BASE_URL` / `UMAMI_USERNAME` / `UMAMI_PASSWORD` set on the API.
- Optional `REDIRECT_PUBLIC_BASE_URL` when the API's public origin can't be
  derived from request headers.

## Provider selection

Newsletter template settings → Link Redirect Provider → "Umami
(self-hosted)". When no provider is stored on a template, create-bulk
defaults to Umami whenever `UMAMI_PASSWORD` is configured.

## Notes

- Umami caps link URLs at 500 chars — heavily UTM-tagged destinations may
  need trimming.
- Umami caches slugs (24h with Redis) — editing a link's destination after
  send propagates slowly.
- Umami click counts have no bot filtering; treat them as directional.
