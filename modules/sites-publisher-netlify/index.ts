/**
 * Netlify publisher — module manifest.
 *
 * Implements IExternalPublisher (declared by the sites module). Mounted
 * by the platform's sites-publisher loader when a site's
 * publishing_target.publisherId === 'sites-publisher-netlify'.
 */

import type { GatewazeModule } from '@gatewaze/shared';

export const MODULE_ID = 'sites-publisher-netlify' as const;

const netlifyPublisherModule: GatewazeModule = {
  id: MODULE_ID,
  group: 'sites',
  type: 'integration',
  visibility: 'premium',
  name: 'Sites Publisher: Netlify',
  description:
    'External publisher adapter for Netlify. Implements IExternalPublisher (digest-mode deploy via SHA-1 manifest, custom domains via custom_domain + domain_aliases, SSL provisioning).',
  version: '0.1.0',
  features: ['sites.publishing.netlify'],
  dependencies: ['sites'],
  migrations: [],
  configSchema: {},

  onEnable: async () => {
    console.log('[sites-publisher-netlify] Module enabled');
  },
  onDisable: async () => {
    console.log('[sites-publisher-netlify] Module disabled');
  },
};

export default netlifyPublisherModule;

// Adapter + helpers — imported by the platform's publisher loader at
// dispatch time, not by the admin UI bundle.
export { NetlifyPublisher, type NetlifyAdapterDeps, type FetchLike } from './adapter.js';
export { validateSecrets, type NetlifySecrets } from './lib/api/index.js';

/**
 * JSON Schema describing this publisher's secrets bundle. The sites admin
 * publishing tab renders this through the schema-driven editor.
 *
 * Keys mirror NetlifySecrets; field-level validation in lib/api/secrets.ts
 * is the source of truth at runtime.
 */
export const secretsSchema = {
  type: 'object',
  required: ['apiToken', 'siteId'],
  properties: {
    apiToken: {
      type: 'string',
      title: 'API token',
      description:
        'Netlify personal access token with deploy + domains scopes. Create at app.netlify.com → User settings → Applications → Personal access tokens.',
      format: 'password',
      minLength: 20,
    },
    siteId: {
      type: 'string',
      title: 'Site id',
      description: 'Netlify site id (UUID or 24 hex chars). Found in Site configuration → Site information.',
      pattern: '^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$',
    },
    teamSlug: {
      type: 'string',
      title: 'Team slug (optional)',
      description: 'Used by team-level cleanup APIs.',
    },
  },
} as const;

/** Friendly label shown in admin dropdowns. */
export const PUBLISHER_LABEL = 'Netlify';
