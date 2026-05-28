# Monitoring module

Adds Prometheus + Grafana to the cluster and ships the Gatewaze-specific
observability layer (PodMonitors, alert rules, dashboards) for the queue
layer described in `spec-job-queue-redis-architecture.md`.

## What it installs

1. **Prometheus Operator + Prometheus + Alertmanager + Grafana** via the
   `kube-prometheus-stack` Helm chart (vendored as a dependency). Default
   on; disable with `prometheusStack.enabled=false` if you already run a
   Prometheus Operator install elsewhere.
2. **PodMonitors** that scrape `/metrics` on the Gatewaze worker (port
   9090) and scheduler (port 9091). The Gatewaze API exposes its metrics
   on `/metrics` of the main service port — also scraped.
3. **PrometheusRule** with the alert thresholds from
   `spec-job-queue-redis-architecture.md §11.4`:
   - Queue backlog
   - Queue stuck (no progress + non-zero waiting)
   - Terminal failure rate
   - Email failures (zero-tolerance)
   - Job duration p99 above target
   - Redis health
4. **Grafana dashboards** as ConfigMaps with the `grafana_dashboard: "1"`
   label so Grafana's sidecar auto-imports them:
   - **Queue overview** — depth per queue/state, enqueue rate, p50/p95/p99
     duration per (queue, name), Redis health.
   - **Job failures** — terminal failure rate per (queue, name, module),
     attempt distribution, recent failures.

## Install

```sh
# 1. Pull the kube-prometheus-stack dependency
helm dependency update premium-gatewaze-modules/modules/monitoring/helm

# 2. Install (creates the `monitoring` namespace if needed)
helm install gatewaze-monitoring premium-gatewaze-modules/modules/monitoring/helm \
  --namespace monitoring --create-namespace \
  --set kube-prometheus-stack.grafana.adminPassword=<choose-one>

# 3. Get the Grafana URL (port-forward for first-time access)
kubectl -n monitoring port-forward svc/gatewaze-monitoring-grafana 3000:80

# 4. Wire it up: set GRAFANA_URL on the monitoring module so the admin
#    nav item links to your Grafana instance.
```

For an existing Prometheus Operator install, skip the `kube-prometheus-stack`
dependency:

```sh
helm install gatewaze-monitoring premium-gatewaze-modules/modules/monitoring/helm \
  --namespace monitoring --create-namespace \
  --set prometheusStack.enabled=false \
  --set podMonitor.additionalLabels.release=<your-prometheus-release>
```

`additionalLabels.release` must match your Prometheus Operator's PodMonitor
selector (default for kube-prometheus-stack is `release: <release-name>`).

## What you get out of the box

After install, Grafana has the two Gatewaze dashboards under the
`Gatewaze` folder. Alertmanager fires the rules above with default
severities. Modify routing in your existing Alertmanager config or via
the `kube-prometheus-stack.alertmanager.config` block.

## Tuning

| Knob | Default | What it does |
|---|---|---|
| `prometheusStack.enabled` | `true` | Install kube-prometheus-stack as a sub-chart |
| `gatewaze.namespace` | `gatewaze` | Namespace where the Gatewaze pods run (PodMonitor selector scope) |
| `podMonitor.interval` | `30s` | Scrape interval |
| `podMonitor.additionalLabels` | `{}` | Extra labels for PodMonitors (set `release: <prom-release>` if needed) |
| `alerts.severity.warning/critical` | `warning`/`critical` | Severity labels stamped on rules |
| `alerts.thresholds.*` | per spec §11.4 | Override individual alert thresholds |
| `dashboards.enabled` | `true` | Render the Grafana dashboard ConfigMaps |

See `helm/values.yaml` for the full list.
