// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:publish-due — move scheduled publications into the publish queue
 * (spec §19).
 *
 * Runs every minute. Claims rows whose `scheduled_for` has passed and moves
 * them to `queued`, where the per-platform publisher picks them up.
 *
 * Three rules, each from how this fails rather than from how it works:
 *
 * A missed window publishes LATE, never silently. If the worker was down for
 * an hour, a schedule from 40 minutes ago still goes, and the row records how
 * late it was in `published_late_by_seconds`. Dropping it would be worse: the
 * editor believes it went out and nobody finds out until someone looks.
 *
 * The claim is a conditional UPDATE, not a read-then-write. Two overlapping
 * ticks must not both queue the same row, and the only way to be sure of that
 * without a lock is to make the state transition itself the claim.
 *
 * There is no publisher yet. Until `videos-publisher-*` ships, a queued row
 * sits in `queued` and the log says so explicitly, because a scheduler that
 * silently queues into nothing looks identical to one that is working.
 */

/** Rows per tick. A minute is plenty for this many, and it bounds a backlog. */
const BATCH = 25;

/**
 * How late is too late to still publish.
 *
 * Seven days. Past that, a schedule is stale enough that publishing it would
 * surprise somebody more than skipping it, so it goes to `failed` with the
 * reason recorded rather than appearing on a channel a week after it was
 * meant to.
 */
const MAX_LATE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PublishDueResult {
  claimed: number;
  aged_out: number;
  late: number;
}

export async function publishDue(
  supabase,
  log: (m: string) => void = () => {},
  now: Date = new Date(),
): Promise<PublishDueResult> {
  const nowIso = now.toISOString();

  const { data: due, error } = await supabase
    .from('video_publications')
    .select('id, video_id, platform, scheduled_for, requested_visibility')
    .eq('state', 'scheduled')
    .lte('scheduled_for', nowIso)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH);
  if (error) {
    log(`due query failed: ${error.message}`);
    return { claimed: 0, aged_out: 0, late: 0 };
  }
  if (!due?.length) return { claimed: 0, aged_out: 0, late: 0 };

  let claimed = 0;
  let agedOut = 0;
  let late = 0;

  for (const row of due) {
    const scheduledMs = Date.parse(row.scheduled_for ?? '') || now.getTime();
    const lateByMs = now.getTime() - scheduledMs;

    if (lateByMs > MAX_LATE_MS) {
      // Conditional on state so a concurrent tick cannot double-handle it.
      const { data: aged } = await supabase
        .from('video_publications')
        .update({
          state: 'failed',
          last_error: `missed its window by ${Math.round(lateByMs / 86_400_000)} day(s); not published`,
          last_error_kind: 'rejected',
          updated_at: nowIso,
        })
        .eq('id', row.id)
        .eq('state', 'scheduled')
        .select('id');
      if (aged?.length) agedOut += 1;
      continue;
    }

    const { data: got, error: claimErr } = await supabase
      .from('video_publications')
      .update({
        state: 'queued',
        // Recorded even when zero, so "was this on time?" is answerable from
        // the row rather than from the logs.
        published_late_by_seconds: Math.max(0, Math.round(lateByMs / 1000)),
        updated_at: nowIso,
      })
      .eq('id', row.id)
      .eq('state', 'scheduled')
      .select('id');
    if (claimErr) {
      log(`could not claim ${row.id}: ${claimErr.message}`);
      continue;
    }
    // Empty means another tick claimed it first. That is the design working.
    if (!got?.length) continue;

    claimed += 1;
    if (lateByMs > 120_000) late += 1;
  }

  if (claimed || agedOut) {
    log(
      `publish-due: ${claimed} queued${late ? ` (${late} late)` : ''}` +
      `${agedOut ? `, ${agedOut} aged out past the 7-day cutoff` : ''}`,
    );
  }
  if (claimed) {
    log(
      'publish-due: queued rows are waiting for a platform publisher. ' +
      'None is installed yet (videos-publisher-* is unbuilt), so they will ' +
      'stay in `queued` until one ships.',
    );
  }

  return { claimed, aged_out: agedOut, late };
}

export default async function publishDueHandler(_job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);
  await publishDue(supabase, log);
}
