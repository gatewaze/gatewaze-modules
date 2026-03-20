import type { GatewazeModule } from '@gatewaze/shared/modules';

const customerioModule: GatewazeModule = {
  id: 'customerio',
  type: 'integration',
  group: 'integration',
  name: 'Customer.io',
  description: 'Customer.io CRM integration for syncing contacts, tracking events, and processing webhooks',
  version: '1.0.0',
  features: [
    'customerio',
    'customerio.sync',
    'customerio.webhooks',
    'customerio.tracking',
  ],

  edgeFunctions: [
    'integrations-customerio-sync',
    'integrations-customerio-webhook',
    'integrations-customerio-sync-person',
    'integrations-customerio-process-events',
    'integrations-track-event',
  ],

  onInstall: async () => {
    console.log('[customerio] Module installed');
  },

  onEnable: async () => {
    console.log('[customerio] Module enabled');
  },

  onDisable: async () => {
    console.log('[customerio] Module disabled');
  },
};

export default customerioModule;
