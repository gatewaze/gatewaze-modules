// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-agenda:mirror-avatars — copy already-imported avatars into our bucket.
 *
 * The importer now mirrors as it goes, but the profiles imported before that
 * still point at the conference's CDN. On the AGNTcon EU programme that is 111
 * speakers whose faces live on avatars.sched.co, which is both a privacy leak
 * for every agenda visitor and a dead image the day sched takes the event
 * site down.
 *
 * This walks those rows and rewrites avatar_url to our own copy. It is the one
 * place in the importer that deliberately overwrites an existing value, so the
 * conditions are narrow:
 *
 *   - the current value must be an allowlisted remote URL, so a bare storage
 *     path from the promo flow and a data: URI are both left alone;
 *   - it must not already be one of ours;
 *   - the copy must have succeeded, with bytes that sniff as a raster image.
 *
 * Anything else is skipped and counted. Nothing is deleted, and a row whose
 * copy fails keeps the URL it had.
 */

import {
  AVATAR_HOST_ALLOWLIST,
  isMirroredAvatarUrl,
  listMirroredAvatars,
  mirrorAvatar,
  type MirrorDeps,
} from '../lib/avatar-mirror.js';
import { safeAvatarUrl } from '../lib/import-safety.js';

/** Rows per run. One run of 200 avatars at ~90KB each is about 18MB. */
const DEFAULT_LIMIT = 200;

/** Stop fetching past this much in one run, whatever the row count says. */
const BYTE_BUDGET = 64 * 1024 * 1024;

export interface MirrorAvatarsResult {
  considered: number;
  mirrored: number;
  reused: number;
  skipped: number;
  bytes: number;
  /** Reason → count, so a run that does nothing says why. */
  reasons: Record<string, number>;
}

export async function mirrorAvatarsForProfiles(
  supabase,
  opts: {
    eventUuid?: string | null;
    limit?: number;
    dryRun?: boolean;
    log?: (m: string) => void;
    allowlist?: string[];
    /** Injected by the tests so no suite reaches the network. */
    fetchBytes?: MirrorDeps['fetchBytes'];
  } = {},
): Promise<MirrorAvatarsResult> {
  const log = opts.log ?? (() => {});
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || DEFAULT_LIMIT));
  const allowlist = opts.allowlist ?? AVATAR_HOST_ALLOWLIST;
  const out: MirrorAvatarsResult = {
    considered: 0, mirrored: 0, reused: 0, skipped: 0, bytes: 0, reasons: {},
  };
  const note = (reason: string) => {
    out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
    out.skipped += 1;
  };

  // Candidate rows. `avatar_url like 'http%'` is pushed into the query so a
  // run on a brand with 40,000 profiles does not read all of them to find the
  // handful that are hot-linked.
  let profileIds: string[] | null = null;
  if (opts.eventUuid) {
    const att = await supabase
      .from('events_speakers')
      .select('speaker_id')
      .eq('event_uuid', opts.eventUuid);
    if (att.error) throw new Error(`could not list the event's speakers: ${att.error.message}`);
    profileIds = [...new Set((att.data ?? []).map((r) => r.speaker_id).filter(Boolean))];
    if (profileIds.length === 0) {
      log('no speakers attached to that event');
      return out;
    }
  }

  let q = supabase
    .from('events_speaker_profiles')
    .select('id, name, avatar_url')
    .like('avatar_url', 'http%')
    .limit(limit);
  if (profileIds) q = q.in('id', profileIds);
  const { data: rows, error } = await q;
  if (error) throw new Error(`could not list profiles: ${error.message}`);
  if (!rows?.length) {
    log('nothing to mirror');
    return out;
  }

  const existing = await listMirroredAvatars({ supabase });
  log(`${rows.length} profile(s) with a remote avatar; ${existing.size} already in the bucket`);

  for (const row of rows) {
    out.considered += 1;

    if (isMirroredAvatarUrl(row.avatar_url)) { note('already_ours'); continue; }
    if (!safeAvatarUrl(row.avatar_url, allowlist)) { note('host_not_allowlisted'); continue; }
    if (out.bytes >= BYTE_BUDGET) { note('byte_budget_reached'); continue; }

    const copied = await mirrorAvatar(
      { supabase, log, existing, allowlist, ...(opts.fetchBytes && { fetchBytes: opts.fetchBytes }) },
      row.avatar_url,
    );
    if (!copied || !copied.storagePath) { note(copied?.skippedReason ?? 'not_usable'); continue; }

    // The object is in the bucket either way, so remember it for the rest of
    // the run even if the row update below turns out to be a no-op.
    if (!copied.reused) {
      out.bytes += copied.bytes;
      existing.add(copied.storagePath.slice(copied.storagePath.lastIndexOf('/') + 1));
    }

    if (opts.dryRun) {
      if (copied.reused) out.reused += 1; else out.mirrored += 1;
      continue;
    }

    // Conditional on the value we read. Two runs overlapping, or a human
    // editing the avatar between the read and the write, must not have their
    // change overwritten by a copy of the URL they replaced.
    //
    // `.select('id')` so a no-op is visible. Without it a CAS that matched
    // nothing returns no error and the run would report a row as copied when
    // it wrote nothing, which is the "report a number you did not achieve"
    // failure the snapshot tables elsewhere avoid with status='no_data'.
    const upd = await supabase
      .from('events_speaker_profiles')
      .update({ avatar_url: copied.url })
      .eq('id', row.id)
      .eq('avatar_url', row.avatar_url)
      .select('id');
    if (upd.error) {
      log(`could not update ${row.name}: ${upd.error.message}`);
      note('update_failed');
      continue;
    }
    if (!upd.data?.length) {
      // Someone else got there first between the read and the write.
      note('changed_underneath');
      continue;
    }
    if (copied.reused) out.reused += 1; else out.mirrored += 1;
  }

  log(
    `mirror-avatars: ${out.mirrored} copied, ${out.reused} already held, ${out.skipped} skipped` +
    `${out.bytes ? `, ${(out.bytes / 1048576).toFixed(1)}MB fetched` : ''}` +
    `${opts.dryRun ? ' (dry run, nothing written)' : ''}`,
  );
  return out;
}

export default async function mirrorAvatarsHandler(job, ctx): Promise<MirrorAvatarsResult> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-agenda] ${m}`);
  const data = job?.data ?? {};
  return mirrorAvatarsForProfiles(supabase, {
    eventUuid: data.event_uuid ?? null,
    limit: data.limit,
    dryRun: data.dry_run === true,
    log,
  });
}
