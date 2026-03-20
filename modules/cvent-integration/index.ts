import type { GatewazeModule } from '@gatewaze/shared/modules';

const module: GatewazeModule = {
  id: 'cvent-integration',
  name: 'Cvent',
  description:
    'Cvent event platform integration for syncing registrations and admission items',
  version: '1.0.0',
  type: 'integration',
  group: 'integration',
  features: ['cvent', 'cvent.sync'],
  edgeFunctions: ['integrations-cvent-sync'],
};

export default module;
