import type { GatewazeModule } from '@gatewaze/shared';

const redirectsModule: GatewazeModule = {
  id: 'redirects',
  type: 'feature',
  visibility: 'public',
  name: 'Redirects',
  description: 'Manage URL redirects and short links with click tracking and analytics',
  version: '1.0.0',
  features: [
    'redirects',
    'redirects.manage',
    'redirects.analytics',
  ],

  migrations: [
    'migrations/001_redirects_tables.sql',
  ],

  configSchema: {
    SHORTIO_API_KEY: {
      key: 'SHORTIO_API_KEY',
      type: 'secret',
      required: false,
      description: 'Short.io API key for external short link management',
    },
    SHORTIO_DOMAIN: {
      key: 'SHORTIO_DOMAIN',
      type: 'string',
      required: false,
      description: 'Short.io custom domain',
    },
  },

  onInstall: async () => {
    console.log('[redirects] Module installed');
  },

  onEnable: async () => {
    console.log('[redirects] Module enabled');
  },

  onDisable: async () => {
    console.log('[redirects] Module disabled');
  },
};

export default redirectsModule;
