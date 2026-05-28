import type { GatewazeModule } from '@gatewaze/shared';

const bunnyCdnModule: GatewazeModule = {
  id: 'bunny-cdn',
  type: 'integration',
  visibility: 'public',
  group: 'sites',
  name: 'Bunny CDN',
  description:
    'Bunny.net CDN integration for optimized image delivery. Proxies Supabase Storage through Bunny CDN pull zones for faster, cheaper image transformations.',
  version: '1.0.0',
  features: ['bunny-cdn'],

  configSchema: {
    BUNNY_PULLZONE_URL: {
      key: 'BUNNY_PULLZONE_URL',
      type: 'string',
      required: true,
      description:
        'Bunny CDN pull zone URL (e.g., https://example.b-cdn.net)',
    },
    BUNNY_CDN_ENABLED: {
      key: 'BUNNY_CDN_ENABLED',
      type: 'boolean',
      required: false,
      description: 'Enable Bunny CDN image optimization',
      default: 'true',
    },
  },

  onInstall: async () => {
    console.log('[bunny-cdn] Module installed');
  },

  onEnable: async () => {
    console.log('[bunny-cdn] Module enabled');
  },

  onDisable: async () => {
    console.log('[bunny-cdn] Module disabled');
  },
};

export default bunnyCdnModule;
