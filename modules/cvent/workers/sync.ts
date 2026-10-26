// @ts-nocheck — bullmq/supabase types are resolved at module-host install time.
/**
 * Every minute: push new registrations for Cvent-enabled events, then re-push
 * badge fields for people who changed since their last sync.
 *
 * Each run has a time budget (50s by default) and a per-event batch size, so
 * a large backfill is spread over several runs instead of holding a worker
 * slot. Everything it does is idempotent through the ledger table; re-running
 * continues where the last run stopped.
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import { createCventClient } from '../lib/cvent-api.js';
import { loadModuleConfig, parseCredentials, parseSyncSettings } from '../lib/config.js';
import { listSyncEnabledEvents, pushChangedContacts, syncEvent } from '../lib/sync.js';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('cvent: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export default async function handleSync(_job: Job) {
  const started = Date.now();
  const db = client();

  const raw = await loadModuleConfig(db);
  const creds = parseCredentials(raw);
  if (!creds) {
    return { skipped: 'CVENT_CLIENT_ID / CVENT_CLIENT_SECRET are not configured' };
  }
  const settings = parseSyncSettings(raw);
  const limits = {
    deadline: started + settings.budgetMs,
    batchSize: settings.batchSize,
    maxAttempts: settings.maxAttempts,
    pauseMs: settings.pauseMs,
  };

  const events = await listSyncEnabledEvents(db);
  if (events.length === 0) return { events: 0 };

  const cvent = createCventClient({ ...creds, log: (m) => console.log(`[cvent] ${m}`) });
  const deps = { db, cvent, log: (m: string) => console.warn(m) };
  const results = [];

  for (const event of events) {
    if (Date.now() > limits.deadline) break;
    try {
      const pushed = await syncEvent(deps, event, limits);
      const contacts = Date.now() > limits.deadline ? null : await pushChangedContacts(deps, event, limits);
      results.push({ event: event.event_id, ...pushed, contacts });
      if (pushed.attempted || contacts?.updated) {
        console.log(
          `[cvent] ${event.event_id}: ${pushed.created} created, ${pushed.alreadyExists} existed, ${pushed.failed} failed` +
            (contacts ? `, ${contacts.updated} contacts updated` : '') +
            (pushed.remaining ? ' (more pending)' : ''),
        );
      }
    } catch (e) {
      console.error(`[cvent] ${event.event_id}: ${(e as Error).message}`);
      results.push({ event: event.event_id, error: (e as Error).message });
    }
  }

  return { events: events.length, ms: Date.now() - started, results };
}
