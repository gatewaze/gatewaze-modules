import type { GatewazeModule } from '@gatewaze/shared';

const bitlyRedirectModule: GatewazeModule = {
  id: 'redirects-bitly',
  group: 'sites',
  type: 'integration',
  visibility: 'public',
  name: 'Redirect Adapter: Bitly',
  description: 'Bitly integration for creating and managing short links with click analytics.',
  version: '1.0.0',
  features: ['redirects-bitly'],
  dependencies: ['redirects'],
  migrations: [],

  configSchema: {
    BITLY_ACCESS_TOKEN: {
      key: 'BITLY_ACCESS_TOKEN',
      type: 'secret',
      required: true,
      description: 'Bitly access token',
    },
    BITLY_GROUP_GUID: {
      key: 'BITLY_GROUP_GUID',
      type: 'string',
      required: false,
      description: 'Bitly group GUID (optional, uses default group if not set)',
    },
    BITLY_DOMAIN: {
      key: 'BITLY_DOMAIN',
      type: 'string',
      required: false,
      description: 'Custom Bitly domain (defaults to bit.ly)',
    },
  },

  onInstall: async () => {
    console.log('[redirects-bitly] Module installed');
  },
  onEnable: async () => {
    console.log('[redirects-bitly] Module enabled');
  },
  onDisable: async () => {
    console.log('[redirects-bitly] Module disabled');
  },
};

export default bitlyRedirectModule;
