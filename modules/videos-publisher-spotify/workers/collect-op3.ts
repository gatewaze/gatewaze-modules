// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos-publisher-spotify:collect-op3 — download counts, per episode, per
 * listening app.
 *
 * The only unattended podcast metric source with a documented API and no
 * terms-of-service question. What it costs us, and what the UI must say:
 *
 *   - these are DOWNLOADS, not Spotify's thirty-second plays. The two will
 *     never reconcile, and labelling an OP3 figure as "Spotify plays" would
 *     be worse than showing nothing.
 *   - nothing is counted before the OP3 prefix went into the feed. There is
 *     no backfill, so an empty result on a freshly prefixed show is correct
 *     rather than broken.
 *
 * That second point is why a missing figure is no_data and never zero. 555
 * episodes suddenly reporting 0 downloads would look like the show had died,
 * when it would actually mean the prefix was added yesterday.
 */

import { downloadsByApp, episodeDownloadCounts } from '../lib/op3.js';
import { serviceClient } from '../lib/service-client.js';
import { unsealSecret } from '../lib/secret-envelope.js';

const PROVIDER = 'spotify';
const PAGE = 500;

export interface CollectOp3Result {
  connections: number;
  publications: number;
  written: number;
  by_status: Record<string, number>;
  by_app: Record<string, number>;
  errors: string[];
}

export async function collectOp3(
  supabase,
  opts: { log?: (m: string) => void; forDate?: string } = {},
): Promise<CollectOp3Result> {
  const log = opts.log ?? (() => {});
  const out: CollectOp3Result = {
    connections: 0, publications: 0, written: 0, by_status: {}, by_app: {}, errors: [],
  };
  const bump = (s: string) => { out.by_status[s] = (out.by_status[s] ?? 0) + 1; };

  // Yesterday: today's downloads are still arriving, and storing a partial
  // day under today's date then never revisiting bakes in an undercount.
  const day = opts.forDate ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const { data: connections, error } = await supabase
    .from('video_platform_connections')
    .select('id, label, config, encrypted_credentials, state')
    .eq('platform', PROVIDER)
    .eq('collection_enabled', true);
  if (error) { out.errors.push(`connection read failed: ${error.message}`); return out; }

  for (const conn of connections ?? []) {
    const showUuid = String((conn.config ?? {}).op3_show_uuid ?? '');
    const token = unsealSecret(conn.encrypted_credentials);
    if (!showUuid) { out.errors.push(`${conn.label}: no op3_show_uuid in config`); continue; }
    if (!token) { out.errors.push(`${conn.label}: no OP3 token stored`); continue; }
    out.connections += 1;

    const counts = await episodeDownloadCounts(showUuid, token);
    if (counts.status === 'auth') {
      await supabase.from('video_platform_connections').update({
        state: 'needs_reauth',
        state_detail: 'OP3 rejected the stored token',
        last_collect_status: 'auth',
        last_collected_at: new Date().toISOString(),
      }).eq('id', conn.id);
      out.errors.push(`${conn.label}: OP3 token rejected`);
      continue;
    }
    if (counts.status !== 'ok' || !counts.data) {
      // Almost always "the prefix went in recently". Recorded as no_data on
      // the connection so the operator sees WHY rather than an empty chart.
      await supabase.from('video_platform_connections').update({
        last_collect_status: 'no_data',
        last_collect_detail: counts.detail ?? 'OP3 returned nothing yet',
        last_collected_at: new Date().toISOString(),
      }).eq('id', conn.id);
      log(`${conn.label}: ${counts.detail ?? 'no data from OP3 yet'}`);
      continue;
    }

    // OP3 keys on the enclosure URL, which discovery stored in videos.raw.
    const byAudioUrl = new Map<string, string>();
    for (let from = 0; ; from += PAGE) {
      const { data } = await supabase
        .from('video_publications')
        .select('id, video_id, videos!inner(raw)')
        .eq('connection_id', conn.id)
        .eq('state', 'published')
        .range(from, from + PAGE - 1);
      const batch = data ?? [];
      for (const p of batch) {
        const v = Array.isArray(p.videos) ? p.videos[0] : p.videos;
        const audio = String(v?.raw?.audio_url ?? '');
        // OP3 reports the PREFIXED url; ours may be the bare one. Match on
        // the tail so both shapes meet.
        if (audio) byAudioUrl.set(audio.replace(/^https?:\/\//, ''), p.id);
      }
      if (batch.length < PAGE) break;
    }
    out.publications += byAudioUrl.size;

    const rows = [];
    for (const c of counts.data) {
      const key = c.episodeUrl.replace(/^https?:\/\//, '').replace(/^op3\.dev\/e\//, '');
      const publicationId = byAudioUrl.get(key);
      if (!publicationId) continue;
      // allTime is the cumulative figure, which is what a daily snapshot of
      // a cumulative metric should store — the same shape as YouTube's.
      const views = c.allTime ?? c.day30 ?? c.day7;
      const status = views === undefined ? 'no_data' : 'ok';
      bump(status);
      rows.push({
        publication_id: publicationId,
        connection_id: conn.id,
        collected_for: day,
        status,
        status_detail: status === 'no_data' ? 'OP3 had no count for this episode' : null,
        // Downloads, not plays. The column is shared; the meaning is
        // recorded in raw so a chart can label it correctly.
        views: views ?? null,
        raw: { source: 'op3', metric: 'downloads', day1: c.day1, day7: c.day7, day30: c.day30, all_time: c.allTime },
        collected_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      const { error: wErr } = await supabase
        .from('video_metrics')
        .upsert(rows, { onConflict: 'publication_id,collected_for' });
      if (wErr) out.errors.push(`${conn.label}: ${wErr.message}`);
      else out.written += rows.length;
    }

    // The per-app split, which is the only honest way to say how much of
    // this came through Spotify rather than Apple or Overcast.
    const apps = await downloadsByApp(showUuid, token, { start: day, end: day });
    if (apps.status === 'ok' && apps.data) {
      for (const a of apps.data) out.by_app[a.appName] = (out.by_app[a.appName] ?? 0) + a.downloads;
      await supabase.from('video_channel_metrics').upsert({
        connection_id: conn.id,
        collected_for: day,
        status: 'ok',
        raw: { source: 'op3', by_app: out.by_app },
        collected_at: new Date().toISOString(),
      }, { onConflict: 'connection_id,collected_for' });
    }

    const anyOk = rows.some((r) => r.status === 'ok');
    await supabase.from('video_platform_connections').update({
      last_collected_at: new Date().toISOString(),
      last_collect_status: anyOk ? 'ok' : 'no_data',
      last_collect_detail: anyOk ? null : 'OP3 returned no counts for any episode',
    }).eq('id', conn.id);

    log(`${conn.label}: ${rows.length} episode(s) for ${day}`);
  }

  log(
    `collect-op3: ${out.written} row(s) across ${out.connections} connection(s)` +
    `${out.errors.length ? `, ${out.errors.length} problem(s)` : ''}`,
  );
  return out;
}

export default async function collectOp3Handler(job, ctx): Promise<CollectOp3Result> {
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos-publisher-spotify] ${m}`);
  return collectOp3(supabase, { log, forDate: job?.data?.for_date });
}
