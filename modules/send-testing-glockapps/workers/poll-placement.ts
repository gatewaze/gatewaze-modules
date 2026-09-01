// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Polls GlockApps for placement results on runs that have an active test.
 *
 * Runs on a cron rather than being triggered once, because seed mailboxes
 * classify a message over minutes-to-hours: there is no single moment when the
 * answer is ready. Polling stops on completion, on a plan/auth rejection (which
 * retrying cannot fix), or once a run is old enough that nothing more is
 * coming.
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import {
  GlockAppsAccessError,
  fetchTestResults,
  loadConfig,
} from '../lib/glockapps';

const MAX_POLL_AGE_HOURS = 24;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('send-testing-glockapps: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export default async function handlePollPlacement(_job: Job): Promise<void> {
  const supabase = client();
  const config = await loadConfig(supabase);

  if (!config.apiKey) {
    // Manual mode. Nothing to poll, and this is a normal steady state rather
    // than a misconfiguration, so it must not throw and retry.
    return;
  }

  const { data: tests, error } = await supabase
    .from('send_test_placement_tests')
    .select('id, run_id, glockapps_test_id, created_at')
    .eq('state', 'polling');

  if (error) throw new Error(error.message);
  if (!tests || tests.length === 0) return;

  for (const test of tests) {
    const ageHours = (Date.now() - Date.parse(test.created_at)) / 3_600_000;
    if (ageHours > MAX_POLL_AGE_HOURS) {
      await supabase
        .from('send_test_placement_tests')
        .update({ state: 'stopped', last_polled_at: new Date().toISOString() })
        .eq('id', test.id);
      continue;
    }

    try {
      const result = await fetchTestResults(config, test.glockapps_test_id);

      if (result.providers.length > 0) {
        const rows = result.providers.map((provider) => ({
          run_id: test.run_id,
          glockapps_test_id: test.glockapps_test_id,
          provider: provider.provider,
          inbox: provider.inbox,
          tabs: provider.tabs,
          spam: provider.spam,
          missing: provider.missing,
          entered_via: 'api',
          raw: result.raw as Record<string, unknown>,
          fetched_at: new Date().toISOString(),
        }));

        // API results overwrite manual entry for the same (run, provider):
        // the paste-in form is a fallback, not a competing source.
        const { error: upsertError } = await supabase
          .from('send_test_placement_reports')
          .upsert(rows, { onConflict: 'run_id,provider' });
        if (upsertError) throw new Error(upsertError.message);
      }

      await supabase
        .from('send_test_placement_tests')
        .update({
          state: result.complete ? 'complete' : 'polling',
          last_polled_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', test.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof GlockAppsAccessError) {
        // Terminal for this plan. Stop polling and let the panel offer manual
        // entry rather than retrying every ten minutes forever.
        await supabase
          .from('send_test_placement_tests')
          .update({ state: 'failed', last_error: message, last_polled_at: new Date().toISOString() })
          .eq('id', test.id);
        console.warn(`[send-testing-glockapps] access denied for test ${test.glockapps_test_id}: ${message}`);
        continue;
      }

      // Transient: record it and let the next tick retry. One failing test must
      // not abort the others in this batch.
      await supabase
        .from('send_test_placement_tests')
        .update({ last_error: message, last_polled_at: new Date().toISOString() })
        .eq('id', test.id);
      console.warn(`[send-testing-glockapps] poll failed for test ${test.glockapps_test_id}: ${message}`);
    }
  }
}
