/**
 * BullMQ handler for content-keywords:recompute.
 *
 * Picks up pending recompute jobs, acquires per-content-type lease,
 * iterates the adapter table by (created_at, id) batches, calls
 * ck_evaluate_item per row, updates progress + heartbeat. Releases
 * lease on completion/failure.
 */

import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[ck:recompute] missing SUPABASE env');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

const BATCH_SIZE = 1000;

export default async function handler(job) {
  const sb = supabase();

  // Worker may be invoked with a specific job_id, or to scan for pending jobs.
  const jobId = job?.data?.job_id ?? null;

  let pendingJobs;
  if (jobId) {
    const { data, error } = await sb
      .from('content_keyword_recompute_jobs')
      .select('*')
      .eq('id', jobId)
      .in('status', ['pending', 'running'])
      .limit(1);
    if (error) throw error;
    pendingJobs = data ?? [];
  } else {
    const { data, error } = await sb
      .from('content_keyword_recompute_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);
    if (error) throw error;
    pendingJobs = data ?? [];
  }

  for (const j of pendingJobs) {
    await runRecompute(sb, j);
  }

  return { jobs_processed: pendingJobs.length };
}

async function runRecompute(sb, job) {
  const contentTypes = job.content_types ?? [];
  if (contentTypes.length === 0) {
    await markJob(sb, job.id, 'failed', { error_message: 'no_content_types' });
    return;
  }

  await markJob(sb, job.id, 'running', { started_at: new Date().toISOString() });

  let totalProcessed = job.rows_processed ?? 0;
  let errors = 0;
  let processedSinceCheckpoint = 0;

  try {
    for (const ct of contentTypes) {
      const acquired = await acquireLease(sb, ct, job.id);
      if (!acquired) {
        await markJob(sb, job.id, 'failed', { error_message: `lease_contention:${ct}` });
        return;
      }

      const { data: adapterRow, error: adapterErr } = await sb
        .from('content_keyword_adapters')
        .select('table_name,created_at_column')
        .eq('content_type', ct)
        .single();
      if (adapterErr) throw adapterErr;
      const tableName = adapterRow.table_name;
      const createdCol = adapterRow.created_at_column;

      let cursorCreatedAt = job.last_processed_created_at;
      let cursorId = job.last_processed_id;

      while (true) {
        // Fetch a batch ordered by (created_at, id).
        let q = sb.from(tableName).select(`id,${createdCol}`).order(createdCol, { ascending: true }).order('id', { ascending: true }).limit(BATCH_SIZE);
        if (cursorCreatedAt && cursorId) {
          q = q.or(`${createdCol}.gt.${cursorCreatedAt},and(${createdCol}.eq.${cursorCreatedAt},id.gt.${cursorId})`);
        }
        const { data: batch, error: batchErr } = await q;
        if (batchErr) throw batchErr;
        if (!batch || batch.length === 0) break;

        for (const row of batch) {
          try {
            const { error: evalErr } = await sb.rpc('ck_evaluate_item', {
              p_content_type: ct,
              p_content_id: row.id,
            });
            if (evalErr) throw evalErr;
          } catch (err) {
            errors++;
          }
          totalProcessed++;
          processedSinceCheckpoint++;
          cursorCreatedAt = row[createdCol];
          cursorId = row.id;
        }

        // Heartbeat + checkpoint every batch.
        await sb.from('content_keyword_recompute_jobs').update({
          rows_processed: totalProcessed,
          last_processed_created_at: cursorCreatedAt,
          last_processed_id: cursorId,
          heartbeat_at: new Date().toISOString(),
        }).eq('id', job.id);
        await renewLease(sb, ct, job.id);

        if (batch.length < BATCH_SIZE) break;
      }

      await releaseLease(sb, ct, job.id);
    }

    const finalStatus = errors > totalProcessed * 0.01 && totalProcessed > 100 ? 'complete_with_errors' : 'complete';
    await markJob(sb, job.id, finalStatus, { finished_at: new Date().toISOString(), rows_processed: totalProcessed });
  } catch (err) {
    for (const ct of contentTypes) {
      try { await releaseLease(sb, ct, job.id); } catch {}
    }
    await markJob(sb, job.id, 'failed', {
      finished_at: new Date().toISOString(),
      error_message: String(err?.message ?? err).slice(0, 1000),
    });
    throw err;
  }
}

async function markJob(sb, id, status, extras = {}) {
  await sb.from('content_keyword_recompute_jobs').update({ status, ...extras }).eq('id', id);
}

async function acquireLease(sb, contentType, jobId) {
  const { data, error } = await sb.rpc('ck_acquire_recompute_lease', {
    p_content_type: contentType,
    p_job_id: jobId,
  });
  if (error) throw error;
  return data === true;
}

async function renewLease(sb, contentType, jobId) {
  await sb.rpc('ck_renew_recompute_lease', { p_content_type: contentType, p_job_id: jobId });
}

async function releaseLease(sb, contentType, jobId) {
  await sb.rpc('ck_release_recompute_lease', { p_content_type: contentType, p_job_id: jobId });
}
