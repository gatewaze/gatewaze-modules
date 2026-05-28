import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Monitoring module.
 *
 * Adds Prometheus + Grafana to the cluster (via the bundled Helm sub-chart
 * at `helm/`) and ships the Gatewaze-specific observability layer:
 * PodMonitors for the api/worker/scheduler, PrometheusRules matching the
 * alert thresholds in spec-job-queue-redis-architecture §11.4, and
 * Grafana dashboards for queue depth, job duration, and terminal failure
 * rate.
 *
 * Architecture (mirrors the precedent set by `prefect-worker`):
 *   - This TypeScript manifest only declares config + a hidden admin nav
 *     item that links to Grafana.
 *   - The actual cluster install lives under `helm/` and is deployed as a
 *     standalone Helm release. See `helm/README.md` for install steps.
 *   - The sub-chart depends on `kube-prometheus-stack` (rendered when
 *     `prometheusStack.enabled=true`, default). Operators with an existing
 *     Prometheus Operator install can set `prometheusStack.enabled=false`
 *     and only the Gatewaze-specific resources (PodMonitors, rules,
 *     dashboards) render.
 *
 * No DB migrations — monitoring state lives in Prometheus and Grafana, not
 * the Gatewaze Postgres.
 */
const monitoringModule: GatewazeModule = {
  id: 'monitoring',
  group: 'analytics',
  type: 'integration',
  visibility: 'hidden',
  name: 'Monitoring',
  description:
    'Prometheus + Grafana stack for the Gatewaze cluster. Ships PodMonitors, alert rules, and dashboards for the queue layer (workers, scheduler, API).',
  version: '0.1.0',

  features: ['monitoring'],

  configSchema: {
    GRAFANA_URL: {
      key: 'GRAFANA_URL',
      type: 'string',
      required: false,
      description:
        'Public URL of the Grafana instance (used by the admin nav link). Typically https://grafana.<your-domain>. Leave unset to hide the nav item.',
    },
    PROMETHEUS_URL: {
      key: 'PROMETHEUS_URL',
      type: 'string',
      required: false,
      description:
        'In-cluster URL of the Prometheus server (e.g. http://gatewaze-monitoring-prometheus.monitoring.svc:9090). Currently informational; reserved for future API features that surface metrics inside the admin UI.',
    },
  },

  adminNavItems: [
    {
      path: 'monitoring',
      label: 'Monitoring',
      icon: 'Activity',
      requiredFeature: 'monitoring',
      parentGroup: 'admin',
      order: 90,
    },
  ],

  // No adminRoutes — clicking the nav item opens GRAFANA_URL in a new tab.
  // The admin UI shell is responsible for treating items whose path is a
  // full URL as external links.

  onInstall: async () => {
    console.log(
      '[monitoring] Module installed. Deploy the Helm sub-chart to install the Prometheus stack:',
    );
    console.log(
      '[monitoring]   helm dependency update premium-gatewaze-modules/modules/monitoring/helm',
    );
    console.log(
      '[monitoring]   helm install gatewaze-monitoring premium-gatewaze-modules/modules/monitoring/helm \\',
    );
    console.log('[monitoring]     --namespace monitoring --create-namespace');
    console.log(
      '[monitoring] Then set GRAFANA_URL on this module so the admin nav item links to your Grafana.',
    );
  },

  onEnable: async () => {
    console.log('[monitoring] Module enabled');
  },

  onDisable: async () => {
    console.log(
      '[monitoring] Module disabled — uninstall the Helm release with `helm uninstall gatewaze-monitoring -n monitoring` if you want to remove the cluster resources.',
    );
  },
};

export default monitoringModule;
