// @ts-nocheck — depends on @supabase/supabase-js + bullmq Job type which
// resolve at runtime via the api package's node_modules. Excluded from
// strict tsconfig (same pattern as register-routes.ts and
// migrate-existing-sites-to-git.ts).
/**
 * Default-export job handler for sites cron jobs.
 *
 * The platform's job-worker dispatches each registered worker name to a
 * single default-exported handler function. We use ONE handler file
 * shared across all four sites cron jobs and dispatch internally on
 * `job.name` (the worker registration name).
 *
 * Per spec-content-modules-git-architecture §6.7 + §15.4 + §18.4.
 */

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { InternalGitServerImpl } from '../lib/git/internal-git-server-impl.js';
import { PublishWorker } from '../lib/publish-worker/publish-worker.js';
import { buildSiteContentFiles } from '../lib/publish-worker/build-site-content.js';
import {
  runBoilerplateVersionPoll,
  runScheduledRepublish,
  runDriftWatcher,
  runMediaUsageReconcile,
} from './cron-handlers.js';

interface BullJob {
  name: string;
  data: { kind?: string };
}

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => console.log(`[sites:cron] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[sites:cron] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`[sites:cron] ${msg}`, meta ?? ''),
};

const gitServer = new InternalGitServerImpl({
  rootDir: process.env.SITES_INTERNAL_GIT_ROOT ?? '/var/gatewaze/git',
  signingKey: Buffer.from(
    process.env.SITES_GIT_SIGNING_KEY ?? randomBytes(32).toString('hex'),
    'hex',
  ),
  supabase: supabase as any,
  logger,
});

const publishWorker = new PublishWorker({
  supabase: supabase as any,
  gitServer,
  resolveSiteRepo: async (siteId: string) => gitServer.lookupRepo('site', siteId),
  resolveListRepo: async (listId: string) => gitServer.lookupRepo('list', listId),
  buildSiteContentFiles: async (siteId: string, pages?: string[]) =>
    buildSiteContentFiles(siteId, pages, { supabase: supabase as any, logger }),
  logger,
});

const deps = { supabase, gitServer, publishWorker, logger };

export default async function handler(job: BullJob): Promise<unknown> {
  // Dispatch on the cron name (which is the worker registration name).
  // The cron config in index.ts sets data.kind to the same string for
  // observability; we trust job.name as the routing key.
  const kind = job.data?.kind ?? job.name;

  logger.info('cron tick', { kind });

  switch (kind) {
    case 'sites:boilerplate-version-poll':
      return runBoilerplateVersionPoll(deps);
    case 'sites:scheduled-republish':
      return runScheduledRepublish(deps);
    case 'sites:drift-watch':
      return runDriftWatcher(deps);
    case 'sites:media-usage-reconcile':
      return runMediaUsageReconcile(deps);
    default:
      logger.warn('unknown cron kind', { kind });
      return { skipped: true, reason: 'unknown_kind' };
  }
}
