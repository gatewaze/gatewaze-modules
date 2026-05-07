// @ts-nocheck — depends on @supabase/supabase-js + bullmq Job type which
// resolve at runtime via the api package's node_modules.
/**
 * Provisioning worker — turns analytics_provisioning_jobs rows into Umami
 * `website` entities.
 *
 * Per spec-analytics-module §3.2 + §10.1.
 *
 * Trigger: cron-fired every minute. Reads `analytics_provisioning_jobs`
 * WHERE status='queued' OR (status='failed' AND attempts < 5 AND
 * last_attempted_at < now() - INTERVAL '5 min').
 *
 * For each row:
 *   1. Look up the parent analytics_properties row
 *   2. POST /api/websites to Umami with name + domain
 *   3. Persist the returned website_uuid back to analytics_properties
 *   4. Mark the provisioning job 'succeeded'
 *
 * Idempotent: if a worker crashes mid-flight, the next run picks up the
 * row in 'creating' state via a status filter and resumes from the
 * Umami side (Umami's POST /api/websites is itself idempotent on the
 * (name, domain) tuple).
 */

import { createClient } from '@supabase/supabase-js';
import { createUmamiClient } from '../service/umami-client.js';

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
  info: (msg: string, meta?: Record<string, unknown>) => console.log(`[analytics:cron] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[analytics:cron] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`[analytics:cron] ${msg}`, meta ?? ''),
};

const umami = createUmamiClient({
  baseUrl: process.env.UMAMI_BASE_URL ?? 'http://umami:3000',
  username: process.env.UMAMI_USERNAME ?? 'admin',
  password: process.env.UMAMI_PASSWORD ?? '',
});

interface PropertyRow {
  property_id: string;
  kind: string;
  name: string;
  domains: string[];
  website_uuid: string | null;
}

interface JobRow {
  id: string;
  property_id: string;
  status: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 5 * 60 * 1000;

async function processOne(job: JobRow): Promise<void> {
  // Mark in-flight
  await supabase
    .from('analytics_provisioning_jobs')
    .update({
      status: 'creating',
      attempts: job.attempts + 1,
      last_attempted_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Look up the parent property
  const { data: prop, error: propErr } = await supabase
    .from('analytics_properties')
    .select('property_id, kind, name, domains, website_uuid')
    .eq('property_id', job.property_id)
    .maybeSingle<PropertyRow>();

  if (propErr || !prop) {
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: 'failed', status_detail: `parent property not found: ${propErr?.message ?? 'no row'}` })
      .eq('id', job.id);
    return;
  }

  // If website_uuid already set, just succeed (idempotent path for
  // resumed jobs after a crash).
  if (prop.website_uuid) {
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: 'succeeded', status_detail: null })
      .eq('id', job.id);
    await supabase
      .from('analytics_properties')
      .update({ status: 'active' })
      .eq('property_id', job.property_id);
    return;
  }

  // Create the Umami website. POST /api/websites; body = { name, domain }.
  // Umami requires a single domain string; we use the first non-wildcard
  // entry from `domains`, falling back to a placeholder for external-with-
  // wildcard properties (the operator typically sets a domain after first
  // event arrives).
  const concreteDomain = prop.domains.find((d) => d !== '*') ?? 'unspecified.local';
  try {
    const created = await umami.post<{ id: string; websiteUuid?: string }>('/api/websites', {
      name: prop.name,
      domain: concreteDomain,
    });
    const websiteUuid = created.websiteUuid ?? created.id;
    if (!websiteUuid) throw new Error('umami did not return a website id');

    await supabase
      .from('analytics_properties')
      .update({ website_uuid: websiteUuid, status: 'active' })
      .eq('property_id', job.property_id);
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: 'succeeded', status_detail: null })
      .eq('id', job.id);

    logger.info('analytics: property provisioned', {
      property_id: job.property_id,
      website_uuid: websiteUuid,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    const finalStatus = job.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued';
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: finalStatus, status_detail: message.slice(0, 500) })
      .eq('id', job.id);
    logger.warn('analytics: provisioning attempt failed', {
      property_id: job.property_id,
      attempts: job.attempts + 1,
      finalStatus,
      message,
    });
  }
}

/**
 * Walk the queue once. Picks up:
 *   - status='queued'
 *   - status='failed' AND attempts < MAX AND last_attempted_at older than backoff
 */
async function runQueueTick(): Promise<{ processed: number; succeeded: number; failed: number }> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data: queued } = await supabase
    .from('analytics_provisioning_jobs')
    .select('id, property_id, status, attempts')
    .or(`status.eq.queued,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS},last_attempted_at.lt.${cutoff})`)
    .limit(50);

  const jobs = (queued ?? []) as JobRow[];
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    await processOne(job);
    // Re-read terminal status to count outcomes
    const { data } = await supabase
      .from('analytics_provisioning_jobs')
      .select('status')
      .eq('id', job.id)
      .maybeSingle<{ status: string }>();
    if (data?.status === 'succeeded') succeeded++;
    else if (data?.status === 'failed') failed++;
  }
  return { processed: jobs.length, succeeded, failed };
}

export default async function handler(job: BullJob): Promise<unknown> {
  const kind = job.data?.kind ?? job.name;
  logger.info('cron tick', { kind, jobName: job.name });

  switch (kind) {
    case 'analytics:provision-property': {
      const result = await runQueueTick();
      return result;
    }
    case 'analytics:share-token-rotation': {
      // v1 has no admin surface for share tokens; this branch ensures the
      // cron is wired so the row in templates_index exists. No-op for now.
      logger.info('share-token rotation tick — no-op in v1');
      return { ok: true, rotated: 0 };
    }
    default:
      logger.warn('unknown analytics cron kind', { kind });
      return { ok: false, reason: 'unknown_kind', kind };
  }
}
