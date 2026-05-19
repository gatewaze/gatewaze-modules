/**
 * Webhooks module — Layer 2 of spec-api-cache-and-revalidation.md.
 *
 * Listens on the gatewaze.mutation Postgres NOTIFY channel and fans out
 * signed HTTP POSTs to subscribed theme /api/revalidate endpoints. Also
 * fires best-effort Cloudflare cache-purge calls so the next visitor sees
 * fresh content from the upstream edge.
 *
 * Wires:
 *   - apiRoutes → mounts /api/admin/sites/:siteId/webhook-subscriptions/...
 *                 AND starts the LISTEN worker (process-lifetime).
 *
 * Migrations seed only the trigger function + tables here; each content
 * module installs its OWN row in webhook_event_topics + CREATE TRIGGER on
 * its table (see each content module's migrations/NNN_webhook_topic.sql).
 */

import type { GatewazeModule, ModuleRuntimeContext } from '@gatewaze/shared';

const webhooksModule: GatewazeModule = {
  id: 'webhooks',
  group: 'platform',
  type: 'feature',
  visibility: 'public',
  name: 'Webhooks',
  description:
    'Mutation-driven outbound webhooks. Fires signed HTTP POSTs to deployed-theme /api/revalidate handlers when content rows change. Layer 2 of spec-api-cache-and-revalidation.',
  version: '1.0.0',

  features: ['webhooks', 'webhooks.manage'],

  adminRoutes: [
    {
      path: 'webhooks',
      component: () => import('./admin/components/WebhooksTab'),
      requiredFeature: 'webhooks',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/webhooks',
      label: 'Webhooks',
      // `Bolt` is a Heroicon ("flash of lightning") — distinguishes the
      // entry from other plumbing tabs and reads as "fires on change".
      icon: 'Bolt',
      requiredFeature: 'webhooks',
      parentGroup: 'admin',
      order: 90, // bottom of the admin group — operator plumbing, not content
    },
  ],

  configSchema: {},

  // No hard dependency on sites — global topics (e.g. blog_posts) don't
  // require sites to exist. Modules that wire site-scoped triggers
  // depend on sites themselves.
  dependencies: [],

  migrations: [
    'migrations/001_webhook_subscriptions.sql',
    'migrations/002_emit_mutation_event_function.sql',
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  onInstall: async () => {
    console.log('[webhooks] Module installed (v1.0.0)');
  },

  onEnable: async (_ctx?: ModuleRuntimeContext) => {
    console.log('[webhooks] Module enabled — LISTEN worker starts via apiRoutes()');
  },

  onDisable: async () => {
    console.log('[webhooks] Module disabled — stopping LISTEN worker');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = (globalThis as any).__gatewazeWebhooksWorker;
    if (worker && typeof worker.stop === 'function') {
      try { await worker.stop(); } catch { /* ignore */ }
    }
  },
};

export default webhooksModule;
