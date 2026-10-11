import type { GatewazeModule } from '@gatewaze/shared';

export const MODULE_ID = 'videos-publisher-youtube' as const;

/**
 * The OAuth CLIENT, one per deployment.
 *
 * Rendered as a form by the admin Modules page and sealed into
 * installed_modules.config with the platform envelope, the same way
 * sites-publisher-netlify takes its API token.
 *
 * This is deliberately NOT where a channel's refresh token goes. AAIF
 * publishes to two YouTube channels, so the per-account credential is
 * per-row on video_platform_connections. One client, many channels.
 *
 * The `format: 'password'` fields are write-only in the admin: the API never
 * returns them, and a previous YouTube integration in this codebase shipped
 * exactly these two values to the browser through VITE_ variables, which is
 * why they live here instead.
 */
export const secretsSchema = {
  type: 'object',
  required: ['clientId', 'clientSecret'],
  properties: {
    clientId: {
      type: 'string',
      title: 'OAuth client ID',
      description:
        'From the Google Cloud console → APIs & Services → Credentials → OAuth 2.0 Client IDs, of type "Web application". The project needs the YouTube Data API v3 and the YouTube Analytics API enabled.',
      pattern: '^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$',
    },
    clientSecret: {
      type: 'string',
      title: 'OAuth client secret',
      description:
        'The client secret for that same OAuth client. Sealed at rest and never returned by any endpoint.',
      format: 'password',
      minLength: 10,
    },
  },
} as const;

const youtubePublisherModule: GatewazeModule = {
  id: MODULE_ID,
  group: 'videos',
  type: 'integration',
  visibility: 'public',
  name: 'Videos Publisher: YouTube',
  description:
    'Connects one or more YouTube channels, publishes videos to them on a schedule, and collects their statistics back. Publishing and collection share one adapter so a de-authorised channel is learned once.',
  version: '0.1.0',
  // Must be namespaced on the MODULE ID, not on the host module's. The
  // platform rejects 'videos.publishing.youtube' outright:
  // MODULE_FEATURE_NAMESPACE_VIOLATION. sites-publisher-netlify predates
  // that check and would fail it too.
  features: ['videos-publisher-youtube', 'videos-publisher-youtube.publish'],
  dependencies: ['videos'],
  // The schema lives in the videos module: connections and metrics are
  // shared across every platform adapter, not owned by this one.
  migrations: [],
  configSchema: {},

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    registerRoutes(app as any, ctx as any);
  },

  workers: [
    {
      // File stem MUST equal the job-name suffix: the prod worker derives the
      // job name from the handler filename as `${moduleId}:${stem}`.
      name: 'videos-publisher-youtube:collect-metrics',
      handler: './workers/collect-metrics.ts',
      concurrency: 1,
    },
  ],

  crons: [
    {
      // 04:15 UTC, daily. Every platform settles its own numbers on a day
      // boundary, so polling more often buys nothing and spends quota. The
      // Data API costs one unit per batched call of up to 50 ids.
      name: 'videos-publisher-youtube:collect-metrics',
      queue: 'jobs',
      schedule: { pattern: '15 4 * * *' },
      data: { kind: 'videos-publisher-youtube:collect-metrics' },
    },
  ],

  onEnable: async () => {
    console.log('[videos-publisher-youtube] Module enabled');
  },
  onDisable: async () => {
    console.log('[videos-publisher-youtube] Module disabled');
  },
};

export default youtubePublisherModule;
