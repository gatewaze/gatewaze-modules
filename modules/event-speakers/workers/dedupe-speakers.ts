// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-speakers:dedupe-speakers — merge duplicate speaker profiles.
 *
 * Runs four passes, strongest key first, re-reading live profiles each time so
 * a merge in one pass is visible to the next:
 *
 *   1. sched account id   — issued by sched, outranks the name
 *   2. email              — issued by a mail system
 *   3. LinkedIn slug      — chosen by the person
 *   4. name               — only merged with corroboration, else queued
 *
 * Passes are deliberately NOT unioned into connected components. If A and B
 * share a name and B and C share a LinkedIn URL, treating that as one group
 * merges A with C on no evidence at all. Keeping the passes separate means the
 * worst case is a duplicate that survives to the next run, rather than two
 * strangers fused together.
 *
 * `dry_run` is the default for a reason: the first real run on AAIF prod will
 * touch roughly 170 groups, and the operator should read the plan first.
 */

import { serviceClient } from '../lib/promo/service-client.js';
import { decideGroup, type ProfileRow } from '../lib/dedupe/decide.js';
import { linkedinSlug, nameKey, schedUserId } from '../lib/dedupe/keys.js';

const COLUMNS =
  'id, name, email, title, company, linkedin_url, avatar_url, source_avatar_url, ' +
  'sched_user_id, enrichment_source, person_id, canonical_profile_id, created_at';

/** Rows per page out of PostgREST, which caps a response well below 6,000. */
const PAGE = 1000;

export interface DedupeResult {
  passes: Record<string, { groups: number; merged: number; queued: number }>;
  merged: number;
  queued: number;
  skipped: number;
  errors: string[];
  dry_run: boolean;
}

type KeyFn = (r: ProfileRow) => string | null;

const PASSES: Array<{ name: string; key: KeyFn }> = [
  { name: 'sched_user_id', key: (r) => r.sched_user_id ?? schedUserId(r.source_avatar_url) ?? schedUserId(r.avatar_url) },
  { name: 'email', key: (r) => { const e = (r.email ?? '').trim().toLowerCase(); return e.includes('@') ? e : null; } },
  { name: 'linkedin', key: (r) => linkedinSlug(r.linkedin_url) },
  { name: 'name', key: (r) => nameKey(r.name) || null },
];

/** Every live profile, paged. */
async function liveProfiles(supabase, log): Promise<ProfileRow[]> {
  const out: ProfileRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('events_speaker_profiles')
      .select(COLUMNS)
      .is('canonical_profile_id', null)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`profile read failed: ${error.message}`);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  log(`${out.length} live profiles`);
  return out;
}

/**
 * Attach an event count so pickCanonical prefers the profile that already
 * carries the most speaking history. One grouped read, not one per profile.
 */
async function withEventCounts(supabase, rows: ProfileRow[]): Promise<ProfileRow[]> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += PAGE * 5) {
    const { data, error } = await supabase
      .from('events_speakers')
      .select('speaker_id')
      .order('speaker_id')
      .range(from, from + PAGE * 5 - 1);
    if (error) break; // counts are an ordering nicety, not correctness
    const batch = data ?? [];
    for (const r of batch) {
      if (r?.speaker_id) counts.set(r.speaker_id, (counts.get(r.speaker_id) ?? 0) + 1);
    }
    if (batch.length < PAGE * 5) break;
  }
  return rows.map((r) => ({ ...r, event_count: counts.get(r.id) ?? 0 }));
}

/** A stable key for a group, so one open candidate per group is enforceable. */
function groupKey(pass: string, key: string, ids: string[]): string {
  return `${pass}:${key}:${[...ids].sort().join(',')}`;
}

export async function dedupeSpeakers(
  supabase,
  opts: { dryRun?: boolean; log?: (m: string) => void; limit?: number; actor?: string | null } = {},
): Promise<DedupeResult> {
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun !== false; // default ON
  const maxMerges = Math.max(1, Math.min(5000, Number(opts.limit) || 5000));
  const out: DedupeResult = { passes: {}, merged: 0, queued: 0, skipped: 0, errors: [], dry_run: dryRun };

  for (const pass of PASSES) {
    const stat = { groups: 0, merged: 0, queued: 0 };
    out.passes[pass.name] = stat;

    // Re-read every pass: a merge in an earlier pass removes rows from play.
    const rows = await withEventCounts(supabase, await liveProfiles(supabase, () => {}));

    const groups = new Map<string, ProfileRow[]>();
    for (const r of rows) {
      const k = pass.key(r);
      if (!k) continue;
      const list = groups.get(k);
      if (list) list.push(r); else groups.set(k, [r]);
    }

    for (const [key, members] of groups) {
      if (members.length < 2) continue;
      stat.groups += 1;
      const decision = decideGroup(members);

      if (decision.action === 'skip') { out.skipped += 1; continue; }

      if (decision.action === 'review') {
        const gk = groupKey(pass.name, key, members.map((m) => m.id));
        if (!dryRun) {
          // Read then insert, NOT an upsert.
          //
          // Two reasons, and the first one is why the queue silently stayed
          // empty on the first real run. The unique index on group_key is
          // PARTIAL (WHERE state = 'open'), and `ON CONFLICT (group_key)`
          // cannot match a partial index without repeating its predicate,
          // which PostgREST has no way to express. Every upsert failed with
          // "no unique or exclusion constraint matching the ON CONFLICT
          // specification", and 351 candidates went nowhere.
          //
          // The second reason is behavioural and is why this is the right
          // shape rather than a workaround: an upsert that sets state:'open'
          // would reopen a group a human had already marked as different
          // people, every single sweep. A group that has been decided stays
          // decided.
          const { data: already, error: readErr } = await supabase
            .from('speaker_merge_candidates')
            .select('id, state')
            .eq('group_key', gk)
            .maybeSingle();
          if (readErr) {
            out.errors.push(`queue read ${gk}: ${readErr.message}`);
            continue;
          }
          if (already) { out.skipped += 1; continue; }

          const { error } = await supabase.from('speaker_merge_candidates').insert({
            profile_ids: [...members.map((m) => m.id)].sort(),
            group_key: gk,
            canonical_id: decision.canonicalId,
            rule: decision.rule,
            reason: decision.reason,
            score: decision.score,
            signals: decision.signals,
            state: 'open',
          });
          // ONLY a genuine duplicate-key violation is benign — another worker
          // queued the same group between the read and the insert. Matching
          // on the loose word "unique" is what let the real failure above
          // pass as routine.
          if (error && error.code !== '23505') {
            out.errors.push(`queue ${gk}: ${error.message}`);
            continue;
          }
        }
        stat.queued += 1;
        out.queued += 1;
        continue;
      }

      // merge
      if (out.merged >= maxMerges) { log(`merge limit ${maxMerges} reached`); break; }
      if (dryRun) {
        log(`WOULD MERGE [${decision.rule}] ${decision.aliasIds.length} alias(es) into ${decision.canonicalId} — ${decision.reason}`);
        stat.merged += decision.aliasIds.length;
        out.merged += decision.aliasIds.length;
        continue;
      }
      for (const aliasId of decision.aliasIds) {
        const { error } = await supabase.rpc('merge_speaker_profiles', {
          p_canonical: decision.canonicalId,
          p_alias: aliasId,
          p_rule: decision.rule,
          p_reason: decision.reason,
          p_signals: decision.signals,
          p_actor: opts.actor ?? null,
        });
        if (error) {
          out.errors.push(`merge ${aliasId} -> ${decision.canonicalId}: ${error.message}`);
          continue;
        }
        stat.merged += 1;
        out.merged += 1;
      }
    }

    log(`pass ${pass.name}: ${stat.groups} group(s), ${stat.merged} merged, ${stat.queued} queued`);
  }

  log(
    `dedupe-speakers: ${out.merged} merged, ${out.queued} queued for review` +
    `${out.errors.length ? `, ${out.errors.length} error(s)` : ''}` +
    `${dryRun ? ' (DRY RUN — nothing written)' : ''}`,
  );
  return out;
}

export default async function dedupeSpeakersHandler(job, ctx): Promise<DedupeResult> {
  // serviceClient(), not a dynamic import of supabase-js. A dynamic
  // `await import('@supabase/supabase-js')` from a module file resolves
  // against the package's exports map and fails in the worker with
  // "Did you mean to import .../dist/index.cjs?", while the static import
  // inside service-client.ts resolves fine. This is also the module's own
  // existing convention, so there is one place that builds the client.
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-speakers] ${m}`);
  const data = job?.data ?? {};
  return dedupeSpeakers(supabase, {
    // Explicit opt-in to writing. A job enqueued without the flag plans only.
    dryRun: data.dry_run !== false,
    limit: data.limit,
    actor: data.actor ?? null,
    log,
  });
}
