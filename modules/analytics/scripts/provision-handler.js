/**
 * Analytics provisioning handler — JS shim consumed by the platform's
 * legacy `scripts/workers/job-worker.js`.
 *
 * The TS provisioning worker at ../src/workers/provisioning.ts is the
 * canonical implementation; this file mirrors its logic so the dev
 * worker container (which can't run TS) can drain the
 * analytics_provisioning_jobs queue.
 *
 * Cron `analytics-provision-property` enqueues one job per minute with
 * kind='analytics:provision-property'. Each tick:
 *   1. Selects analytics_provisioning_jobs WHERE status='queued' OR
 *      (status='failed' AND attempts<MAX AND backoff elapsed)
 *   2. For each row: looks up the parent analytics_properties record,
 *      POSTs /api/websites to Umami, persists website_uuid back, flips
 *      property status → 'active' and job status → 'succeeded'
 *   3. Idempotent: a property with website_uuid already set is left
 *      alone and the job is closed succeeded
 */

import { createClient } from '@supabase/supabase-js';

const UMAMI_BASE_URL = (process.env.UMAMI_BASE_URL || 'http://umami:3000').replace(/\/+$/, '');
const UMAMI_USERNAME = process.env.UMAMI_USERNAME || 'admin';
const UMAMI_PASSWORD = process.env.UMAMI_PASSWORD || '';
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

let supabase = null;
let umamiToken = null;
let umamiTokenExpiresAt = 0;

export function init(deps) {
  supabase = (deps && deps.supabase) || createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function umamiLogin() {
  const res = await fetch(`${UMAMI_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: UMAMI_USERNAME, password: UMAMI_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`umami login ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.token;
}

async function getToken() {
  if (umamiToken && Date.now() < umamiTokenExpiresAt) return umamiToken;
  umamiToken = await umamiLogin();
  umamiTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return umamiToken;
}

async function umamiCreateWebsite({ name, domain }) {
  const token = await getToken();
  const res = await fetch(`${UMAMI_BASE_URL}/api/websites`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, domain }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`umami create-website ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.id;
}

async function processOne(job) {
  // Mark in-flight
  await supabase
    .from('analytics_provisioning_jobs')
    .update({
      status: 'creating',
      attempts: (job.attempts || 0) + 1,
      last_attempted_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Look up parent property
  const { data: prop, error: propErr } = await supabase
    .from('analytics_properties')
    .select('property_id, kind, name, domains, website_uuid')
    .eq('property_id', job.property_id)
    .maybeSingle();
  if (propErr || !prop) {
    await supabase
      .from('analytics_provisioning_jobs')
      .update({
        status: 'failed',
        status_detail: (propErr && propErr.message) || 'property not found',
      })
      .eq('id', job.id);
    return;
  }

  // Idempotent — already has a website_uuid (e.g. previous run completed
  // but the job row didn't get marked, or someone provisioned manually).
  if (prop.website_uuid) {
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: 'succeeded' })
      .eq('id', job.id);
    if (prop.website_uuid) {
      await supabase
        .from('analytics_properties')
        .update({ status: 'active' })
        .eq('property_id', prop.property_id);
    }
    return;
  }

  try {
    const domain = (prop.domains && prop.domains[0]) || prop.name || 'unspecified';
    const websiteId = await umamiCreateWebsite({ name: prop.name, domain });
    await supabase
      .from('analytics_properties')
      .update({ website_uuid: websiteId, status: 'active' })
      .eq('property_id', prop.property_id);
    await supabase
      .from('analytics_provisioning_jobs')
      .update({ status: 'succeeded' })
      .eq('id', job.id);
    console.log(`[analytics:provision] ✓ ${prop.name} → website_uuid=${websiteId}`);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    await supabase
      .from('analytics_provisioning_jobs')
      .update({
        status: 'failed',
        status_detail: msg.slice(0, 200),
      })
      .eq('id', job.id);
    console.error(`[analytics:provision] ✗ ${prop.name}: ${msg}`);
  }
}

async function runQueueTick() {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data: queued, error } = await supabase
    .from('analytics_provisioning_jobs')
    .select('id, property_id, status, attempts')
    .or(`status.eq.queued,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS},last_attempted_at.lt.${cutoff})`)
    .limit(50);

  if (error) {
    console.error(`[analytics:provision] queue read failed: ${error.message}`);
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const jobs = queued || [];
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    await processOne(job);
    const { data } = await supabase
      .from('analytics_provisioning_jobs')
      .select('status')
      .eq('id', job.id)
      .maybeSingle();
    if (data && data.status === 'succeeded') succeeded++;
    else if (data && data.status === 'failed') failed++;
  }
  if (jobs.length > 0) {
    console.log(`[analytics:provision] tick done — processed=${jobs.length} succeeded=${succeeded} failed=${failed}`);
  }
  return { processed: jobs.length, succeeded, failed };
}

/**
 * BullMQ job handler. Cron data shape: { kind: 'analytics:provision-property' }.
 * One tick walks the queue table; the cron fires every 60s.
 */
export default async function handler(_job) {
  if (!supabase) {
    init();
  }
  return await runQueueTick();
}
