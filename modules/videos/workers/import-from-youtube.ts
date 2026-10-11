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
 * and it is why the job takes a recap id rather than an arbitrary URL: there
 * is no general-purpose video downloader here, by design.
 *
 * Three things keep it from being dangerous:
 *
 * It is OPERATOR-TRIGGERED per recap, with no cron. A conference is 50 to 60
 * talks at a few hundred MB each, so a sweep is how somebody discovers a
 * storage bill they did not ask for.
 *
 * It has a per-video cap AND a per-run budget, both configurable. The run
 * stops when the budget is spent and says how far it got, so a 60-talk import
 * is resumable in deliberate chunks rather than all-or-nothing.
 *
 * It takes ONE progressive rendition at or below 1080p. The adaptive streams
 * are separate video and audio tracks that need muxing, which is a transcode
 * pipeline this module does not have and the spec does not claim.
 */

/** Defaults, overridden by the module config. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_RUN_CAP_BYTES = 30 * 1024 * 1024 * 1024;

/** Pause between videos, so an import is not mistaken for abuse. */
const PACE_MS = 2000;

const BUCKET = 'video-masters';

export interface ImportResult {
  recap_id: string;
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

export async function importRecapVideos(
  supabase,
  recapId: string,
  log: (m: string) => void = () => {},
): Promise<ImportResult> {
  const result: ImportResult = {
    recap_id: recapId, attempted: 0, imported: 0, skipped: 0, failed: 0,
    bytes: 0, stopped_on_budget: false,
  };
  const { maxBytes, runCap } = await loadCaps(supabase);

  const { data: recap } = await supabase
    .from('conference_recaps')
    .select('id, item_slug, event_id')
    .eq('id', recapId)
    .maybeSingle();
  if (!recap) {
    log(`recap ${recapId} not found`);
    return result;
  }

  // Canonical videos only: a duplicate upload of the same session would
  // download the same talk twice.
  const { data: rows, error } = await supabase
    .from('conference_recap_videos')
    .select('id, video_id, raw_title, summary, agenda_entry_id, position')
    .eq('recap_id', recapId)
    .is('duplicate_of', null)
    .order('position');
  if (error) {
    log(`could not read recap videos: ${error.message}`);
    return result;
  }
  if (!rows?.length) {
    log('recap has no videos');
    return result;
  }

  const { Innertube } = await import('youtubei.js');
  const tube = await Innertube.create({ retrieve_player: true });

  for (const row of rows) {
    if (result.bytes >= runCap) {
      result.stopped_on_budget = true;
      log(`run budget of ${(runCap / 1073741824).toFixed(1)}GB reached — stopping, re-run to continue`);
      break;
    }
    result.attempted += 1;

    // Already imported? The unique (provider, provider_video_id) key on a
    // 'gatewaze' row is what makes a re-run idempotent.
    const marker = `yt-import-${row.video_id}`;
    const { data: already } = await supabase
      .from('videos')
      .select('id')
      .eq('provider', 'gatewaze')
      .eq('provider_video_id', marker)
      .maybeSingle();
    if (already) {
      const { data: readyAsset } = await supabase
        .from('video_assets')
        .select('id').eq('video_id', already.id).eq('kind', 'master').eq('state', 'ready').limit(1);
      if (readyAsset?.length) {
        result.skipped += 1;
        continue;
      }
    }

    try {
      const info = await tube.getBasicInfo(row.video_id);
      const formats = [
        ...(info?.streaming_data?.formats ?? []),
        ...(info?.streaming_data?.adaptive_formats ?? []),
      ];
      const pick = pickRendition(formats);
      if (!pick) {
        log(`${row.video_id}: no progressive rendition at or below 1080p — skipped`);
        result.skipped += 1;
        continue;
      }
      if (pick.bytes > maxBytes) {
        log(`${row.video_id}: ${(pick.bytes / 1048576).toFixed(0)}MB exceeds the per-video cap — skipped`);
        result.skipped += 1;
        continue;
      }
      if (pick.bytes > 0 && result.bytes + pick.bytes > runCap) {
        result.stopped_on_budget = true;
        log('next video would exceed the run budget — stopping, re-run to continue');
        break;
      }

      const title = String(row.summary?.title ?? row.raw_title ?? row.video_id).slice(0, 300);

      // One videos row per imported talk, then the asset.
      const videoId = already?.id ?? (await (async () => {
        const ins = await supabase
          .from('videos')
          .insert({
            provider: 'gatewaze',
            provider_video_id: marker,
            url: `https://youtu.be/${row.video_id}`,
            title,
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
        return String(ins.data.id);
      })());

      // Attach it to the agenda entry the recap matcher already resolved, so
      // the imported file lands on the same talk the editor would pick.
      if (row.agenda_entry_id) {
        await supabase.from('video_subjects').upsert({
          video_id: videoId,
          subject_type: 'agenda_entry',
          subject_id: row.agenda_entry_id,
          source: 'recap',
        }, { onConflict: 'video_id,subject_type,subject_id', ignoreDuplicates: true });
      }

      // The publication that describes what is ALREADY public on YouTube.
      // Recorded as published rather than draft, because it is.
      await supabase.from('video_publications').upsert({
        video_id: videoId,
        platform: 'youtube',
        state: 'published',
        requested_visibility: 'public',
        external_id: row.video_id,
        external_url: `https://youtu.be/${row.video_id}`,
        external_visibility: 'public',
        published_at: new Date().toISOString(),
      }, { onConflict: 'platform,external_id', ignoreDuplicates: true });

      const assetIns = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind: 'master',
          storage_bucket: BUCKET,
          storage_path: 'pending',
          filename: `${row.video_id}.mp4`,
          mime_type: pick.mimeType,
          state: 'uploading',
          source: 'youtube_import',
        })
        .select('id')
        .single();
      if (assetIns.error) throw new Error(assetIns.error.message);
      const assetId = String(assetIns.data.id);
      const path = `youtube-import/${row.video_id}/${assetId}.mp4`;
      await supabase.from('video_assets').update({ storage_path: path }).eq('id', assetId);

      // Stream it through rather than buffering: a 2GB Buffer in the worker
      // heap is how this would take the pod down.
      const res = await fetch(pick.url);
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

      const up = await supabase.storage.from(BUCKET).upload(path, res.body, {
        contentType: pick.mimeType,
        upsert: true,
        duplex: 'half',
      });
      if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);

      // Trust the stored object, not the manifest's content_length.
      const { data: meta } = await supabase.storage.from(BUCKET).list(
        path.split('/').slice(0, -1).join('/'),
        { search: path.split('/').pop() },
      );
      const storedBytes = Number(meta?.[0]?.metadata?.size ?? pick.bytes ?? 0);

      await supabase
        .from('video_assets')
        .update({ state: 'ready', bytes: storedBytes, height: pick.height, error: null })
        .eq('id', assetId);

      result.imported += 1;
      result.bytes += storedBytes;
      log(`imported ${row.video_id} (${(storedBytes / 1048576).toFixed(0)}MB, ${pick.height}p) — ${title.slice(0, 60)}`);
    } catch (err) {
      result.failed += 1;
      const msg = String((err as Error)?.message ?? err).slice(0, 300);
      log(`${row.video_id}: ${msg}`);
      // A failed download is recorded and skipped. Partial coverage is useful;
      // an all-or-nothing import of 20GB is not.
      await supabase
        .from('video_assets')
        .update({ state: 'failed', error: msg })
        .eq('video_id', (await supabase.from('videos').select('id')
          .eq('provider', 'gatewaze').eq('provider_video_id', `yt-import-${row.video_id}`)
          .maybeSingle()).data?.id ?? '00000000-0000-0000-0000-000000000000')
        .eq('state', 'uploading');
    }

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  log(
    `youtube import for ${recap.item_slug}: ${result.imported} imported, ${result.skipped} skipped, `
    + `${result.failed} failed, ${(result.bytes / 1073741824).toFixed(2)}GB`
    + (result.stopped_on_budget ? ' (stopped on budget)' : ''),
  );
  return result;
}

export default async function importFromYoutubeHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);

  const recapId = String(job?.data?.recap_id ?? job?.data?.recapId ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recapId)) {
    log('import-from-youtube: no recap_id on the job — nothing to do');
    return;
  }
  await importRecapVideos(supabase, recapId, log);
}
