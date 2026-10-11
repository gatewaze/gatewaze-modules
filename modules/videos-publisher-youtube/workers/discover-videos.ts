// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos-publisher-youtube:discover-videos — adopt everything already on a
 * connected channel.
 *
 * Connecting an account is not only about what Gatewaze publishes next. An
 * account like @AgenticAI-Foundation has years of video nobody here uploaded,
 * and the point of connecting is to take responsibility for all of it: know
 * it exists, track its numbers over time, and let somebody say which event or
 * podcast it belongs to.
 *
 * What it writes, per discovered video:
 *
 *   videos                — the canonical row, upserted on
 *                           (provider, provider_video_id) so a second run
 *                           adopts rather than duplicates
 *   video_publications    — origin 'discovered', against the connection,
 *                           which is what makes the EXISTING metrics
 *                           collector pick it up with no change
 *   video_subjects        — nothing. The absence is what "unassigned" means.
 *
 * It never overwrites a human's edit. A discovered video is somebody else's
 * work, and a title an operator has corrected here must not be reverted to
 * whatever YouTube currently says.
 *
 * The same shape should hold for every platform: list, upsert, link to the
 * connection, leave the subject empty. Only listChannelVideos is YouTube
 * specific.
 */

import { fetchVideoDetails, listChannelVideos } from '../lib/adapter.js';
import { serviceClient } from '../lib/service-client.js';
import { unsealSecret } from '../lib/secret-envelope.js';

const PROVIDER = 'youtube';

export interface DiscoverResult {
  connections: number;
  seen: number;
  created: number;
  adopted: number;
  publications: number;
  truncated: boolean;
  errors: string[];
}

async function clientCredentials(supabase): Promise<{ clientId: string; clientSecret: string } | null> {
  const { data } = await supabase
    .from('installed_modules').select('config').eq('id', 'videos-publisher-youtube').maybeSingle();
  const cfg = (data?.config ?? {}) as Record<string, unknown>;
  const clientId = String(cfg.clientId ?? '');
  const raw = String(cfg.clientSecret ?? '');
  if (!clientId || !raw) return null;
  return { clientId, clientSecret: unsealSecret(raw) ?? raw };
}

export async function discoverAll(
  supabase,
  opts: { log?: (m: string) => void; connectionId?: string | null; cap?: number } = {},
): Promise<DiscoverResult> {
  const log = opts.log ?? (() => {});
  const out: DiscoverResult = {
    connections: 0, seen: 0, created: 0, adopted: 0, publications: 0, truncated: false, errors: [],
  };

  const client = await clientCredentials(supabase);
  if (!client) {
    log('the YouTube OAuth client is not configured — nothing to discover');
    return out;
  }

  let q = supabase
    .from('video_platform_connections')
    .select('id, label, external_account_id, encrypted_credentials')
    .eq('platform', PROVIDER)
    .eq('state', 'connected');
  if (opts.connectionId) q = q.eq('id', opts.connectionId);
  const { data: connections, error } = await q;
  if (error) { out.errors.push(`connection read failed: ${error.message}`); return out; }

  for (const conn of connections ?? []) {
    out.connections += 1;
    const refreshToken = unsealSecret(conn.encrypted_credentials);
    if (!refreshToken) { out.errors.push(`${conn.label}: credentials could not be unsealed`); continue; }

    const listed = await listChannelVideos(client, refreshToken, { cap: opts.cap ?? 1000 });
    if (listed.error === 'auth') {
      await supabase.from('video_platform_connections').update({
        state: 'needs_reauth', state_detail: 'YouTube rejected the stored credentials',
      }).eq('id', conn.id);
      out.errors.push(`${conn.label}: needs reconnecting`);
      continue;
    }
    if (listed.error) out.errors.push(`${conn.label}: ${listed.error}`);
    if (listed.truncated) out.truncated = true;
    out.seen += listed.videos.length;
    if (listed.videos.length === 0) continue;

    // Durations in one extra quota unit per 50, which is also how a Short is
    // told from a full talk: there is no isShort field on the API.
    const details = await fetchVideoDetails(client, refreshToken, listed.videos.map((v) => v.externalId));

    // Which of these do we already hold? Read once rather than per video.
    const existing = new Map<string, { id: string; title: string | null }>();
    const ids = listed.videos.map((v) => v.externalId);
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase
        .from('videos')
        .select('id, provider_video_id, title')
        .eq('provider', PROVIDER)
        .in('provider_video_id', ids.slice(i, i + 200));
      for (const r of data ?? []) existing.set(String(r.provider_video_id), { id: r.id, title: r.title });
    }

    for (const v of listed.videos) {
      const detail = details.get(v.externalId);
      const already = existing.get(v.externalId);

      let videoId: string;
      if (already) {
        videoId = already.id;
        out.adopted += 1;
        // Fill blanks only. A title or description corrected by a human here
        // is better than whatever the platform currently says, and reverting
        // it on every run would make the edit look broken.
        const patch: Record<string, unknown> = {};
        if (!already.title && v.title) patch.title = v.title;
        if (detail?.durationSeconds) patch.duration_seconds = detail.durationSeconds;
        patch.discovered_via_connection_id = conn.id;
        await supabase.from('videos').update(patch).eq('id', videoId);
      } else {
        const { data, error: insErr } = await supabase
          .from('videos')
          .insert({
            provider: PROVIDER,
            provider_video_id: v.externalId,
            url: `https://www.youtube.com/watch?v=${v.externalId}`,
            title: v.title,
            description: v.description,
            thumbnail_url: v.thumbnailUrl,
            duration_seconds: detail?.durationSeconds ?? null,
            published_at: v.publishedAt,
            channel_id: conn.external_account_id,
            channel_title: conn.label,
            kind: detail?.kind ?? 'master',
            source: 'platform_discovery',
            is_external: true,
            discovered_via_connection_id: conn.id,
            raw: v.raw,
          })
          .select('id')
          .single();
        if (insErr) {
          // A concurrent run may have inserted it between the read and here.
          if (!/duplicate key/i.test(insErr.message)) {
            out.errors.push(`${v.externalId}: ${insErr.message}`);
          }
          continue;
        }
        videoId = data.id;
        out.created += 1;
      }

      // The publication is what the metrics collector walks, so without this
      // a discovered video would be adopted and then never measured.
      const { error: pubErr } = await supabase
        .from('video_publications')
        .upsert({
          video_id: videoId,
          platform: PROVIDER,
          connection_id: conn.id,
          external_id: v.externalId,
          external_url: `https://www.youtube.com/watch?v=${v.externalId}`,
          state: 'published',
          origin: 'discovered',
          discovered_at: new Date().toISOString(),
          published_at: v.publishedAt,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'connection_id,external_id' });
      if (pubErr) out.errors.push(`${v.externalId}: publication ${pubErr.message}`);
      else out.publications += 1;
    }

    log(`${conn.label}: ${listed.videos.length} video(s) on the channel`);
  }

  log(
    `discover-videos: ${out.created} new, ${out.adopted} already known, ` +
    `${out.publications} publication(s)` +
    `${out.truncated ? ' (capped — run again to continue)' : ''}` +
    `${out.errors.length ? `, ${out.errors.length} problem(s)` : ''}`,
  );
  return out;
}

export default async function discoverVideosHandler(job, ctx): Promise<DiscoverResult> {
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos-publisher-youtube] ${m}`);
  return discoverAll(supabase, {
    log,
    connectionId: job?.data?.connection_id ?? null,
    cap: job?.data?.cap,
  });
}
