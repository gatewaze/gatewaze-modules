// @ts-nocheck — supabase-js + youtubei.js are resolved at module-host install time.

/**
 * videos:import-from-youtube — pull our own already-published talks down into
 * storage, so they look as if an editor had delivered them (spec §20).
 *
 * This exists because the editing workflow assumes Gatewaze holds the master,
 * and for the conferences whose recap was built from an existing playlist, it
 * does not. After this runs, those talks have a `master` asset with
 * `source = 'youtube_import'` and behave like any other.
 *
 * It is our own channel's content. That is the only reason this is reasonable,
 * and it is why the job takes a recap or an event rather than an arbitrary
 * URL: there is no general-purpose video downloader here, by design.
 *
 * Three things keep it from being dangerous:
 *
 * It is OPERATOR-TRIGGERED, with no cron. A conference is 50 to 60 talks at a
 * few hundred MB each, so a sweep is how somebody discovers a storage bill
 * they did not ask for.
 *
 * It has a per-video cap AND a per-run budget, both configurable. The run
 * stops when the budget is spent and says how far it got, so a 60-talk import
 * is resumable in deliberate chunks rather than all-or-nothing.
 *
 * It takes ONE progressive rendition at or below 1080p. The adaptive streams
 * are separate video and audio tracks that need muxing, which is a transcode
 * pipeline this module does not have and the spec does not claim. In 2026
 * that means 360p in practice: YouTube serves nothing higher without a
 * browser-bound token. The Drive import (videos:import-masters-from-drive)
 * is how the originals arrive; this is the fallback for a talk that has none.
 *
 * The master attaches to the EXISTING `videos` row for the YouTube id when
 * discovery or the recap has already created one, so one talk stays one row.
 * Only when no row exists does it create one.
 */

import { storeForNew } from '../lib/storage.js';

/** Defaults, overridden by the module config. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RUN_CAP_BYTES = 30 * 1024 * 1024 * 1024;

/** Pause between videos, so an import is not mistaken for abuse. */
const PACE_MS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ImportResult {
  scope: string;
  attempted: number;
  imported: number;
  skipped: number;
  failed: number;
  bytes: number;
  stopped_on_budget: boolean;
}

/** The module's own config row, for the two caps. */
async function loadCaps(supabase): Promise<{ maxBytes: number; runCap: number }> {
  try {
    const { data } = await supabase
      .from('installed_modules').select('config').eq('id', 'videos').maybeSingle();
    const cfg = (data?.config ?? {}) as Record<string, unknown>;
    const n = (v: unknown, d: number) => {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? x : d;
    };
    return {
      maxBytes: n(cfg.youtube_import_max_bytes, DEFAULT_MAX_BYTES),
      runCap: n(cfg.youtube_import_run_cap_bytes, DEFAULT_RUN_CAP_BYTES),
    };
  } catch {
    return { maxBytes: DEFAULT_MAX_BYTES, runCap: DEFAULT_RUN_CAP_BYTES };
  }
}

/**
 * Pick the rendition to download.
 *
 * Progressive only (one file with both tracks), at or below 1080p, largest
 * first. Returns null when the video only offers adaptive streams, which is
 * increasingly common and is a legitimate skip rather than a failure.
 */
export function pickRendition(
  formats: Array<{ has_video?: boolean; has_audio?: boolean; height?: number; content_length?: number; url?: string; mime_type?: string }>,
  maxHeight = 1080,
): { url: string; bytes: number; height: number; mimeType: string } | null {
  const progressive = (formats ?? [])
    .filter((f) => f?.has_video === true && f?.has_audio === true && typeof f.url === 'string' && f.url)
    .filter((f) => Number(f.height ?? 0) > 0 && Number(f.height) <= maxHeight)
    .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0));
  const best = progressive[0];
  if (!best) return null;
  return {
    url: String(best.url),
    bytes: Number(best.content_length ?? 0),
    height: Number(best.height ?? 0),
    mimeType: String(best.mime_type ?? 'video/mp4').split(';')[0].trim(),
  };
}

interface Target {
  /** The YouTube id. */
  youtubeId: string;
  title: string;
  /** The agenda entry the talk already belongs to, when known. */
  agendaEntryId: string | null;
}

/** The talks of a recap, canonical videos only. */
async function targetsForRecap(supabase, recapId: string, log): Promise<{ label: string; targets: Target[] } | null> {
  const { data: recap } = await supabase
    .from('conference_recaps').select('id, item_slug').eq('id', recapId).maybeSingle();
  if (!recap) { log(`recap ${recapId} not found`); return null; }
  // A duplicate upload of the same session would download the same talk twice.
  const { data: rows, error } = await supabase
    .from('conference_recap_videos')
    .select('video_id, raw_title, summary, agenda_entry_id, position')
    .eq('recap_id', recapId)
    .is('duplicate_of', null)
    .order('position');
  if (error) { log(`could not read recap videos: ${error.message}`); return null; }
  return {
    label: `recap ${recap.item_slug}`,
    targets: (rows ?? []).filter((r) => YT_ID_RE.test(String(r.video_id))).map((r) => ({
      youtubeId: String(r.video_id),
      title: String(r.summary?.title ?? r.raw_title ?? r.video_id),
      agendaEntryId: r.agenda_entry_id ?? null,
    })),
  };
}

/**
 * The YouTube videos attached to an event's agenda entries, or to the event
 * itself, through video_subjects.
 */
async function targetsForEvent(supabase, eventId: string, log): Promise<{ label: string; targets: Target[] } | null> {
  const { data: ev } = await supabase.from('events').select('id, event_id').eq('id', eventId).maybeSingle();
  if (!ev) { log(`event ${eventId} not found`); return null; }
  const { data: entries } = await supabase
    .from('events_agenda_entries').select('id').eq('event_uuid', eventId).limit(2000);
  const entryIds = (entries ?? []).map((e) => String(e.id));
  const links: Array<{ video_id: string; subject_type: string; subject_id: string }> = [];
  const { data: onEvent } = await supabase
    .from('video_subjects').select('video_id, subject_type, subject_id')
    .eq('subject_type', 'event').eq('subject_id', eventId);
  links.push(...(onEvent ?? []));
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data } = await supabase
      .from('video_subjects').select('video_id, subject_type, subject_id')
      .eq('subject_type', 'agenda_entry').in('subject_id', entryIds.slice(i, i + 200));
    links.push(...(data ?? []));
  }
  const videoIds = [...new Set(links.map((l) => String(l.video_id)))];
  const targets: Target[] = [];
  for (let i = 0; i < videoIds.length; i += 200) {
    const { data: vids } = await supabase
      .from('videos').select('id, provider, provider_video_id, title')
      .in('id', videoIds.slice(i, i + 200)).eq('provider', 'youtube');
    for (const v of vids ?? []) {
      if (!YT_ID_RE.test(String(v.provider_video_id))) continue;
      const link = links.find((l) => String(l.video_id) === String(v.id) && l.subject_type === 'agenda_entry');
      targets.push({ youtubeId: String(v.provider_video_id), title: String(v.title ?? v.provider_video_id), agendaEntryId: link ? String(link.subject_id) : null });
    }
  }
  return { label: `event ${ev.event_id}`, targets };
}

/**
 * The `videos` row this YouTube id should attach to: the existing
 * provider='youtube' row, else the row an earlier import created, else a new
 * one. Returns the id and whether a ready master already exists on it.
 */
async function resolveVideoRow(supabase, t: Target): Promise<{ videoId: string; hasMaster: boolean }> {
  // The id goes into an .or() filter below. Both callers already filter on
  // this pattern; checking again here means the filter's safety does not
  // depend on every future caller remembering to.
  if (!YT_ID_RE.test(t.youtubeId)) throw new Error('not a YouTube id');
  const marker = `yt-import-${t.youtubeId}`;
  const { data: existing } = await supabase
    .from('videos')
    .select('id, provider')
    .or(`and(provider.eq.youtube,provider_video_id.eq.${t.youtubeId}),and(provider.eq.gatewaze,provider_video_id.eq.${marker})`)
    .limit(2);
  // Prefer the youtube row: that is the one discovery, metrics and the recap
  // all point at.
  const row = (existing ?? []).find((r) => r.provider === 'youtube') ?? (existing ?? [])[0];
  let videoId = row ? String(row.id) : '';
  if (!videoId) {
    const ins = await supabase
      .from('videos')
      .insert({
        provider: 'youtube',
        provider_video_id: t.youtubeId,
        url: `https://youtu.be/${t.youtubeId}`,
        title: t.title.slice(0, 300),
        kind: 'full',
        status: 'published',
        publish_state: 'published',
        visibility: 'public',
        is_external: false,
        source: 'youtube-import',
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(ins.error.message);
    videoId = String(ins.data.id);
  }
  const { data: ready } = await supabase
    .from('video_assets')
    .select('id').eq('video_id', videoId).eq('kind', 'master').eq('state', 'ready').limit(1);
  return { videoId, hasMaster: (ready ?? []).length > 0 };
}

export async function importYoutubeVideos(
  supabase,
  scope: { recapId?: string; eventId?: string },
  log: (m: string) => void = () => {},
): Promise<ImportResult> {
  const result: ImportResult = {
    scope: scope.recapId ? `recap:${scope.recapId}` : `event:${scope.eventId}`,
    attempted: 0, imported: 0, skipped: 0, failed: 0, bytes: 0, stopped_on_budget: false,
  };
  const { maxBytes, runCap } = await loadCaps(supabase);

  const found = scope.recapId
    ? await targetsForRecap(supabase, scope.recapId, log)
    : await targetsForEvent(supabase, String(scope.eventId), log);
  if (!found) return result;
  if (!found.targets.length) { log(`${found.label} has no YouTube videos`); return result; }

  const { Innertube } = await import('youtubei.js');
  const tube = await Innertube.create({ retrieve_player: true });

  for (const t of found.targets) {
    if (result.bytes >= runCap) {
      result.stopped_on_budget = true;
      log(`run budget of ${(runCap / 1073741824).toFixed(1)}GB reached — stopping, re-run to continue`);
      break;
    }
    result.attempted += 1;

    let videoId = '';
    let assetId = '';
    try {
      const resolved = await resolveVideoRow(supabase, t);
      videoId = resolved.videoId;
      if (resolved.hasMaster) { result.skipped += 1; continue; }

      const info = await tube.getBasicInfo(t.youtubeId);
      const formats = [
        ...(info?.streaming_data?.formats ?? []),
        ...(info?.streaming_data?.adaptive_formats ?? []),
      ];
      const pick = pickRendition(formats);
      if (!pick) {
        log(`${t.youtubeId}: no progressive rendition at or below 1080p — skipped`);
        result.skipped += 1;
        continue;
      }
      if (pick.bytes > maxBytes) {
        log(`${t.youtubeId}: ${(pick.bytes / 1048576).toFixed(0)}MB exceeds the per-video cap — skipped`);
        result.skipped += 1;
        continue;
      }
      if (pick.bytes > 0 && result.bytes + pick.bytes > runCap) {
        result.stopped_on_budget = true;
        log('next video would exceed the run budget — stopping, re-run to continue');
        break;
      }

      if (t.agendaEntryId) {
        await supabase.from('video_subjects').upsert({
          video_id: videoId, subject_type: 'agenda_entry', subject_id: t.agendaEntryId, source: 'recap',
        }, { onConflict: 'video_id,subject_type,subject_id', ignoreDuplicates: true });
      }
      // The publication that describes what is ALREADY public on YouTube.
      await supabase.from('video_publications').upsert({
        video_id: videoId,
        platform: 'youtube',
        state: 'published',
        requested_visibility: 'public',
        external_id: t.youtubeId,
        external_url: `https://youtu.be/${t.youtubeId}`,
        external_visibility: 'public',
        published_at: new Date().toISOString(),
      }, { onConflict: 'platform,external_id', ignoreDuplicates: true });

      const store = storeForNew(supabase, 'master');
      const assetIns = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind: 'master',
          storage_bucket: store.bucket,
          storage_provider: store.provider,
          storage_path: 'pending',
          filename: `${t.youtubeId}.mp4`,
          mime_type: pick.mimeType,
          state: 'uploading',
          source: 'youtube_import',
        })
        .select('id')
        .single();
      if (assetIns.error) throw new Error(assetIns.error.message);
      assetId = String(assetIns.data.id);
      const path = `youtube-import/${t.youtubeId}/${assetId}.mp4`;
      await supabase.from('video_assets').update({ storage_path: path }).eq('id', assetId);

      // The stream URL came from YouTube's player response. Only its own
      // media hosts over https, and no redirects, so a surprising manifest
      // cannot point the worker at something else.
      const u = new URL(pick.url);
      if (u.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/.test(u.hostname)) {
        throw new Error(`refusing to download from ${u.hostname}`);
      }
      // Stream it through rather than buffering, cut off at the per-video cap
      // in case the manifest under-reported the size.
      const res = await fetch(pick.url, { redirect: 'manual' });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      await store.putStream(path, res.body, pick.mimeType, maxBytes);

      // Trust the stored object, not the manifest's content_length.
      const head = await store.head(path);
      const storedBytes = head.ok ? head.bytes : pick.bytes;

      await supabase
        .from('video_assets')
        .update({ state: 'ready', bytes: storedBytes, height: pick.height, error: null })
        .eq('id', assetId);

      result.imported += 1;
      result.bytes += storedBytes;
      log(`imported ${t.youtubeId} (${(storedBytes / 1048576).toFixed(0)}MB, ${pick.height}p) — ${t.title.slice(0, 60)}`);
    } catch (err) {
      result.failed += 1;
      const msg = String((err as Error)?.message ?? err).slice(0, 300);
      log(`${t.youtubeId}: ${msg}`);
      // A failed download is recorded and skipped. Partial coverage is useful;
      // an all-or-nothing import of 20GB is not.
      if (assetId) {
        await supabase.from('video_assets').update({ state: 'failed', error: msg }).eq('id', assetId).eq('state', 'uploading');
      }
    }

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  log(
    `youtube import for ${found.label}: ${result.imported} imported, ${result.skipped} skipped, `
    + `${result.failed} failed, ${(result.bytes / 1073741824).toFixed(2)}GB`
    + (result.stopped_on_budget ? ' (stopped on budget)' : ''),
  );
  return result;
}

/** Kept for callers of the old name. */
export const importRecapVideos = (supabase, recapId: string, log?) => importYoutubeVideos(supabase, { recapId }, log);

export default async function importFromYoutubeHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);

  const recapId = String(job?.data?.recap_id ?? job?.data?.recapId ?? '');
  const eventId = String(job?.data?.event_id ?? job?.data?.eventId ?? '');
  if (UUID_RE.test(recapId)) {
    await importYoutubeVideos(supabase, { recapId }, log);
  } else if (UUID_RE.test(eventId)) {
    await importYoutubeVideos(supabase, { eventId }, log);
  } else {
    log('import-from-youtube: no recap_id or event_id on the job — nothing to do');
  }
}
