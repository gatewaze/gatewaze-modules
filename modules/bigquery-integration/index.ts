import type { GatewazeModule } from '@gatewaze/shared/modules';

const module: GatewazeModule = {
  id: 'bigquery-integration',
  name: 'BigQuery',
  description:
    'Google BigQuery integration for analytics queries, materialized views, and data warehouse operations',
  version: '1.0.0',
  type: 'integration',
  group: 'integration',
  features: ['bigquery', 'bigquery.proxy'],
  edgeFunctions: ['integrations-bigquery-proxy'],
};

export default module;
