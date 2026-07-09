# Redirect Adapter: Umami Links

Self-hosted short links backed by the analytics module's Umami instance —
a drop-in alternative to the Short.io/Bitly adapters with no external
provider, quota, or cost.

## How it works

- Short links live on the PORTAL (or site) host: `https://<domain>/go/<slug>`.
  Slugs are scoped per domain — the backing Umami link uses the internal slug
  `<domain>--<slug>`, so the portal and every sites-module site get
  independent slug spaces served by one route.
- `POST /api/redirects/create-bulk` (platform API, JWT-gated) mints one
  Umami link per URL, upserts a row in `public.redirects`
  (`provider = 'umami'`), and returns the `https://<domain>/go/<slug>`
  short URLs. `domain` defaults to `PORTAL_HOST`.
- The portal's `GET /go/:slug` route resolves host + slug → internal slug and
  relays through the analytics module's public `GET /a/q/:slug` proxy, which
  forwards the real client IP + User-Agent so click sessions get correct
  geo/device attribution. Umami itself stays cluster-internal.
- The analytics admin's per-property **Links** tab lists a property's links
  (matched by its domains) with 90-day click counts, plus create/delete.
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
