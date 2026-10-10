// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * event-agenda:import-schedule — the programme importer
 * (spec-event-agenda-schedule-import §6.2).
 *
 * Reads a conference's published schedule and writes it into the agenda and
 * speaker tables that already exist, idempotently. Everything it creates is
 * tracked in events_schedule_import_refs, so a second run adopts rather than
 * duplicates, and a field a human has since edited is left alone (§6.3).
 *
 * It never deletes. A session that disappears from the source is reported in
 * stats.stale and left in place, because an operator may be relying on it.
 */

import { createHash } from 'node:crypto';
import { detectSource } from '../lib/schedule-sources/index.js';
import { guardedFetch, clean, safeAvatarUrl, LIMITS, FetchRefused, DEFAULT_HOST_ALLOWLIST } from '../lib/import-safety.js';
import { normalizeTitle } from '../lib/normalize-title.js';

const STALE_CLAIM_MS = 15 * 60 * 1000;
// Separator for the content hash: a byte that cannot occur in the fetched
// text. Built at runtime so the source file stays pure ASCII.
const HASH_SEP = String.fromCharCode(0);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Hash of the source-owned fields we last wrote, for edit preservation. */
function fingerprint(fields: Record<string, unknown>): string {
  return sha256(JSON.stringify(fields, Object.keys(fields).sort()));
}

/**
 * Resolve where this event's programme comes from (§5.1), first hit wins.
 * `overrideUrl` is the recap's schedule_url_override when invoked from a recap.
 */
export async function resolveScheduleUrl(
  supabase,
  eventUuid: string,
  overrideUrl?: string | null,
): Promise<{ url: string; origin: 'event' | 'manual' } | null> {
  if (overrideUrl) return { url: String(overrideUrl), origin: 'manual' };

  const imp = await supabase
    .from('events_schedule_imports')
    .select('schedule_url, url_origin')
    .eq('event_uuid', eventUuid)
    .maybeSingle();
  if (imp?.data?.url_origin === 'manual' && imp.data.schedule_url) {
    return { url: imp.data.schedule_url, origin: 'manual' };
  }

  const ev = await supabase.from('events').select('source_details').eq('id', eventUuid).maybeSingle();
  const fromEvent = ev?.data?.source_details?.action_links?.schedule;
  if (fromEvent) return { url: String(fromEvent), origin: 'event' };

  return null;
}

/** Claim the per-event lock, treating a stuck `importing` row as re-claimable. */
async function claim(supabase, eventUuid: string, force: boolean): Promise<boolean> {
  const existing = await supabase
    .from('events_schedule_imports')
    .select('status, last_attempt_at')
    .eq('event_uuid', eventUuid)
    .maybeSingle();

  if (existing?.data?.status === 'importing' && !force) {
    const started = Date.parse(existing.data.last_attempt_at ?? '') || 0;
    if (Date.now() - started < STALE_CLAIM_MS) return false; // someone else holds it
  }

  const row = {
    event_uuid: eventUuid,
    status: 'importing',
    last_attempt_at: new Date().toISOString(),
    error: null,
    updated_at: new Date().toISOString(),
  };
  const up = await supabase.from('events_schedule_imports').upsert(row, { onConflict: 'event_uuid' });
  if (up.error) throw new Error(`claim failed: ${up.error.message}`);
  return true;
}

async function finish(supabase, eventUuid: string, patch: Record<string, unknown>): Promise<void> {
  await supabase
    .from('events_schedule_imports')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('event_uuid', eventUuid);
}

/** import_refs helpers — the idempotency spine. */
function refsApi(supabase, eventUuid: string, sourceKind: string) {
  return {
    async get(sourceRef: string, entityType: string) {
      const r = await supabase
        .from('events_schedule_import_refs')
        .select('entity_id, source_fingerprint')
        .eq('event_uuid', eventUuid).eq('source_kind', sourceKind)
        .eq('source_ref', sourceRef).eq('entity_type', entityType)
        .maybeSingle();
      return r?.data ?? null;
    },
    async put(sourceRef: string, entityType: string, entityId: string, fp: string | null) {
      const up = await supabase.from('events_schedule_import_refs').upsert({
        event_uuid: eventUuid, source_kind: sourceKind, source_ref: sourceRef,
        entity_type: entityType, entity_id: entityId, source_fingerprint: fp,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'event_uuid,source_kind,source_ref,entity_type' });
      if (up.error) throw new Error(`import_refs upsert failed: ${up.error.message}`);
    },
  };
}

export interface ImportResult {
  status: 'complete' | 'unavailable' | 'failed' | 'skipped';
  stats: Record<string, unknown>;
  error?: string;
}

/**
 * Run one import. `log` is the worker logger; `overrideUrl` comes from a
 * recap's schedule_url_override when the recap triggered this.
 */
export async function importSchedule(
  supabase,
  eventUuid: string,
  opts: { force?: boolean; overrideUrl?: string | null; allowlist?: string[]; log?: (m: string) => void } = {},
): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const allowlist = opts.allowlist ?? DEFAULT_HOST_ALLOWLIST;

  if (!(await claim(supabase, eventUuid, opts.force === true))) {
    log('import already running for this event — skipped');
    return { status: 'skipped', stats: {} };
  }

  try {
    const resolved = await resolveScheduleUrl(supabase, eventUuid, opts.overrideUrl);
    if (!resolved) {
      await finish(supabase, eventUuid, { status: 'unavailable', error: null, schedule_url: null });
      log('no schedule source for this event');
      return { status: 'unavailable', stats: {} };
    }

    // Detect: a sched host is claimed directly; anything else is fetched once
    // so the embed script can be read (§5.2). The host is never guessed.
    let detected = detectSource(resolved.url);
    if (!detected) {
      const page = await guardedFetch(resolved.url, allowlist);
      if (!page.ok) {
        await finish(supabase, eventUuid, {
          status: 'unavailable', schedule_url: resolved.url, url_origin: resolved.origin,
          error: `schedule page returned ${page.status}`,
        });
        return { status: 'unavailable', stats: {} };
      }
      detected = detectSource(resolved.url, page.text);
    }
    if (!detected) {
      await finish(supabase, eventUuid, {
        status: 'unavailable', schedule_url: resolved.url, url_origin: resolved.origin,
        error: 'no schedule source found on that page yet',
      });
      log('page resolved but publishes no programme yet');
      return { status: 'unavailable', stats: {} };
    }

    const { source, resolvedUrl } = detected;
    const raw = await source.fetch(resolvedUrl, (u) => guardedFetch(u, allowlist));
    const hash = sha256(Object.keys(raw.parts).sort().map((k) => raw.parts[k]).join(HASH_SEP));

    const prior = await supabase
      .from('events_schedule_imports').select('content_hash').eq('event_uuid', eventUuid).maybeSingle();
    if (prior?.data?.content_hash === hash && !opts.force) {
      await finish(supabase, eventUuid, {
        status: 'complete', schedule_url: resolved.url, url_origin: resolved.origin,
        resolved_source_url: resolvedUrl, last_success_at: new Date().toISOString(),
        stats: { unchanged: true },
      });
      log('programme unchanged since last import');
      return { status: 'complete', stats: { unchanged: true } };
    }

    const parsed = source.parse(raw);
    const refs = refsApi(supabase, eventUuid, source.kind);
    const seen = new Set<string>();
    const stats: Record<string, unknown> = {
      sessions: 0, breaks: 0, tracks: 0, speakers: 0,
      speakers_created: 0, speakers_adopted: 0, preserved_edits: 0,
      skeleton_mismatch: parsed.diagnostics.skeletonMismatch, unchanged: false,
    };

    // ── Tracks ────────────────────────────────────────────────────────────
    const trackIds = new Map<string, string>();
    for (const [i, t] of parsed.tracks.entries()) {
      const name = clean(t.name, LIMITS.track);
      if (!name) continue;
      seen.add(`track:${t.ref}`);
      const existing = await refs.get(t.ref, 'track');
      const fp = fingerprint({ name, sort_order: i });
      if (existing?.entity_id) {
        trackIds.set(t.ref, existing.entity_id);
        if (existing.source_fingerprint !== fp) {
          const cur = await supabase.from('events_agenda_tracks').select('name, sort_order').eq('id', existing.entity_id).maybeSingle();
          const curFp = cur?.data ? fingerprint({ name: cur.data.name, sort_order: cur.data.sort_order ?? 0 }) : null;
          if (curFp === existing.source_fingerprint) {
            await supabase.from('events_agenda_tracks').update({ name, sort_order: i }).eq('id', existing.entity_id);
            await refs.put(t.ref, 'track', existing.entity_id, fp);
          } else {
            stats.preserved_edits = (stats.preserved_edits as number) + 1;
          }
        }
        continue;
      }
      const ins = await supabase.from('events_agenda_tracks')
        .insert({ event_uuid: eventUuid, name, sort_order: i }).select('id').single();
      if (ins.error) throw new Error(`track insert failed: ${ins.error.message}`);
      trackIds.set(t.ref, ins.data.id);
      await refs.put(t.ref, 'track', ins.data.id, fp);
      stats.tracks = (stats.tracks as number) + 1;
    }

    // ── Speakers → profiles (§7.3 steps 1, 2, 4) ──────────────────────────
    const speakerIds = new Map<string, string>();
    const allSpeakers = new Map<string, (typeof parsed.sessions)[number]['speakers'][number]>();
    for (const s of parsed.sessions) for (const k of s.speakers) if (!allSpeakers.has(k.ref)) allSpeakers.set(k.ref, k);

    // Everyone already attached to this event, fetched ONCE. Doing this inside
    // the per-speaker loop turned a 107-speaker programme into 107 full reads
    // of the event's speaker list, with no bound on either side.
    const attachedRows = await supabase
      .from('events_speakers')
      .select('speaker_id, events_speaker_profiles!inner(id, name)')
      .eq('event_uuid', eventUuid);
    const normName = (v: string) => String(v ?? '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const attachedByName = new Map<string, string>();
    for (const r of attachedRows?.data ?? []) {
      const p = Array.isArray(r.events_speaker_profiles) ? r.events_speaker_profiles[0] : r.events_speaker_profiles;
      if (p?.name) attachedByName.set(normName(p.name), r.speaker_id);
    }

    for (const [ref, k] of allSpeakers) {
      const name = clean(k.name, LIMITS.name);
      if (!name) continue;
      seen.add(`speaker_profile:${ref}`);
      const role = clean(k.role, LIMITS.role);
      const company = clean(k.company, LIMITS.company);
      const bio = clean(k.bio, LIMITS.bio);
      // Avatars are hot-linked, so the stored URL is the request every viewer's
      // browser makes — it is host-allowlisted, not merely https (§11.2).
      const avatar = safeAvatarUrl(k.avatarUrl);

      const existing = await refs.get(ref, 'speaker_profile');
      if (existing?.entity_id) {
        speakerIds.set(ref, existing.entity_id);
        // Fill only fields that are still empty; never overwrite a human's edit.
        const cur = await supabase.from('events_speaker_profiles')
          .select('title, company, bio, avatar_url').eq('id', existing.entity_id).maybeSingle();
        const patch: Record<string, unknown> = {};
        if (cur?.data) {
          if (!cur.data.title && role) patch.title = role;
          if (!cur.data.company && company) patch.company = company;
          if (!cur.data.bio && bio) patch.bio = bio;
          if (!cur.data.avatar_url && avatar) patch.avatar_url = avatar;
        }
        if (Object.keys(patch).length > 0) {
          await supabase.from('events_speaker_profiles').update(patch).eq('id', existing.entity_id);
        }
        stats.speakers_adopted = (stats.speakers_adopted as number) + 1;
        continue;
      }

      // Already attached to this event under the same name? Adopt it rather
      // than creating a second profile for the same person. Read from the map
      // built once before this loop — querying per speaker turned a
      // 107-speaker programme into 107 reads of the event's whole speaker list.
      const hit = attachedByName.get(normName(name)) ?? null;

      let profileId: string;
      if (hit) {
        profileId = hit; // the map stores the profile id directly
        stats.speakers_adopted = (stats.speakers_adopted as number) + 1;
      } else {
        // §7.3 step 4: a placeholder profile. person_id stays null — linking a
        // person on a name alone would put one person's face on another's talk.
        const ins = await supabase.from('events_speaker_profiles')
          .insert({ name, title: role, company, bio, avatar_url: avatar })
          .select('id').single();
        if (ins.error) throw new Error(`speaker profile insert failed: ${ins.error.message}`);
        profileId = ins.data.id;
        stats.speakers_created = (stats.speakers_created as number) + 1;
      }
      speakerIds.set(ref, profileId);
      await refs.put(ref, 'speaker_profile', profileId, fingerprint({ name, role, company }));
      stats.speakers = (stats.speakers as number) + 1;
    }

    // ── Sessions → talks, entries, junctions ──────────────────────────────
    for (const [i, s] of parsed.sessions.entries()) {
      const title = clean(s.title, LIMITS.title) ?? clean(s.rawTitle, LIMITS.title);
      if (!title) continue;
      seen.add(`agenda_entry:${s.ref}`);
      const description = clean(s.description, LIMITS.synopsis);
      const location = clean(s.location, LIMITS.location);
      const trackId = s.trackRef ? trackIds.get(s.trackRef) ?? null : null;

      // A talk row only for programme content — never for breaks or expo slots.
      let talkId: string | null = null;
      if (s.kind === 'session') {
        seen.add(`talk:${s.ref}`);
        const talkFp = fingerprint({ title, session_type: s.sessionType, synopsis: description });
        const talkRef = await refs.get(s.ref, 'talk');
        if (talkRef?.entity_id) {
          talkId = talkRef.entity_id;
          const cur = await supabase.from('events_talks').select('title, session_type, synopsis').eq('id', talkId).maybeSingle();
          const curFp = cur?.data ? fingerprint({ title: cur.data.title, session_type: cur.data.session_type, synopsis: cur.data.synopsis }) : null;
          if (curFp === talkRef.source_fingerprint && curFp !== talkFp) {
            await supabase.from('events_talks').update({ title, session_type: s.sessionType, synopsis: description }).eq('id', talkId);
            await refs.put(s.ref, 'talk', talkId, talkFp);
          } else if (curFp !== talkRef.source_fingerprint) {
            stats.preserved_edits = (stats.preserved_edits as number) + 1;
          }
        } else {
          const ins = await supabase.from('events_talks').insert({
            event_uuid: eventUuid, title, synopsis: description,
            session_type: s.sessionType, status: 'confirmed', sort_order: i,
          }).select('id').single();
          if (ins.error) throw new Error(`talk insert failed: ${ins.error.message}`);
          talkId = ins.data.id;
          await refs.put(s.ref, 'talk', talkId, talkFp);
        }
      }

      const entryFp = fingerprint({ title, start_time: s.startsAt, end_time: s.endsAt, location, track_id: trackId, entry_type: s.kind });
      const entryRef = await refs.get(s.ref, 'agenda_entry');
      let entryId: string;
      if (entryRef?.entity_id) {
        entryId = entryRef.entity_id;
        const cur = await supabase.from('events_agenda_entries')
          .select('title, start_time, end_time, location, track_id, entry_type').eq('id', entryId).maybeSingle();
        const curFp = cur?.data ? fingerprint({
          title: cur.data.title, start_time: cur.data.start_time, end_time: cur.data.end_time,
          location: cur.data.location, track_id: cur.data.track_id, entry_type: cur.data.entry_type,
        }) : null;
        if (curFp === entryRef.source_fingerprint && curFp !== entryFp) {
          await supabase.from('events_agenda_entries').update({
            title, start_time: s.startsAt, end_time: s.endsAt, location,
            track_id: trackId, entry_type: s.kind, talk_id: talkId, sort_order: i,
          }).eq('id', entryId);
          await refs.put(s.ref, 'agenda_entry', entryId, entryFp);
        } else if (curFp !== entryRef.source_fingerprint) {
          stats.preserved_edits = (stats.preserved_edits as number) + 1;
        }
      } else {
        const ins = await supabase.from('events_agenda_entries').insert({
          event_uuid: eventUuid, track_id: trackId, title, description,
          start_time: s.startsAt, end_time: s.endsAt, location,
          entry_type: s.kind, talk_id: talkId, sort_order: i,
        }).select('id').single();
        if (ins.error) throw new Error(`agenda entry insert failed: ${ins.error.message}`);
        entryId = ins.data.id;
        await refs.put(s.ref, 'agenda_entry', entryId, entryFp);
      }

      if (s.kind === 'break') { stats.breaks = (stats.breaks as number) + 1; continue; }
      stats.sessions = (stats.sessions as number) + 1;

      // Junctions: talk↔speaker, entry↔speaker, event↔speaker.
      for (const [j, k] of s.speakers.entries()) {
        const profileId = speakerIds.get(k.ref);
        if (!profileId) continue;
        if (talkId) {
          await supabase.from('events_talk_speakers').upsert({
            talk_id: talkId, speaker_id: profileId,
            role: s.sessionType === 'panel' ? 'panelist' : 'presenter',
            is_primary: j === 0, sort_order: j,
          }, { onConflict: 'talk_id,speaker_id' });
        }
        await supabase.from('events_agenda_entry_speakers').upsert({
          agenda_entry_id: entryId, speaker_id: profileId, sort_order: j,
        }, { onConflict: 'agenda_entry_id,speaker_id' });

        const already = await supabase.from('events_speakers')
          .select('id').eq('event_uuid', eventUuid).eq('speaker_id', profileId).maybeSingle();
        if (!already?.data?.id) {
          await supabase.from('events_speakers').insert({
            event_uuid: eventUuid, speaker_id: profileId, status: 'confirmed',
            speaker_title: clean(k.role, LIMITS.role), talk_title: title, sort_order: j,
          });
        }
      }
    }

    // ── Refs the source stopped mentioning (reported, never deleted) ───────
    const allRefs = await supabase
      .from('events_schedule_import_refs')
      .select('source_ref, entity_type')
      .eq('event_uuid', eventUuid).eq('source_kind', source.kind);
    const stale = (allRefs?.data ?? [])
      .filter((r) => !seen.has(`${r.entity_type}:${r.source_ref}`))
      .map((r) => `${r.entity_type}:${r.source_ref}`);
    stats.stale = stale;

    await finish(supabase, eventUuid, {
      status: 'complete',
      schedule_url: resolved.url,
      url_origin: resolved.origin,
      resolved_source_url: resolvedUrl,
      content_hash: hash,
      last_success_at: new Date().toISOString(),
      error: null,
      stats,
    });
    log(`schedule imported: ${stats.sessions} sessions, ${stats.breaks} breaks, ${stats.tracks} new tracks, ${stats.speakers} speakers (${stats.speakers_created} new), ${stale.length} stale`);
    return { status: 'complete', stats };
  } catch (err) {
    const message = err instanceof FetchRefused ? err.message : (err as Error)?.message ?? String(err);
    await finish(supabase, eventUuid, { status: 'failed', error: String(message).slice(0, 1000) });
    log(`schedule import failed: ${message}`);
    return { status: 'failed', stats: {}, error: message };
  }
}

/** BullMQ entry point: { event_uuid, force?, override_url? }. */
export default async function importScheduleHandler(job, ctx): Promise<void> {
  const eventUuid = job?.data?.event_uuid ?? job?.data?.eventUuid;
  if (!eventUuid) throw new Error('import-schedule job missing event_uuid');
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[event-agenda] ${m}`);
  const result = await importSchedule(supabase, eventUuid, {
    force: job?.data?.force === true,
    overrideUrl: job?.data?.override_url ?? null,
    log,
  });
  if (result.status === 'failed') throw new Error(result.error ?? 'schedule import failed');
}
