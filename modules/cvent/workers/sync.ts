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

  // Each event gets an equal share of what is left of the budget, so one
  // event's backfill cannot starve the live events behind it. Start from a
  // different event each run so the same one is not always first.
  const offset = Math.floor(Date.now() / 60_000) % events.length;
  const ordered = [...events.slice(offset), ...events.slice(0, offset)];

  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    const now = Date.now();
    if (now > limits.deadline) break;
    const share = Math.floor((limits.deadline - now) / (ordered.length - i));
    const eventLimits = { ...limits, deadline: now + share };
    try {
      const pushed = await syncEvent(deps, event, eventLimits);
      const contacts = pushed.aborted || Date.now() > eventLimits.deadline ? null : await pushChangedContacts(deps, event, eventLimits);
      results.push({ event: event.event_id, ...pushed, contacts });
      if (pushed.attempted || contacts?.updated || pushed.aborted) {
        console.log(
          `[cvent] ${event.event_id}: ${pushed.created} created, ${pushed.alreadyExists} existed, ${pushed.failed} failed` +
            (contacts ? `, ${contacts.updated} contacts updated` : '') +
            (pushed.aborted ? ` (stopped: ${pushed.aborted})` : pushed.remaining ? ' (more pending)' : ''),
        );
      }
      // A Cvent-wide failure on one event will hit the others too; stop the run.
      if (pushed.aborted || contacts?.aborted) break;
    } catch (e) {
      console.error(`[cvent] ${event.event_id}: ${(e as Error).message}`);
      results.push({ event: event.event_id, error: (e as Error).message });
    }
  }

  return { events: events.length, ms: Date.now() - started, results };
}
