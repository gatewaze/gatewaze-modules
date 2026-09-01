// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Provisioning worker: creates, deletes, or re-subscribes the synthetic test
 * population.
 *
 * Runs as a job rather than inline in the request because 25k people is ~50
 * chunked round-trips, well past any sane HTTP timeout. Progress is written to
 * the singleton send_test_provision_jobs row, which is what the admin panel
 * polls.
 *
 * supabase-js is imported statically: a bare-specifier dynamic import does not
 * resolve in the worker runtime.
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import { buildTestPeople } from '../lib/identity';

const PROVISION_CHUNK_SIZE = 500;
const SEND_TESTING_LIST_ID = '5e4d0000-0000-0000-0000-000000000001';

interface ProvisionJobData {
  kind: string;
  jobRowId: string;
  action: 'provision' | 'deprovision' | 'resubscribe';
  targetCount?: number | null;
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

async function loadConfig(supabase: ReturnType<typeof client>) {
  const { data } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', 'send-testing')
    .maybeSingle();
  const raw = (data?.config ?? {}) as Record<string, unknown>;

  const domain = String(raw.inbound_domain ?? '').trim().toLowerCase();
  if (!domain) {
    throw new Error('send-testing: inbound_domain is not configured; refusing to provision');
  }

  let distribution: Record<string, number> | undefined;
  const rawDist = raw.timezone_distribution;
  if (rawDist) {
    const parsed = typeof rawDist === 'string' ? JSON.parse(rawDist) : rawDist;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      distribution = parsed as Record<string, number>;
    }
  }
  return { domain, distribution };
}

async function finish(
  supabase: ReturnType<typeof client>,
  jobRowId: string,
  state: 'completed' | 'no_change' | 'failed',
  patch: Record<string, unknown> = {},
) {
  await supabase
    .from('send_test_provision_jobs')
    .update({ state, finished_at: new Date().toISOString(), ...patch })
    .eq('id', jobRowId);
}

export default async function handleProvision(job: Job<ProvisionJobData>): Promise<void> {
  const { jobRowId, action, targetCount } = job.data;
  const supabase = client();

  try {
    const { domain, distribution } = await loadConfig(supabase);

    if (action === 'deprovision') {
      const { data, error } = await supabase.rpc('send_test_deprovision', {
        p_domain: domain,
        p_keep_count: targetCount ?? null,
      });
      if (error) throw new Error(error.message);
      const deleted = Number((data as { deleted?: number })?.deleted ?? 0);
      await finish(supabase, jobRowId, 'completed', { processed: deleted });
      return;
    }

    if (action === 'resubscribe') {
      const { data, error } = await supabase.rpc('send_test_resubscribe', {
        p_domain: domain,
        p_list_id: SEND_TESTING_LIST_ID,
      });
      if (error) throw new Error(error.message);
      const restored = Number((data as { resubscribed?: number })?.resubscribed ?? 0);
      await finish(supabase, jobRowId, 'completed', { processed: restored });
      return;
    }

    // provision — top-up semantics: target_count is the desired TOTAL.
    const target = Number(targetCount ?? 0);
    if (!Number.isInteger(target) || target < 1) {
      throw new Error(`send-testing: invalid target_count ${targetCount}`);
    }

    const { data: countData, error: countError } = await supabase.rpc(
      'send_test_population_count',
      { p_domain: domain },
    );
    if (countError) throw new Error(countError.message);
    const current = Number(countData ?? 0);

    if (current >= target) {
      // An explicit outcome rather than a silent no-op, so the operator can
      // tell "already at size" from "nothing happened".
      await finish(supabase, jobRowId, 'no_change', { processed: 0 });
      return;
    }

    // Sequences are dense and start at 1, so the population size IS the highest
    // sequence in use and the top-up range continues from there.
    let processed = 0;
    for (let start = current + 1; start <= target; start += PROVISION_CHUNK_SIZE) {
      const end = Math.min(start + PROVISION_CHUNK_SIZE - 1, target);
      const rows = buildTestPeople(start, end, domain, distribution);

      const { error } = await supabase.rpc('send_test_provision_batch', {
        p_rows: rows,
        p_domain: domain,
        p_list_id: SEND_TESTING_LIST_ID,
      });
      if (error) {
        // Fail loudly with the position reached: because the RPC is idempotent
        // on email, re-running the same target simply resumes from here.
        throw new Error(`chunk ${start}-${end} failed: ${error.message}`);
      }

      processed += end - start + 1;
      await supabase
        .from('send_test_provision_jobs')
        .update({ processed })
        .eq('id', jobRowId);
    }

    await finish(supabase, jobRowId, 'completed', { processed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(supabase, jobRowId, 'failed', { last_error: message });
    // Rethrow so BullMQ records the failure; the singleton row already carries
    // the operator-facing reason.
    throw err;
  }
}
