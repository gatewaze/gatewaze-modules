import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'ad-conversions',
  name: 'Ad Conversions',
  description:
    'Ad platform conversion tracking for Meta (Facebook/Instagram) and Reddit campaigns',
  version: '1.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'integration',
  features: ['ad-conversions', 'ad-conversions.meta', 'ad-conversions.reddit'],
  edgeFunctions: [
    'integrations-send-conversion',
    'integrations-send-meta-conversion',
    'integrations-send-reddit-conversion',
  ],
  configSchema: {},
  onInstall: async () => {
    console.log('[ad-conversions] Module installed');
  },
  onEnable: async () => {
    console.log('[ad-conversions] Module enabled');
  },
  onDisable: async () => {
    console.log('[ad-conversions] Module disabled');
  },
};

export default module;
