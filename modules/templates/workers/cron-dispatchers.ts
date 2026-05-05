// @ts-nocheck — depends on @supabase/supabase-js which resolves at runtime
// via the api package's node_modules. Excluded from strict tsconfig (same
// pattern as sites/workers/cron-dispatchers.ts).
/**
 * Default-export job handler for templates cron jobs.
 *
 * The platform's job-worker dispatches each registered worker name (per
 * `workers:` in templates/index.ts) to a single default-exported handler.
 * This file is that handler — it dispatches internally on `job.name`.
 *
 * Per spec-templates-module §6.5 (drift-monitor scheduler).
 */

import { createClient } from '@supabase/supabase-js';
import { checkAllGitSources } from '../lib/drift-monitor/index.js';

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
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[templates:cron] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[templates:cron] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[templates:cron] ${msg}`, meta ?? ''),
};

/**
 * Resolves a `templates_sources.token_secret_ref` to the actual git PAT.
 *
 * In v0.1 the token is stored inline (we accept it on the create-source
 * route as a `token` body field; see api/sources.ts). The `token_secret_ref`
 * column is currently a placeholder for the future secrets-manager
 * integration. Until that lands, the drift monitor runs anonymously —
 * private repos won't auto-update via cron, only manual ingest works.
 */
async function resolveToken(_ref: string | null): Promise<string | null> {
  return null;
}

export default async function handler(job: BullJob): Promise<unknown> {
  const kind = job.data?.kind ?? job.name;
  logger.info('cron tick', { kind, jobName: job.name });

  switch (kind) {
    case 'templates:check-source-updates': {
      const result = await checkAllGitSources({
        supabase: supabase as any,
        resolveToken,
        logger,
      });
      return result;
    }
    default:
      logger.warn('unknown templates cron kind', { kind });
      return { ok: false, reason: 'unknown_kind', kind };
  }
}
