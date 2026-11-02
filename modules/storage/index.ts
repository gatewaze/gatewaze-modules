import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Storage providers for module files.
 *
 * Supabase Storage is built in. Other providers are modules named
 * storage-<id> (storage-r2 for Cloudflare R2). Modules that keep files call
 * createStorageRegistry (lib/registry.ts) and never talk to a provider
 * directly; see guide.md.
 *
 * Server code only: nothing here may be imported from admin or portal code,
 * because the AWS SDK must not reach a browser bundle.
 */
const storageModule: GatewazeModule = {
  id: 'storage',
  group: 'platform',
  type: 'feature',
  visibility: 'public',
  name: 'Storage',
  description: 'Where module files are kept. Supabase Storage is built in; add a provider module such as storage-r2 to keep new files elsewhere.',
  version: '0.1.0',
  features: ['storage'],
  migrations: [],

  configSchema: {
    default_provider: {
      key: 'default_provider',
      type: 'string',
      required: false,
      default: 'supabase',
      validationRegex: '^[a-z0-9][a-z0-9-]{0,30}$',
      description: 'The provider new files go to: supabase, or the id of an enabled storage-<id> module (e.g. r2). The STORAGE_PROVIDER env var wins over this.',
    },
    provider_media: {
      key: 'provider_media',
      type: 'string',
      required: false,
      validationRegex: '^([a-z0-9][a-z0-9-]{0,30})?$',
      description: 'The provider for event and host media only, when it should differ from the default. STORAGE_PROVIDER_MEDIA wins over this.',
    },
  },

  onInstall: async () => {
    console.log('[storage] Module installed');
  },
  onEnable: async () => {
    console.log('[storage] Module enabled');
  },
  onDisable: async () => {
    console.log('[storage] Module disabled');
  },
};

export default storageModule;
