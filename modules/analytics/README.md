# Analytics module

First-party analytics + tracking-script pipeline for Gatewaze. Per
[`spec-analytics-module.md`](../../../gatewaze-environments/specs/spec-analytics-module.md).

## What it gives you

- **Self-hosted Umami** running against your existing platform Postgres —
  no third-party SaaS, no PII leaving the cluster.
- **Property-based tenancy** — one `tracking_property` per Gatewaze site,
  the portal, and any external sites you register.
- **Gatewaze-native admin dashboards** — pageviews, top pages, referrers,
  custom events, A/B variant breakdowns. No iframes to a third party.
- **Generalised tracking-script slots** — per-property `script_head` /
  `script_body` blobs (Segment, GTM, Hotjar, etc.) with the same
  no-sanitisation contract as the portal's existing
  `platform_settings.tracking_head`/`tracking_body` keys.
- **First-class Segment integration** — supply a write key per property
  and the embed snippet generator does the rest.

## How it embeds

| Host | How |
|---|---|
| `sites` module pages | Automatic — the renderer injects the snippet for the page's resolved property |
| Portal | Opt-in via brand config; existing `platform_settings.tracking_head/body` continues to work |
| External sites | Manual copy-paste of a `<script>` tag the admin generates |

## Deployment

The module ships a Helm sub-chart at [`helm/`](./helm/) that deploys:

- 1 × Umami `Deployment` (single replica per spec §10.1)
- 1 × `Service` (ClusterIP — Umami's admin UI is not publicly exposed)
- 1 × pre-install `Job` that runs `CREATE DATABASE gatewaze_umami` +
  `CREATE ROLE gatewaze_umami_role` against the existing platform
  Postgres using a service-role connection
- 1 × `ConfigMap` for Umami env
- 1 × daily `CronJob` that prunes `event` + `event_data` rows older than
  `retention.days` (default 395 = 13 months)
- 0 × `Ingress` — no public access to Umami's admin UI

```sh
helm install analytics premium-gatewaze-modules/modules/analytics/helm \
  --set umami.appSecret=$(openssl rand -hex 32)
```

## Local dev

The platform's top-level `docker-compose.yml` adds a `umami` service
reachable at `analytics.gatewaze.localhost:3000`. The portal proxies
`/a/*` and `/api/analytics/*` to it.

## Backend swap

All consumers go through `analyticsService` ([src/service/contract.ts](./src/service/contract.ts)).
Swapping Umami → ClickHouse / Tinybird in v2 is one file:
[src/service/umami.ts](./src/service/umami.ts) replaced with a
ClickHouse implementation that returns the same contract. No call sites
change.

## Module manifest

See [index.ts](./index.ts).

## Migrations

| File | Purpose |
|---|---|
| `00001_analytics_schema.sql` | Creates the `analytics` schema + `can_read_analytics_property` / `can_admin_analytics_property` helpers |
| `00002_properties.sql` | `analytics_properties`, `analytics_secrets`, `analytics_custom_events` |
| `00003_tracking_scripts.sql` | `analytics_tracking_scripts` (per-property head/body blobs) |
| `00004_provisioning_jobs.sql` | `analytics_provisioning_jobs`, `analytics_query_cache`, `analytics_share_tokens` |

Umami's own schema is bootstrapped by the Helm pre-install Job, not by
these migrations.
