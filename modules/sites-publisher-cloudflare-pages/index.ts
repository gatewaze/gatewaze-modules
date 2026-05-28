/**
 * Cloudflare Pages publisher — module manifest.
 *
 * Implements IExternalPublisher (declared by the sites module). Mounted
 * by the platform's sites-publisher loader when a site's
 * publishing_target.publisherId === 'sites-publisher-cloudflare-pages'.
 */

import type { GatewazeModule } from '@gatewaze/shared';

export const MODULE_ID = 'sites-publisher-cloudflare-pages' as const;

const cloudflarePagesPublisherModule: GatewazeModule = {
  id: MODULE_ID,
  group: 'sites',
  type: 'integration',
  visibility: 'premium',
  name: 'Sites Publisher: Cloudflare Pages',
  description:
    'External publisher adapter for Cloudflare Pages. Implements IExternalPublisher (deploy via direct-upload manifest, custom domains, zone-scoped cache purge).',
  version: '0.1.0',
  features: ['sites.publishing.cloudflare-pages'],
  dependencies: ['sites'],
  migrations: [],
  configSchema: {},

  onEnable: async () => {
    console.log('[sites-publisher-cloudflare-pages] Module enabled');
  },
  onDisable: async () => {
    console.log('[sites-publisher-cloudflare-pages] Module disabled');
  },
};

export default cloudflarePagesPublisherModule;

// Adapter + helpers — imported by the platform's publisher loader at
// dispatch time, not by the admin UI bundle.
export { CloudflarePagesPublisher, type CloudflareAdapterDeps, type FetchLike } from './adapter.js';
export { validateSecrets, type CloudflareSecrets } from './lib/api/index.js';

/**
 * JSON Schema describing this publisher's secrets bundle. The sites admin
 * publishing tab renders this through the schema-driven editor so operators
 * see typed inputs (and `format: "password"` masks the token).
 *
 * Keys mirror CloudflareSecrets; field-level validation in
 * lib/api/secrets.ts is the source of truth at runtime.
 */
export const secretsSchema = {
  type: 'object',
  required: ['apiToken', 'accountId', 'projectName'],
  properties: {
    apiToken: {
      type: 'string',
      title: 'API token',
      description:
        'Cloudflare API token with Pages:Edit (and Zone:Cache Purge if you set zoneId). Create in dash.cloudflare.com → My Profile → API Tokens.',
      format: 'password',
      minLength: 20,
    },
    accountId: {
      type: 'string',
      title: 'Account id',
      description: 'Cloudflare account id (32 hex chars, found on any zone\'s overview page).',
      pattern: '^[0-9a-f]{32}$',
    },
    projectName: {
      type: 'string',
      title: 'Pages project name',
      description: 'The Pages project slug (created in the Cloudflare dashboard).',
      pattern: '^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$',
    },
    zoneId: {
      type: 'string',
      title: 'Zone id (optional)',
      description: 'Required only for cache purge. 32 hex chars.',
      pattern: '^[0-9a-f]{32}$',
    },
    productionBranch: {
      type: 'string',
      title: 'Production branch (optional)',
      description: 'Defaults to "main".',
    },
  },
} as const;

/** Friendly label shown in admin dropdowns. */
export const PUBLISHER_LABEL = 'Cloudflare Pages';
