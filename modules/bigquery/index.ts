import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'bigquery',
  name: 'BigQuery',
  description:
    'Google BigQuery integration for analytics queries, materialized views, and data warehouse operations',
  version: '1.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'integrations',
  features: ['bigquery', 'bigquery.proxy'],
  // integrations-bigquery-proxy removed: it authenticated solely via the
  // legacy GW_API_BEARER secret, which is set in no environment, so the proxy
  // rejected every request. This module is now vestigial — a candidate for
  // full removal once confirmed no environment intends to restore the proxy.
  edgeFunctions: [],
  configSchema: {},
  onInstall: async () => {
    console.log('[bigquery] Module installed');
  },
  onEnable: async () => {
    console.log('[bigquery] Module enabled');
  },
  onDisable: async () => {
    console.log('[bigquery] Module disabled');
  },
};

export default module;
