import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'ad-conversions',
  name: 'Ad Conversions',
  description:
    'Server-side conversion events for Meta, Reddit and LinkedIn ad campaigns, matched to registrations by click id and hashed email',
  version: '1.1.0',
  type: 'integration',
  visibility: 'public',
  group: 'marketing',
  features: ['ad-conversions', 'ad-conversions.meta', 'ad-conversions.reddit', 'ad-conversions.linkedin'],
  dependencies: ['events', 'event-tracking'],
  edgeFunctions: [
    'integrations-send-conversion',
    'integrations-send-meta-conversion',
    'integrations-send-reddit-conversion',
    'integrations-send-linkedin-conversion',
  ],
  migrations: [
    'migrations/001_platform_configs_and_dispatch.sql',
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
