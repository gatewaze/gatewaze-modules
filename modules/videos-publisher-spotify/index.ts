import type { GatewazeModule } from '@gatewaze/shared';

export const MODULE_ID = 'videos-publisher-spotify' as const;

/**
 * The OP3 API token, one per deployment.
 *
 * There is deliberately NO Spotify credential here. Spotify has no analytics
 * API, its dashboard is Disallow: / in robots.txt, and its User Guidelines
 * prohibit automated collection with no carve-out for your own data. The
 * account that would be at risk hosts every audio file for the show, so the
 * downside of getting that wrong is the podcast going offline.
 *
 * So the numbers come from OP3, whose token belongs to no person, and from
 * CSV exports a human downloads from the dashboard themselves.
 */
export const secretsSchema = {
  type: 'object',
  required: ['op3Token'],
  properties: {
    op3Token: {
      type: 'string',
      title: 'OP3 API token',
      description:
        'From op3.dev. Used to read download counts for shows whose feed carries the OP3 prefix. Read-only, belongs to the organisation rather than to a person, and revocable without touching the podcast.',
      format: 'password',
      minLength: 8,
    },
  },
} as const;

const spotifyPublisherModule: GatewazeModule = {
  id: MODULE_ID,
  group: 'videos',
  type: 'integration',
  visibility: 'public',
  name: 'Videos Publisher: Podcasts',
  description:
    'Episode catalogue from the RSS feed, download metrics from OP3 with a per-app split, and Spotify analytics CSV import. Holds no Spotify credential.',
  version: '0.2.0',
  // Namespaced on the MODULE ID: the platform rejects anything else with
  // MODULE_FEATURE_NAMESPACE_VIOLATION.
  features: ['videos-publisher-spotify', 'videos-publisher-spotify.metrics'],
  dependencies: ['videos'],
  // Schema lives in the videos module: connections and metrics are shared
  // across every platform adapter.
  migrations: [],
  configSchema: {},

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    registerRoutes(app as any, ctx as any);
  },

  workers: [
    {
      name: 'videos-publisher-spotify:discover-episodes',
      handler: './workers/discover-episodes.ts',
      concurrency: 1,
    },
    {
      name: 'videos-publisher-spotify:collect-op3',
      handler: './workers/collect-op3.ts',
      concurrency: 1,
    },
  ],

  crons: [
    {
      // 03:50 UTC, before the metrics run, so a new episode is in the
      // catalogue before anything tries to measure it.
      name: 'videos-publisher-spotify:discover-episodes',
      queue: 'jobs',
      schedule: { pattern: '50 3 * * *' },
      data: { kind: 'videos-publisher-spotify:discover-episodes' },
    },
    {
      // 04:25 UTC. OP3 settles on a day boundary like everything else.
      name: 'videos-publisher-spotify:collect-op3',
      queue: 'jobs',
      schedule: { pattern: '25 4 * * *' },
      data: { kind: 'videos-publisher-spotify:collect-op3' },
    },
  ],

  onEnable: async () => { console.log('[videos-publisher-spotify] Module enabled'); },
  onDisable: async () => { console.log('[videos-publisher-spotify] Module disabled'); },
};

export default spotifyPublisherModule;
