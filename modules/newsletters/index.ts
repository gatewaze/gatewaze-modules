import type { GatewazeModule } from '@gatewaze/shared/modules';

const module: GatewazeModule = {
  id: 'newsletters',
  name: 'Newsletters',
  description:
    'Newsletter management and synchronisation from external sources',
  version: '1.0.0',
  type: 'feature',
  group: 'feature',
  features: ['newsletters', 'newsletters.sync'],
  edgeFunctions: ['integrations-sync-newsletters'],
};

export default module;
