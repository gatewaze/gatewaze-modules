import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'bigquery-integration',
  name: 'BigQuery',
  description:
    'Google BigQuery integration for analytics queries, materialized views, and data warehouse operations',
  version: '1.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'integration',
  features: ['bigquery', 'bigquery.proxy'],
  edgeFunctions: ['integrations-bigquery-proxy'],
  configSchema: {},
  onInstall: async () => {
    console.log('[bigquery-integration] Module installed');
  },
  onEnable: async () => {
    console.log('[bigquery-integration] Module enabled');
  },
  onDisable: async () => {
    console.log('[bigquery-integration] Module disabled');
  },
};

export default module;
