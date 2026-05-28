# Monitoring

Prometheus + Grafana observability for the platform cluster. The module ships the cluster-specific layer for the job-queue subsystem: PodMonitors that scrape the API, worker, and scheduler; alert rules; and Grafana dashboards. It is hidden and runs no database migrations — monitoring state lives in Prometheus and Grafana, not the platform Postgres.

## How It Works

The TypeScript manifest (`index.ts`) is intentionally thin: it declares two config values and a hidden admin nav item that links out to Grafana. The actual cluster install is a self-contained Helm sub-chart under `helm/`, deployed as its own release.

The sub-chart bundles `kube-prometheus-stack` (Prometheus Operator + Prometheus + Alertmanager + Grafana) as a dependency, rendered when `prometheusStack.enabled=true` (the default). Operators who already run a Prometheus Operator can set `prometheusStack.enabled=false`, in which case only the platform-specific resources render and attach to the existing operator (set `podMonitor.additionalLabels.release` to match its PodMonitor selector).

What the sub-chart installs:

1. **PodMonitors** that scrape `/metrics` on the worker (port 9090) and scheduler (port 9091); the API exposes metrics on its main service port (3002). Metric ports are configurable under `gatewaze.metricsPorts`.
2. **A PrometheusRule** with alert thresholds for the queue layer: queue backlog, queue stuck (waiting jobs with no progress), terminal failure rate, email-send failures (zero tolerance), job-duration p99 over target, and Redis health. Thresholds are tunable under `alerts.thresholds.*`.
3. **Grafana dashboards** shipped as ConfigMaps labelled `grafana_dashboard: "1"` so Grafana's sidecar auto-imports them:
   - **Queue overview** — depth per queue/state, enqueue rate, p50/p95/p99 duration per (queue, name), Redis health.
   - **Job failures** — terminal failure rate per (queue, name, module), attempt distribution, recent failures.

Installation is operator-driven via Helm; `helm/README.md` documents the steps. The module's `onInstall` hook prints the same install commands as a reminder. Because the admin nav item's path is a full URL, clicking it opens the configured Grafana in a new tab — there are no in-app admin routes.

## Configuration

| Variable | Type | Required | Description |
|---|---|---|---|
| `GRAFANA_URL` | string | No | Public URL of the Grafana instance, used by the admin nav link. Leave unset to hide the nav item. |
| `PROMETHEUS_URL` | string | No | In-cluster Prometheus server URL. Currently informational; reserved for future in-admin metric features. |

The Helm sub-chart is configured separately via `helm/values.yaml`. Key knobs include `prometheusStack.enabled`, `gatewaze.namespace`, `gatewaze.metricsPorts`, `podMonitor.interval`/`additionalLabels`, the `alerts.*` thresholds and severity labels, and `dashboards.enabled`. Set the Grafana admin password at install time (`kube-prometheus-stack.grafana.adminPassword`); it is intentionally not committed as a default.

## Features

- `monitoring` — Prometheus + Grafana stack with PodMonitors, alert rules, and queue-layer dashboards.

## Dependencies

None declared. The module observes the platform's queue subsystem (API, worker, scheduler) by scraping their metrics endpoints, but declares no module dependency.
