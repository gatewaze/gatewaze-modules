// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos-publisher-spotify:discover-episodes — the episode catalogue, from
 * the feed.
 *
 * Same shape as the YouTube discovery worker, and deliberately so: list,
 * upsert a `videos` row, link it to the connection with a publication, leave
 * the subject empty. Only the listing step is platform specific.
 *
 * An episode is a `videos` row with provider 'spotify' and the feed's <guid>
 * as provider_video_id. The guid is the right key because it is stable
 * across edits and retitles — verified on the real feed, 555 episodes and
 * 555 distinct guids — whereas the audio URL changes if the file is
 * re-uploaded and the title changes whenever somebody improves it.
 *
 * The audio URL is still stored, because OP3 counts requests for the
 * enclosure and that URL is the only join back from its numbers to our rows.
 */

import { fetchFeed } from '../lib/rss.js';
import { feedIsPrefixed } from '../lib/op3.js';
import { serviceClient } from '../lib/service-client.js';
import { episodeFieldsFromFeed, episodeRefreshFields } from '../lib/episodes.js';
import { resolvePodcast } from '../lib/podcast-link.js';

const PROVIDER = 'spotify';

export interface DiscoverEpisodesResult {
  connections: number;
  seen: number;
  created: number;
  adopted: number;
  publications: number;
  /** Episode rows written into the podcasts module's table. */
  episodesCreated: number;
  /** Videos joined to an episode, which is what takes them out of triage. */
  episodesLinked: number;
  /** Connections we could not work out a podcast for, and why. */
  unlinked: string[];
  /** Connections whose feed carries no OP3 prefix, so nothing will be counted. */
  unprefixed: string[];
  errors: string[];
}

export async function discoverEpisodes(
  supabase,
  opts: { log?: (m: string) => void; connectionId?: string | null } = {},
): Promise<DiscoverEpisodesResult> {
  const log = opts.log ?? (() => {});
  const out: DiscoverEpisodesResult = {
    connections: 0, seen: 0, created: 0, adopted: 0, publications: 0,
    episodesCreated: 0, episodesLinked: 0, unlinked: [], unprefixed: [], errors: [],
  };

  let q = supabase
    .from('video_platform_connections')
    .select('id, label, external_account_id, config, state')
    .eq('platform', PROVIDER);
  if (opts.connectionId) q = q.eq('id', opts.connectionId);
  const { data: connections, error } = await q;
  if (error) { out.errors.push(`connection read failed: ${error.message}`); return out; }

  for (const conn of connections ?? []) {
    const feedUrl = String((conn.config ?? {}).feed_url ?? '');
    if (!feedUrl) {
      out.errors.push(`${conn.label}: no feed_url in config`);
      continue;
    }
    out.connections += 1;

    // No credential involved. A feed is published to be read, which is the
    // whole reason this route was chosen over the dashboard.
    const res = await fetchFeed(feedUrl);
    if (!res.ok || !res.feed) {
      out.errors.push(`${conn.label}: ${res.error ?? 'feed could not be read'}`);
      await supabase.from('video_platform_connections').update({
        state_detail: `feed could not be read: ${res.error ?? 'unknown'}`,
      }).eq('id', conn.id);
      continue;
    }

    const feed = res.feed;
    out.seen += feed.episodes.length;
    if (feed.skipped > 0) out.errors.push(`${conn.label}: ${feed.skipped} unreadable item(s) in the feed`);

    // Tell the operator when OP3 will count nothing, rather than letting the
    // collector return no_data forever and look like a broken integration.
    if (!feedIsPrefixed(feed.episodes[0]?.audioUrl)) out.unprefixed.push(conn.label);

    const guids = feed.episodes.map((e) => e.guid);
    const existing = new Map<string, { id: string; title: string | null }>();
    for (let i = 0; i < guids.length; i += 200) {
      const { data } = await supabase
        .from('videos')
        .select('id, provider_video_id, title')
        .eq('provider', PROVIDER)
        .in('provider_video_id', guids.slice(i, i + 200));
      for (const r of data ?? []) existing.set(String(r.provider_video_id), { id: r.id, title: r.title });
    }

    // Which podcast these episodes belong to. Resolved once per connection,
    // not per episode.
    const podcast = await resolvePodcast(supabase, conn, feedUrl);
    if (!podcast.podcastId) {
      // Not an error. The videos still arrive and still collect metrics; they
      // wait in the unassigned queue until somebody says where they go. Said
      // out loud so that waiting looks like a pending setup step rather than
      // a broken integration.
      out.unlinked.push(`${conn.label}: ${podcast.detail ?? podcast.via}`);
    }

    // What is already linked, batched rather than asked per episode. Only
    // videos we have seen before can have a link; a video created in the loop
    // below cannot.
    const linkedEpisodeByVideo = new Map<string, string>();
    if (podcast.podcastId) {
      const knownIds = [...existing.values()].map((v) => v.id);
      const subjectIds: string[] = [];
      for (let i = 0; i < knownIds.length; i += 200) {
        const { data } = await supabase
          .from('video_subjects')
          .select('video_id, subject_id')
          .eq('subject_type', 'podcast_episode')
          .in('video_id', knownIds.slice(i, i + 200));
        for (const r of data ?? []) {
          linkedEpisodeByVideo.set(String(r.video_id), String(r.subject_id));
          subjectIds.push(String(r.subject_id));
        }
      }

      // video_subjects is polymorphic, so subject_id carries no foreign key
      // and a deleted episode leaves the link behind. Treating that link as
      // proof the episode exists would mean the episode never came back. So
      // the links are confirmed against the episodes that are actually there,
      // and any pointing at nothing are dropped.
      const live = new Set<string>();
      for (let i = 0; i < subjectIds.length; i += 200) {
        const { data } = await supabase
          .from('podcast_episodes')
          .select('id')
          .in('id', subjectIds.slice(i, i + 200));
        for (const r of data ?? []) live.add(String(r.id));
      }
      const stale: string[] = [];
      for (const [videoId, episodeId] of [...linkedEpisodeByVideo]) {
        if (!live.has(episodeId)) {
          linkedEpisodeByVideo.delete(videoId);
          stale.push(episodeId);
        }
      }
      // Delete them, not just forget them. A link left pointing at a deleted
      // episode is a subject in its own right as far as video_subject_reach
      // is concerned, so it would show up as an episode with numbers and no
      // name, forever, and it would keep the video out of the unassigned
      // queue while belonging to nothing.
      for (let i = 0; i < stale.length; i += 200) {
        const { error } = await supabase
          .from('video_subjects')
          .delete()
          .eq('subject_type', 'podcast_episode')
          .in('subject_id', stale.slice(i, i + 200));
        if (error) out.errors.push(`stale link cleanup: ${error.message}`);
      }
      if (stale.length > 0) log(`${conn.label}: dropped ${stale.length} link(s) to deleted episodes`);
    }

    for (const ep of feed.episodes) {
      const already = existing.get(ep.guid);
      let videoId: string;

      if (already) {
        videoId = already.id;
        out.adopted += 1;
        // Blanks only. A title an operator corrected here is better than the
        // feed's, and reverting it on every run would make the edit look broken.
        const patch: Record<string, unknown> = { discovered_via_connection_id: conn.id };
        if (!already.title && ep.title) patch.title = ep.title;
        if (ep.durationSeconds) patch.duration_seconds = ep.durationSeconds;
        await supabase.from('videos').update(patch).eq('id', videoId);
      } else {
        const { data, error: insErr } = await supabase
          .from('videos')
          .insert({
            provider: PROVIDER,
            provider_video_id: ep.guid,
            url: ep.link ?? ep.audioUrl,
            title: ep.title,
            description: ep.description,
            thumbnail_url: ep.imageUrl,
            duration_seconds: ep.durationSeconds,
            published_at: ep.publishedAt,
            channel_id: conn.external_account_id,
            channel_title: conn.label,
            // An episode is a full recording, not a clip. videos.kind allows
            // full | short | clip | trailer | livestream.
            kind: 'full',
            source: 'platform_discovery',
            is_external: true,
            discovered_via_connection_id: conn.id,
            // The enclosure is OP3's join key, so it has to survive.
            raw: { audio_url: ep.audioUrl, episode_number: ep.episodeNumber, guid: ep.guid },
          })
          .select('id')
          .single();
        if (insErr) {
          if (!/duplicate key/i.test(insErr.message)) out.errors.push(`${ep.guid}: ${insErr.message}`);
          continue;
        }
        videoId = data.id;
        out.created += 1;
      }

      const { error: pubErr } = await supabase
        .from('video_publications')
        .upsert({
          video_id: videoId,
          platform: PROVIDER,
          connection_id: conn.id,
          external_id: ep.guid,
          external_url: ep.link,
          state: 'published',
          origin: 'discovered',
          discovered_at: new Date().toISOString(),
          published_at: ep.publishedAt,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'connection_id,external_id' });
      if (pubErr) out.errors.push(`${ep.guid}: publication ${pubErr.message}`);
      else out.publications += 1;

      if (!podcast.podcastId) continue;

      const fields = episodeFieldsFromFeed(ep, podcast.podcastId);
      const linked = linkedEpisodeByVideo.get(videoId);

      if (linked) {
        // Already an episode. Refresh only the facts the feed owns; the title
        // and the description belong to whoever edited them last.
        const patch = episodeRefreshFields(fields);
        if (Object.keys(patch).length > 0) {
          const { error } = await supabase.from('podcast_episodes').update(patch).eq('id', linked);
          if (error) out.errors.push(`${ep.guid}: episode refresh ${error.message}`);
        }
        out.episodesLinked += 1;
        continue;
      }

      const { data: epRow, error: epErr } = await supabase
        .from('podcast_episodes')
        .insert(fields)
        .select('id')
        .single();
      if (epErr) {
        out.errors.push(`${ep.guid}: episode ${epErr.message}`);
        continue;
      }
      out.episodesCreated += 1;

      // The join is what takes the video out of the unassigned queue and
      // makes a per-episode listen count possible. Written last, so a
      // failure here leaves an episode an operator can see rather than a
      // link to an episode that was never created.
      const { error: linkErr } = await supabase
        .from('video_subjects')
        .upsert({
          video_id: videoId,
          subject_type: 'podcast_episode',
          subject_id: epRow.id,
          source: 'auto',
          confidence: 1.0,
        }, { onConflict: 'video_id,subject_type,subject_id' });
      if (linkErr) out.errors.push(`${ep.guid}: link ${linkErr.message}`);
      else out.episodesLinked += 1;
    }

    log(
      `${conn.label}: ${feed.episodes.length} episode(s) in the feed`
      + (podcast.podcastId ? ` → podcast ${podcast.podcastId} (via ${podcast.via})` : ''),
    );
  }

  for (const label of out.unprefixed) {
    log(`${label}: the feed carries no OP3 prefix, so no downloads will be counted until it does`);
  }
  for (const note of out.unlinked) {
    log(`${note} — the episodes will wait in the unassigned queue until this is set`);
  }
  log(
    `discover-episodes: ${out.created} new, ${out.adopted} already known, ` +
    `${out.publications} publication(s), ` +
    `${out.episodesCreated} episode(s) created, ${out.episodesLinked} linked` +
    `${out.errors.length ? `, ${out.errors.length} problem(s)` : ''}`,
  );
  return out;
}

export default async function discoverEpisodesHandler(job, ctx): Promise<DiscoverEpisodesResult> {
  const supabase = serviceClient();
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos-publisher-spotify] ${m}`);
  return discoverEpisodes(supabase, { log, connectionId: job?.data?.connection_id ?? null });
}
