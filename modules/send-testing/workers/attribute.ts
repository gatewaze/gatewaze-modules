// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Attribution worker: claims a closed run's arrivals and materialises its
 * metrics.
 *
 * Attribution is post-facto on purpose. The receiver inserts arrivals blind, so
 * a message delayed past close by greylisting cannot be stamped onto whichever
 * run happens to be open when it finally lands. The trade is that this job has
 * to run after close — and be safe to run again later, once the stragglers are
 * in.
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import { computeRunResults } from '../lib/metrics';

const PAGE_SIZE = 1000;

interface AttributeJobData {
  kind: string;
  runId: string;
}

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('send-testing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Paged so a 25k-arrival run never asks PostgREST for one enormous response. */
async function fetchAllPages<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

export default async function handleAttribute(job: Job<AttributeJobData>): Promise<void> {
  const { runId } = job.data;
  const supabase = client();

  await supabase
    .from('send_test_runs')
    .update({ attribution_status: 'running', attribution_error: null })
    .eq('id', runId);

  try {
    const { data: run, error: runError } = await supabase
      .from('send_test_runs')
      .select('id, started_at, closed_at, expected_count')
      .eq('id', runId)
      .maybeSingle();
    if (runError) throw new Error(runError.message);
    if (!run) throw new Error(`run ${runId} not found`);

    // Claim in-window arrivals. Idempotent: only rows still unattributed match,
    // so a re-run folds in late stragglers without disturbing earlier ones.
    const { error: attributeError } = await supabase.rpc('send_test_attribute_run', {
      p_run_id: runId,
    });
    if (attributeError) throw new Error(attributeError.message);

    const endedAt = run.closed_at ?? new Date().toISOString();

    const arrivals = await fetchAllPages<{
      recipient_email: string;
      received_at: string;
      headers_meta: Record<string, unknown> | null;
    }>((from, to) =>
      supabase
        .from('send_test_arrivals')
        .select('recipient_email, received_at, headers_meta')
        .eq('run_id', runId)
        .order('received_at', { ascending: true })
        .range(from, to),
    );

    // Send-side timestamps for the same window. Absent for an external send,
    // which is why latency is allowed to come back null.
    const sendLog = await fetchAllPages<{
      recipient_email: string;
      sent_at: string | null;
      status: string | null;
    }>((from, to) =>
      supabase
        .from('email_send_log')
        .select('recipient_email, sent_at, status')
        .gte('created_at', run.started_at)
        .lte('created_at', endedAt)
        .like('recipient_email', 'st-%')
        .order('created_at', { ascending: true })
        .range(from, to),
    );

    const results = computeRunResults({
      arrivals,
      sendLog,
      expectedCount: run.expected_count ?? 0,
      startedAt: run.started_at,
      endedAt,
    });

    const { error: saveError } = await supabase
      .from('send_test_runs')
      .update({
        attribution_status: 'complete',
        attribution_error: null,
        metadata: { results, computed_at: new Date().toISOString() },
      })
      .eq('id', runId);
    if (saveError) throw new Error(saveError.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed attribution must be visible, not a silently missing metrics
    // block that reads as "nothing arrived".
    await supabase
      .from('send_test_runs')
      .update({ attribution_status: 'failed', attribution_error: message })
      .eq('id', runId);
    throw err;
  }
}
