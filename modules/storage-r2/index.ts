import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Cloudflare R2 storage provider. Enable it, fill in the settings, then set
 * the storage module's default_provider (or STORAGE_PROVIDER) to r2. Files
 * already in Supabase stay there; only new files go to R2.
 */
const storageR2Module: GatewazeModule = {
  id: 'storage-r2',
  group: 'platform',
  type: 'integration',
  visibility: 'public',
  name: 'Storage Provider: Cloudflare R2',
  description: 'Keep new files in a Cloudflare R2 bucket, served from your own domain, with pictures resized by Cloudflare on request.',
  version: '0.1.0',
  features: ['storage-r2'],
  dependencies: ['storage'],
  migrations: [],

  configSchema: {
    R2_ACCOUNT_ID: {
      key: 'R2_ACCOUNT_ID',
      type: 'string',
      required: true,
      validationRegex: '^[a-f0-9]{32}$',
      description: 'Cloudflare account id (32 hex characters).',
    },
    R2_BUCKET: {
      key: 'R2_BUCKET',
      type: 'string',
      required: true,
      validationRegex: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$',
      description: 'The R2 bucket new files go to.',
    },
    R2_ACCESS_KEY_ID: {
      key: 'R2_ACCESS_KEY_ID',
      type: 'secret',
      encrypted: true,
      required: true,
      description: 'Access Key ID of an R2 API token with Object Read & Write on the bucket.',
    },
    R2_SECRET_ACCESS_KEY: {
      key: 'R2_SECRET_ACCESS_KEY',
      type: 'secret',
      encrypted: true,
      required: true,
      description: 'Secret Access Key of the same R2 API token.',
    },
    R2_PUBLIC_URL: {
      key: 'R2_PUBLIC_URL',
      type: 'string',
      required: true,
      validationRegex: '^https://[A-Za-z0-9.-]+$',
      description: "The bucket's custom domain, e.g. https://media.example.com (no path).",
    },
    R2_IMAGE_RESIZING: {
      key: 'R2_IMAGE_RESIZING',
      type: 'boolean',
      required: false,
      default: 'false',
      description: "Serve resized pictures through Cloudflare Image Transformations on the custom domain. Turn Transformations on for the domain's zone first.",
    },
    R2_JURISDICTION: {
      key: 'R2_JURISDICTION',
      type: 'select',
      required: false,
      default: '',
      options: [
        { label: 'Default', value: '' },
        { label: 'EU', value: 'eu' },
        { label: 'FedRAMP', value: 'fedramp' },
      ],
      description: 'Only for a bucket created with a jurisdiction.',
    },
  },

  onInstall: async () => {
    console.log('[storage-r2] Module installed');
  },
  onEnable: async () => {
    console.log('[storage-r2] Module enabled');
  },
  onDisable: async () => {
    console.log('[storage-r2] Module disabled');
  },
};

export default storageR2Module;
