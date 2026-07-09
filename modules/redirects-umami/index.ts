import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Redirect Adapter: Umami Links (self-hosted).
 *
 * Short links are minted in the analytics module's Umami instance
 * (POST /api/links) via the platform API's POST /api/redirects/create-bulk,
 * and served publicly through the analytics module's GET /a/q/:slug proxy
 * (Umami itself stays cluster-internal). Click analytics ride the standard
 * per-link Umami stats endpoints — no external provider, no API quota.
 *
 * Enabling this module makes "Umami (self-hosted)" selectable as the
 * Link Redirect Provider in newsletter template settings.
 */
const umamiRedirectModule: GatewazeModule = {
  id: 'redirects-umami',
  group: 'sites',
  type: 'integration',
  visibility: 'public',
  name: 'Redirect Adapter: Umami Links',
  description: 'Self-hosted short links via Umami Links — bulk creation, first-party click analytics, and no external provider dependency. Replaces Short.io/Bitly.',
  version: '1.0.0',
  features: ['redirects-umami'],
  dependencies: ['redirects', 'analytics'],
  migrations: [],

  configSchema: {
    REDIRECT_PUBLIC_BASE_URL: {
      key: 'REDIRECT_PUBLIC_BASE_URL',
      type: 'string',
      required: false,
      description: 'Public origin used to compose short URLs (e.g. https://api.brand.com). Defaults to the API host serving the request. Short links resolve at <origin>/a/q/<slug>.',
    },
  },

  onInstall: async () => {
    console.log('[redirects-umami] Module installed');
  },
  onEnable: async () => {
    console.log('[redirects-umami] Module enabled');
  },
  onDisable: async () => {
    console.log('[redirects-umami] Module disabled');
  },
};

export default umamiRedirectModule;
