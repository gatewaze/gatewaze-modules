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

import { fetchVideoDetails, listChannelVideos, MAX_DISCOVERY_CAP, NIGHTLY_CAP, visibilityFor } from '../lib/adapter.js';

import { serviceClient } from '../lib/service-client.js';
import { unsealSecret } from '../lib/secret-envelope.js';
import { loadClientCredentials } from '../lib/client-credentials.js';

/**
 * The adapter speaks the ASSET vocabulary, where a full recording is a
 * 'master'. `videos.kind` speaks a different one and its CHECK allows only
 * full | short | clip | trailer | livestream. Writing 'master' there violates
 * the constraint and fails EVERY discovered video, which is how this was
 * found.
 */
function videoKind(k: 'master' | 'short' | undefined): 'full' | 'short' {
  return k === 'short' ? 'short' : 'full';
}

const PROVIDER = 'youtube';

export interface DiscoverResult {
  connections: number;
  seen: number;
  created: number;
  adopted: number;
  publications: number;
  /** Rows published by the channel's auto-publish setting this run. */
  published: number;
  truncated: boolean;
  errors: string[];
}

// One reading of the OAuth client for routes and workers alike: see
// lib/client-credentials.ts. A sealed secret that cannot be unsealed is null,
// never the ciphertext.
const clientCredentials = loadClientCredentials;

export async function discoverAll(
  supabase,
  opts: { log?: (m: string) => void; connectionId?: string | null; cap?: number } = {},
): Promise<DiscoverResult> {
  const log = opts.log ?? (() => {});
  const out: DiscoverResult = {
    connections: 0, seen: 0, created: 0, adopted: 0, publications: 0, published: 0, truncated: false, errors: [],
  };

  const client = await clientCredentials(supabase);
  if (!client) {
    log('the YouTube OAuth client is not configured — nothing to discover');
    return out;
  }

  let q = supabase
    .from('video_platform_connections')
    .select('id, label, external_account_id, encrypted_credentials, config')
    .eq('platform', PROVIDER)
    .eq('state', 'connected');
  if (opts.connectionId) q = q.eq('id', opts.connectionId);
  const { data: connections, error } = await q;
  if (error) { out.errors.push(`connection read failed: ${error.message}`); return out; }

  const cap = clampCap(opts.cap);

  for (const conn of connections ?? []) {
    out.connections += 1;
    const refreshToken = unsealSecret(conn.encrypted_credentials);
    if (!refreshToken) { out.errors.push(`${conn.label}: credentials could not be unsealed`); continue; }

    // One run per channel at a time. The jobs queue runs two handlers at once
    // and ignores a module's per-worker concurrency, so a Sync now during the
    // nightly run would otherwise walk the same channel twice.
    const lease = await claimLease(supabase, conn.id);
    if (lease === 'held') { log(`${conn.label}: another discovery run is in progress — skipped`); continue; }
    if (lease === 'error') { out.errors.push(`${conn.label}: could not take the discovery lease`); continue; }

    const summary = await discoverConnection(supabase, client, refreshToken, conn, cap, out, log);
    await finishLease(supabase, conn.id, summary, lease === 'none');
  }

  log(
    `discover-videos: ${out.created} new, ${out.adopted} already known, ` +
    `${out.publications} publication(s), ${out.published} published` +
    `${out.truncated ? ` (reached the ${cap.toLocaleString('en')}-upload limit; older uploads were not read)` : ''}` +
    `${out.errors.length ? `, ${out.errors.length} problem(s)` : ''}`,
  );
  return out;
}

/** A job's cap, bounded to what the adapter allows whoever queued it. */
export function clampCap(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return NIGHTLY_CAP;
  return Math.min(MAX_DISCOVERY_CAP, Math.floor(n));
}

/**
 * Take the per-connection lease (videos migration 022). 'none' when the
 * function is missing because the videos module is older, in which case the
 * run proceeds without one, as it always did.
 */
async function claimLease(supabase, connectionId: string): Promise<'taken' | 'held' | 'none' | 'error'> {
  const { data, error } = await supabase.rpc('claim_video_discovery', { p_connection: connectionId });
  if (error) {
    return /claim_video_discovery|PGRST202|42883|could not find the function/i.test(`${error.code ?? ''} ${error.message ?? ''}`)
      ? 'none'
      : 'error';
  }
  return data === true ? 'taken' : 'held';
}

/** Release the lease and record what the run did, for the channels page. */
async function finishLease(supabase, connectionId: string, detail: string, noLease: boolean): Promise<void> {
  if (noLease) return;
  await supabase
    .from('video_platform_connections')
    .update({ discovery_finished_at: new Date().toISOString(), discovery_detail: detail.slice(0, 500) })
    .eq('id', connectionId);
}

/** Walk one connected channel. Returns a one-line summary for the operator. */
async function discoverConnection(supabase, client, refreshToken: string, conn, cap: number, out: DiscoverResult, log): Promise<string> {
  // Public uploads are published on discovery when the channel asks for it,
  // so they reach the public site and /api/v1/videos without a click each.
  const autoPublish = (conn.config ?? {}).auto_publish === true;
  const before = { created: out.created, adopted: out.adopted, published: out.published };
  {
    const listed = await listChannelVideos(client, refreshToken, { cap });
    if (listed.error === 'auth') {
      await supabase.from('video_platform_connections').update({
        state: 'needs_reauth', state_detail: 'YouTube rejected the stored credentials',
      // Only while still connected: a disconnect mid-run revokes the token,
      // and that must not come back as "needs reauth".
      }).eq('id', conn.id).eq('state', 'connected');
      out.errors.push(`${conn.label}: needs reconnecting`);
      return 'YouTube rejected the stored credentials; reconnect this channel.';
    }
    if (listed.error) out.errors.push(`${conn.label}: ${listed.error}`);
    if (listed.truncated) out.truncated = true;
    out.seen += listed.videos.length;
    if (listed.videos.length === 0) return listed.error ? `Could not list uploads: ${listed.error}` : 'No uploads found.';

    // Durations in one extra quota unit per 50, which is also how a Short is
    // told from a full talk: there is no isShort field on the API.
    const details = await fetchVideoDetails(client, refreshToken, listed.videos.map((v) => v.externalId));

    // Which of these do we already hold? Read once rather than per video.
    const existing = new Map<string, { id: string; title: string | null; status: string | null; visibility: string | null }>();
    const ids = listed.videos.map((v) => v.externalId);
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase
        .from('videos')
        .select('id, provider_video_id, title, status, visibility')
        .eq('provider', PROVIDER)
        .in('provider_video_id', ids.slice(i, i + 200));
      for (const r of data ?? []) {
        existing.set(String(r.provider_video_id), { id: r.id, title: r.title, status: r.status ?? null, visibility: r.visibility ?? null });
      }
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
        // The platform may only HIDE a video here, never unhide one. A talk
        // pulled to private or unlisted on YouTube is hidden at once; one an
        // editor hid in Gatewaze stays hidden whatever YouTube says.
        const hiddenOnPlatform = v.privacy !== null && v.privacy !== 'public';
        if (hiddenOnPlatform && already.visibility !== 'private') patch.visibility = 'private';
        // Auto-publish reaches only drafts nobody has decided on: 'archived'
        // (unpublished by hand), 'rejected' and 'pending_review' are left alone.
        if (autoPublish && v.privacy === 'public' && already.status === 'draft' && already.visibility === 'public') {
          patch.status = 'published';
          patch.publish_state = 'published';
        }
        patch.discovered_via_connection_id = conn.id;
        const { error: upErr } = await supabase.from('videos').update(patch).eq('id', videoId);
        if (upErr) out.errors.push(`${v.externalId}: update ${upErr.message}`);
        else if (patch.status === 'published') out.published += 1;
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
            kind: videoKind(detail?.kind),
            // Private or unlisted on YouTube, or unknown, is private here.
            visibility: visibilityFor(v.privacy),
            // Published at once only when the channel auto-publishes and the
            // upload is public; otherwise a draft for somebody to decide.
            ...(autoPublish && v.privacy === 'public'
              ? { status: 'published', publish_state: 'published' }
              : { status: 'draft', publish_state: 'draft' }),
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
        if (autoPublish && v.privacy === 'public') out.published += 1;
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
    return [
      `Read ${listed.videos.length.toLocaleString('en')} upload(s): ${out.created - before.created} new, ${out.adopted - before.adopted} already known`,
      autoPublish ? `, ${out.published - before.published} published` : '',
      listed.truncated
        ? `. Reached the ${cap.toLocaleString('en')}-upload limit, so older uploads were not read.`
        : '.',
    ].join('');
  }
}

export default async function discoverVideosHandler(job, ctx): Promise<DiscoverResult> {
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos-publisher-youtube] ${m}`);
  return discoverAll(supabase, {
    log,
    connectionId: job?.data?.connection_id ?? null,
    // Bounded inside discoverAll whoever queued the job.
    cap: job?.data?.cap,
  });
}
