// @ts-nocheck — depends on pg + supabase-js; resolved at worker-host install time.

/**
 * compliance:erasure — runs the database side of privacy requests.
 *
 * Job data: { requestId, action, actor }
 *   preview     identify + plan; saves the plan on the request. Changes nothing.
 *   execute     the erasure transaction, then auth users, processors,
 *               materialized views, and completion.
 *   processors  re-run the outside services (after a failure).
 *   finalize    complete and redact the request if nothing is outstanding.
 *
 * The SQL scans large tables (email_send_log is millions of rows) so it runs
 * over a direct Postgres connection with its own timeouts. PostgREST's 8
 * second statement timeout would roll the erasure back halfway.
 */

import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { runProcessors, buildChecklist, isComplete } from '../lib/processors.js';

if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class {
    addEventListener() {} removeEventListener() {} close() {} send() {}
  };
}

const MATERIALIZED_VIEWS = ['engagement_scores_calendar', 'engagement_scores_global', 'newsletter_geo_rollup'];

function connectionString(): string {
  const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL is not set; the erasure worker needs a direct database connection');
  return url;
}

async function withClient(fn) {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '20min'");
    await client.query("SET lock_timeout = '30s'");
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function supabaseClient() {
  return createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const UPDATABLE = new Set([
  'plan_status', 'plan_error', 'execute_status', 'error_message', 'processors', 'checklist',
  'processors_ran_at', 'status', 'processing_completed_at',
]);

async function update(client, id, fields) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!UPDATABLE.has(k)) throw new Error(`compliance:erasure: refusing to update column ${k}`);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await client.query(`UPDATE public.compliance_privacy_requests SET ${sets} WHERE id = $1`,
    [id, ...keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]))]);
}

async function load(client, id) {
  const { rows } = await client.query('SELECT * FROM public.compliance_privacy_requests WHERE id = $1', [id]);
  return rows[0] ?? null;
}

function identifiers(row) {
  const i = row.identifiers ?? {};
  const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    emails: arr(i.emails),
    person_ids: arr(i.person_ids),
    auth_user_ids: arr(i.auth_user_ids),
    cio_ids: arr(i.cio_ids),
    slack_user_ids: arr(i.slack_user_ids),
  };
}

async function preview(client, id, actor, log) {
  // Claim: only one worker runs a queued preview.
  const claimed = await client.query(
    "UPDATE public.compliance_privacy_requests SET plan_status = 'running', plan_error = NULL WHERE id = $1 AND plan_status = 'queued' RETURNING previewed_by",
    [id]);
  if (claimed.rowCount === 0) return;
  actor = claimed.rows[0].previewed_by ?? actor;
  try {
    await client.query('SELECT public.compliance_erasure_preview($1, $2)', [id, actor]);
    log.info?.(`[compliance:erasure] preview ready for ${id}`);
  } catch (e) {
    await update(client, id, { plan_status: 'failed', plan_error: String(e.message ?? e).slice(0, 2000) });
    throw e;
  }
}

async function deleteAuthUsers(ids, log) {
  const results = [];
  if (!ids.auth_user_ids.length) return results;
  const supabase = supabaseClient();
  for (const uid of ids.auth_user_ids) {
    const { error } = await supabase.auth.admin.deleteUser(uid);
    const missing = error && /not found/i.test(error.message ?? '');
    results.push({ id: `auth:${uid}`, name: 'Sign-in account', status: error && !missing ? 'failed' : missing ? 'not_found' : 'erased', detail: error && !missing ? error.message : undefined, at: new Date().toISOString() });
    if (error && !missing) log.warn?.(`[compliance:erasure] auth user delete failed: ${error.message}`);
  }
  return results;
}

async function refreshViews(client, log) {
  for (const v of MATERIALIZED_VIEWS) {
    const { rows } = await client.query("SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS ok", [v]);
    if (!rows[0]?.ok) continue;
    try {
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.${v}`);
    } catch {
      // CONCURRENTLY needs a unique index; fall back to a plain refresh.
      try { await client.query(`REFRESH MATERIALIZED VIEW public.${v}`); } catch (e) { log.warn?.(`[compliance:erasure] refresh ${v} failed: ${e.message}`); }
    }
  }
}

async function processorsStep(client, id, log) {
  const row = await load(client, id);
  const ids = identifiers(row);
  const previous = Array.isArray(row.processors) ? row.processors : [];
  const keepAuth = previous.filter((p) => String(p.id).startsWith('auth:') && p.status !== 'failed');
  const auth = keepAuth.length && !previous.some((p) => String(p.id).startsWith('auth:') && p.status === 'failed')
    ? keepAuth
    : await deleteAuthUsers(ids, log);
  const external = await runProcessors(ids, process.env);
  const processors = [...auth, ...external];
  const existing = Array.isArray(row.checklist) ? row.checklist : [];
  const fresh = buildChecklist(row.plan, ids, processors);
  // Keep ticks on items that already existed.
  const checklist = fresh.map((item) => existing.find((e) => e.id === item.id) ?? item);
  await update(client, id, { processors, checklist, processors_ran_at: new Date().toISOString() });
}

async function finalize(client, id, log) {
  const row = await load(client, id);
  if (!row || row.redacted_at || row.execute_status !== 'erased') return;
  // Never complete (and so redact the identifiers) before the outside
  // services and auth deletion have run at least once.
  if (!row.processors_ran_at) return;
  const processors = Array.isArray(row.processors) ? row.processors : [];
  const checklist = Array.isArray(row.checklist) ? row.checklist : [];
  if (!isComplete(processors, checklist)) {
    log.debug?.(`[compliance:erasure] ${id} waiting on ${checklist.filter((c) => !c.done).length} manual step(s) or a failed processor`);
    return;
  }
  await client.query('BEGIN');
  try {
    await update(client, id, { status: 'completed', processing_completed_at: new Date().toISOString() });
    await client.query('SELECT public.compliance_privacy_request_redact($1)', [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  log.info?.(`[compliance:erasure] ${id} completed and redacted`);
}

async function execute(client, id, actor, log) {
  // Claim: a job and the sweep can both see the request; only one runs it.
  const claimed = await client.query(
    "UPDATE public.compliance_privacy_requests SET execute_status = 'running', error_message = NULL WHERE id = $1 AND execute_status = 'queued' RETURNING executed_by",
    [id]);
  if (claimed.rowCount === 0) return;
  actor = claimed.rows[0].executed_by ?? actor;
  await client.query('BEGIN');
  try {
    await client.query('SELECT public.compliance_erasure_execute($1, $2)', [id, actor]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    await update(client, id, { execute_status: 'failed', error_message: String(e.message ?? e).slice(0, 2000) });
    throw e;
  }
  log.info?.(`[compliance:erasure] database erasure committed for ${id}`);
  await refreshViews(client, log);
  await processorsStep(client, id, log);
  await finalize(client, id, log);
}

/**
 * Every minute: run anything still queued (the public API may have no job
 * queue), finish requests whose manual steps were ticked, and fail anything
 * a crashed worker left running. Each step claims its row, so overlapping
 * with a direct job is safe.
 */
async function sweep(client, log) {
  await client.query(
    "UPDATE public.compliance_privacy_requests SET execute_status = 'failed', error_message = 'The worker stopped during the erasure; the transaction was rolled back. Preview again and retry.' WHERE execute_status = 'running' AND updated_at < now() - interval '30 minutes'");
  await client.query(
    "UPDATE public.compliance_privacy_requests SET plan_status = 'failed', plan_error = 'The worker stopped while building the preview. Run it again.' WHERE plan_status = 'running' AND updated_at < now() - interval '30 minutes'");
  const { rows } = await client.query(
    `SELECT id, plan_status, execute_status, processors_ran_at FROM public.compliance_privacy_requests
      WHERE plan_status = 'queued' OR execute_status = 'queued'
         OR (execute_status = 'erased' AND redacted_at IS NULL)
      ORDER BY updated_at LIMIT 20`);
  for (const r of rows) {
    try {
      if (r.execute_status === 'queued') await execute(client, r.id, 'sweep', log);
      else if (r.plan_status === 'queued') await preview(client, r.id, 'sweep', log);
      else if (!r.processors_ran_at) { await processorsStep(client, r.id, log); await finalize(client, r.id, log); }
      else await finalize(client, r.id, log);
    } catch (e) {
      log.warn?.(`[compliance:erasure] sweep step failed for ${r.id}: ${e.message}`);
    }
  }
}

export default async function handler(job, ctx) {
  const log = ctx?.logger ?? console;
  const { requestId, action, actor } = job?.data ?? {};
  if (action === 'sweep') return withClient((client) => sweep(client, log));
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId ?? ''))) throw new Error('compliance:erasure: requestId (uuid) required');
  const who = String(actor ?? 'system').slice(0, 200);

  return withClient(async (client) => {
    switch (action) {
      case 'preview': return preview(client, requestId, who, log);
      case 'execute': return execute(client, requestId, who, log);
      case 'processors': await processorsStep(client, requestId, log); return finalize(client, requestId, log);
      case 'finalize': return finalize(client, requestId, log);
      default: throw new Error(`compliance:erasure: unknown action ${action}`);
    }
  });
}
