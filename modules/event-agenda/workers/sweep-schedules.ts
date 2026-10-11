// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-agenda:sweep-schedules — the nightly programme refresh
 * (spec-event-agenda-schedule-import §6.1).
 *
 * One global sweep rather than importing from inside each scraper: the
 * scrapers' job is to capture the schedule LINK as they already process an
 * event, and this owns the parsing, idempotency and edit-preservation for
 * every source. Otherwise each new source would duplicate all three.
 *
 * Off by default per brand (`auto_import_schedules`), because re-reading other
 * people's sites on a timer is a decision an operator should make knowingly.
 */

const BATCH = Number(process.env.EVENT_AGENDA_SWEEP_BATCH ?? 25);

/** Is the nightly sweep switched on for this brand? */
async function sweepEnabled(supabase): Promise<boolean> {
  const row = await supabase
    .from('installed_modules').select('config').eq('slug', 'event-agenda').maybeSingle();
  return row?.data?.config?.auto_import_schedules === true;
}

/**
 * Events worth looking at tonight.
 *
 * The date window is deliberately wider than the original spec's
 * [-14 d, +120 d]: AGNTCon ran 23 days before its recap was built, so the very
 * conference being written up fell outside it. Anything with a linked recap or
 * an unfinished import is included regardless of date, so a past conference
 * someone is actively working on is never skipped.
 */
export async function sweepCandidates(supabase, now: Date = new Date()): Promise<string[]> {
  const from = new Date(now.getTime() - 30 * 864e5).toISOString();
  const to = new Date(now.getTime() + 180 * 864e5).toISOString();

  const inWindow = await supabase
    .from('events').select('id')
    .eq('event_type', 'conference')
    .gte('event_start', from).lte('event_start', to);

  const withRecap = await supabase
    .from('conference_recaps').select('event_id').not('event_id', 'is', null);

  const unfinished = await supabase
    .from('events_schedule_imports').select('event_uuid')
    .in('status', ['pending', 'unavailable', 'failed']);

  const ids = new Set<string>();
  for (const r of inWindow?.data ?? []) ids.add(r.id);
  for (const r of withRecap?.data ?? []) if (r.event_id) ids.add(r.event_id);
  for (const r of unfinished?.data ?? []) ids.add(r.event_uuid);
  return [...ids];
}

export default async function sweepSchedulesHandler(_job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-agenda] ${m}`);

  if (!(await sweepEnabled(supabase))) {
    log('schedule sweep is off for this brand (auto_import_schedules)');
    return;
  }

  const candidates = await sweepCandidates(supabase);
  if (candidates.length === 0) { log('schedule sweep: nothing in range'); return; }

  // Bounded per night, oldest-attempted first, so a large backlog drains over
  // several nights instead of hammering the sources in one burst (§5.4).
  const order = await supabase
    .from('events_schedule_imports')
    .select('event_uuid, last_attempt_at')
    .in('event_uuid', candidates)
    .order('last_attempt_at', { ascending: true, nullsFirst: true });
  const ranked = (order?.data ?? []).map((r) => r.event_uuid);
  const never = candidates.filter((id) => !ranked.includes(id));
  const batch = [...never, ...ranked].slice(0, BATCH);

  const { importSchedule } = await import('./import-schedule.js');
  let complete = 0; let unavailable = 0; let failed = 0;
  for (const eventUuid of batch) {
    const res = await importSchedule(supabase, eventUuid, { log: () => {} });
    if (res.status === 'complete') complete++;
    else if (res.status === 'unavailable') unavailable++;
    else if (res.status === 'failed') failed++;
    await new Promise((r) => setTimeout(r, 1000)); // §5.4 pacing
  }
  log(`schedule sweep: ${batch.length} event(s) — ${complete} complete, ${unavailable} unavailable, ${failed} failed (${candidates.length} in scope)`);
}
