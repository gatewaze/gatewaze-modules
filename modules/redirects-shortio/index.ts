import type { GatewazeModule } from '@gatewaze/shared';

const shortioRedirectModule: GatewazeModule = {
  id: 'redirects-shortio',
  group: 'sites',
  type: 'integration',
  visibility: 'public',
  name: 'Redirect Adapter: Short.io',
  description: 'Short.io integration for creating and managing short links. Provides bulk link creation, click analytics, and domain management.',
  version: '1.0.0',
  features: ['redirects-shortio'],
  dependencies: ['redirects'],
  migrations: [],

  configSchema: {
    SHORTIO_API_KEY: {
      key: 'SHORTIO_API_KEY',
      type: 'secret',
      required: true,
      description: 'Short.io API key',
    },
    SHORTIO_DOMAIN: {
      key: 'SHORTIO_DOMAIN',
      type: 'string',
      required: true,
      description: 'Short.io custom domain (e.g., go.example.com)',
    },
  },

  onInstall: async () => {
    console.log('[redirects-shortio] Module installed');
  },
  onEnable: async () => {
    console.log('[redirects-shortio] Module enabled');
  },
  onDisable: async () => {
    console.log('[redirects-shortio] Module disabled');
  },
};

export default shortioRedirectModule;
