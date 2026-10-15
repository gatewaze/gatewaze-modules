// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:import-masters-from-drive — adopt the original files from a Google
 * Takeout export, delivered to a Drive folder, as masters.
 *
 * Why this exists: YouTube will not hand back anything above 360p without a
 * browser-bound token, so a talk that only ever lived on YouTube has no
 * usable master. Takeout gives the channel owner the files they uploaded,
 * which is better than any stream, and Drive is where Takeout can put them.
 *
 * What it does, per video file in the folder:
 *
 *   1. Match it to a `videos` row. Takeout's `videos.csv` maps title to
 *      YouTube id exactly; without the CSV, a unique normalised-title match.
 *   2. Stream the bytes from Drive into the master store, without touching
 *      disk or buffering the file.
 *   3. Record a ready `master` asset with `source = 'drive_import'`.
 *
 * A file that matches nothing still comes in, as its own `videos` row with no
 * subject, so it shows in the unassigned queue for an operator to attach.
 * Losing a 2GB original because a title had a stray colon would be worse than
 * a row to triage.
 *
 * Operator-triggered, no cron, with the same per-run budget as the YouTube
 * import. A whole conference is 150 to 300GB, which nobody should be able to
 * start by accident.
 */

import { driveAuthFromEnv, listFolder, readText, openStream, assertDriveId } from '../lib/google-drive.js';
import { isVideoFile, parseTakeoutCsv, matchFile, type KnownVideo, type TakeoutRow } from '../lib/takeout-match.js';
import { storeForNew } from '../lib/storage.js';
import { sanitiseFilename, MAX_BYTES } from '../lib/upload-rules.js';

const DEFAULT_RUN_CAP_BYTES = 300 * 1024 * 1024 * 1024;
/** Per file: the same ceiling an editor's upload has. */
const FILE_CAP_BYTES = MAX_BYTES.master;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Takeout containers map to these; anything else is refused at mint-equivalent time. */
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

export interface DriveImportResult {
  folder_id: string;
  files: number;
  matched: number;
  unmatched: number;
  imported: number;
  skipped: number;
  failed: number;
  bytes: number;
  stopped_on_budget: boolean;
}

async function runCap(supabase): Promise<number> {
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'videos').maybeSingle();
    const n = Number((data?.config ?? {}).drive_import_run_cap_bytes);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RUN_CAP_BYTES;
  } catch {
    return DEFAULT_RUN_CAP_BYTES;
  }
}

/**
 * The YouTube videos the files could belong to.
 *
 * Scoped to an event when one is given (its agenda entries' videos plus any
 * on the event itself), else the whole catalogue. The scope is what stops a
 * title like "Keynote" matching the wrong year's keynote.
 */
async function knownVideos(supabase, eventId: string | null): Promise<KnownVideo[]> {
  const select = 'id, provider_video_id, title, duration_seconds';
  if (!eventId) {
    const out: KnownVideo[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from('videos').select(select).eq('provider', 'youtube').range(from, from + 999);
      out.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    return out;
  }
  const { data: entries } = await supabase.from('events_agenda_entries').select('id').eq('event_uuid', eventId).limit(2000);
  const ids = new Set<string>();
  const { data: onEvent } = await supabase.from('video_subjects').select('video_id').eq('subject_type', 'event').eq('subject_id', eventId);
  for (const r of onEvent ?? []) ids.add(String(r.video_id));
  const entryIds = (entries ?? []).map((e) => String(e.id));
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data } = await supabase.from('video_subjects').select('video_id').eq('subject_type', 'agenda_entry').in('subject_id', entryIds.slice(i, i + 200));
    for (const r of data ?? []) ids.add(String(r.video_id));
  }
  const out: KnownVideo[] = [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await supabase.from('videos').select(select).in('id', list.slice(i, i + 200)).eq('provider', 'youtube');
    out.push(...(data ?? []));
  }
  return out;
}

export async function importMastersFromDrive(
  supabase,
  args: { folderId: string; eventId?: string | null },
  log: (m: string) => void = () => {},
  deps: { auth?: ReturnType<typeof driveAuthFromEnv> } = {},
): Promise<DriveImportResult> {
  const folderId = assertDriveId(args.folderId);
  const result: DriveImportResult = {
    folder_id: folderId, files: 0, matched: 0, unmatched: 0, imported: 0, skipped: 0, failed: 0, bytes: 0, stopped_on_budget: false,
  };
  const auth = deps.auth ?? driveAuthFromEnv();
  if (!auth) {
    log('drive import: no Google credentials (VIDEO_DRIVE_SERVICE_ACCOUNT_JSON or GOOGLE_* refresh token) — nothing to do');
    return result;
  }
  const cap = await runCap(supabase);

  const files = await listFolder(auth, folderId);
  const videos = files.filter((f) => isVideoFile(f.name));
  result.files = videos.length;
  if (!videos.length) { log(`drive folder ${folderId}: no video files`); return result; }

  // Takeout's metadata CSV, when present. Small, so read whole.
  let csv: TakeoutRow[] = [];
  for (const f of files.filter((f) => f.name.toLowerCase().endsWith('.csv'))) {
    try {
      const rows = parseTakeoutCsv(await readText(auth, f.id));
      if (rows.length) { csv = csv.concat(rows); log(`using ${f.name}: ${rows.length} rows`); }
    } catch (err) {
      log(`${f.name}: ${String((err as Error)?.message ?? err)} — ignored`);
    }
  }

  const known = await knownVideos(supabase, args.eventId && UUID_RE.test(args.eventId) ? args.eventId : null);
  log(`drive folder ${folderId}: ${videos.length} video files, ${known.length} known videos in scope, csv rows ${csv.length}`);

  for (const f of videos) {
    if (result.bytes >= cap) {
      result.stopped_on_budget = true;
      log(`run budget of ${(cap / 1073741824).toFixed(0)}GB reached — stopping, re-run to continue`);
      break;
    }
    const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) { result.skipped += 1; continue; }
    if (f.size > FILE_CAP_BYTES) {
      log(`${f.name}: ${(f.size / 1073741824).toFixed(1)}GB is over the per-file limit — skipped`);
      result.skipped += 1;
      continue;
    }

    const match = matchFile(f.name, known, csv);
    if (match) result.matched += 1; else result.unmatched += 1;

    let assetId = '';
    try {
      // Idempotent on the Drive file id: a re-run after a budget stop does not
      // import the same file twice. The prefix is re-checked in code because
      // `_` is a LIKE wildcard and Drive ids contain it.
      const prefix = `drive-import/${f.id}/`;
      const { data: already } = await supabase
        .from('video_assets').select('id, state, storage_path').eq('source', 'drive_import').like('storage_path', `${prefix}%`).limit(5);
      if ((already ?? []).some((a) => a.state === 'ready' && String(a.storage_path).startsWith(prefix))) { result.skipped += 1; continue; }

      let videoId = match?.videoId ?? '';
      if (videoId) {
        const { data: ready } = await supabase
          .from('video_assets').select('id').eq('video_id', videoId).eq('kind', 'master').eq('state', 'ready').limit(1);
        if ((ready ?? []).length) { result.skipped += 1; log(`${f.name}: already has a master — skipped`); continue; }
      } else {
        // Unmatched: its own row, no subject, so it lands in the unassigned queue.
        const ins = await supabase
          .from('videos')
          .insert({
            provider: 'gatewaze',
            provider_video_id: `drive-${f.id}`,
            url: '',
            title: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 300),
            kind: 'full',
            status: 'draft',
            publish_state: 'draft',
            visibility: 'private',
            is_external: false,
            source: 'drive-import',
          })
          .select('id')
          .single();
        if (ins.error) {
          // A re-run hits the unique key on (provider, provider_video_id).
          const { data: prior } = await supabase.from('videos').select('id').eq('provider', 'gatewaze').eq('provider_video_id', `drive-${f.id}`).maybeSingle();
          if (!prior) throw new Error(ins.error.message);
          videoId = String(prior.id);
        } else {
          videoId = String(ins.data.id);
        }
      }

      if (f.size > 0 && result.bytes + f.size > cap) {
        result.stopped_on_budget = true;
        log('next file would exceed the run budget — stopping, re-run to continue');
        break;
      }

      const store = storeForNew(supabase, 'master');
      const assetIns = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind: 'master',
          storage_bucket: store.bucket,
          storage_provider: store.provider,
          storage_path: 'pending',
          filename: sanitiseFilename(f.name),
          mime_type: mime,
          bytes: f.size || null,
          state: 'uploading',
          source: 'drive_import',
        })
        .select('id')
        .single();
      if (assetIns.error) throw new Error(assetIns.error.message);
      assetId = String(assetIns.data.id);
      const path = `drive-import/${f.id}/${assetId}/${sanitiseFilename(f.name)}`;
      await supabase.from('video_assets').update({ storage_path: path }).eq('id', assetId);

      // Cut off at the per-file cap: Drive's reported size is a hint, not a
      // promise, and 0 means "unknown".
      const src = await openStream(auth, f.id);
      await store.putStream(path, src.body, mime, FILE_CAP_BYTES);
      const head = await store.head(path);
      const storedBytes = head.ok ? head.bytes : f.size;

      // Supersede a previous ready master so the one-ready-master index holds.
      await supabase.from('video_assets').update({ state: 'superseded' })
        .eq('video_id', videoId).eq('kind', 'master').eq('state', 'ready');
      await supabase.from('video_assets')
        .update({ state: 'ready', bytes: storedBytes, error: null })
        .eq('id', assetId);

      result.imported += 1;
      result.bytes += storedBytes;
      log(`imported ${f.name} (${(storedBytes / 1048576).toFixed(0)}MB) → ${match ? `${match.youtubeId} by ${match.by}` : 'unassigned'}`);
    } catch (err) {
      result.failed += 1;
      const msg = String((err as Error)?.message ?? err).slice(0, 300);
      log(`${f.name}: ${msg}`);
      if (assetId) {
        await supabase.from('video_assets').update({ state: 'failed', error: msg }).eq('id', assetId).eq('state', 'uploading');
      }
    }
  }

  log(
    `drive import ${folderId}: ${result.imported} imported (${result.matched} matched, ${result.unmatched} unmatched), `
    + `${result.skipped} skipped, ${result.failed} failed, ${(result.bytes / 1073741824).toFixed(2)}GB`
    + (result.stopped_on_budget ? ' (stopped on budget)' : ''),
  );
  return result;
}

export default async function importMastersFromDriveHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);
  const folderId = String(job?.data?.folder_id ?? job?.data?.folderId ?? '');
  const eventId = String(job?.data?.event_id ?? job?.data?.eventId ?? '');
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(folderId)) {
    log('import-masters-from-drive: no folder_id on the job — nothing to do');
    return;
  }
  await importMastersFromDrive(supabase, { folderId, eventId: UUID_RE.test(eventId) ? eventId : null }, log);
}
