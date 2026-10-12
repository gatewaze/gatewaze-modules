/**
 * Which podcast a connection's episodes belong to.
 *
 * Answered two ways, in this order:
 *
 *   1. `config.podcast_id` on the connection. Explicit, so it wins.
 *   2. A podcast whose `rss_feed_url` is the same feed as the connection's.
 *      Nothing extra to configure: the operator pastes the feed URL on the
 *      podcast page, which is where they would put it anyway.
 *
 * The second is a convenience and is deliberately refused when it is
 * ambiguous. Two podcasts carrying the same feed URL is a mistake somebody
 * made, and picking one of them would attach 555 episodes to a show at
 * random. Saying so and doing nothing is recoverable; guessing is not.
 */

import { normaliseFeedUrl } from './episodes.js';

export interface PodcastResolution {
  podcastId: string | null;
  /** How it was decided, for the worker's log and the operator's benefit. */
  via: 'config' | 'feed_url' | 'none' | 'ambiguous' | 'unavailable';
  detail?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolvePodcast(
  supabase: { from: (t: string) => any },
  conn: { id: string; label?: string | null; config?: Record<string, unknown> | null },
  feedUrl: string,
): Promise<PodcastResolution> {
  const configured = (conn.config ?? {}).podcast_id;

  // A configured id still has to exist. A podcast deleted after being
  // configured would otherwise have 555 episodes written against a dead
  // uuid, which no page would ever show.
  if (typeof configured === 'string' && UUID_RE.test(configured)) {
    const { data, error } = await supabase
      .from('podcasts')
      .select('id')
      .eq('id', configured)
      .limit(1);
    if (error) {
      return { podcastId: null, via: 'unavailable', detail: `podcasts table unreadable: ${error.message}` };
    }
    if ((data ?? []).length === 0) {
      return {
        podcastId: null,
        via: 'none',
        detail: `config.podcast_id ${configured} is not a podcast that exists`,
      };
    }
    return { podcastId: configured, via: 'config' };
  }
  if (typeof configured === 'string' && configured.length > 0) {
    return { podcastId: null, via: 'none', detail: 'config.podcast_id is not a uuid' };
  }

  // Fall back to matching the feed. Compared after normalising, because the
  // two URLs were typed by different people: scheme, "www." and a trailing
  // slash all vary without meaning anything.
  const wanted = normaliseFeedUrl(feedUrl);
  if (!wanted) return { podcastId: null, via: 'none', detail: 'the connection has no usable feed URL' };

  const { data, error } = await supabase
    .from('podcasts')
    .select('id, name, rss_feed_url')
    .not('rss_feed_url', 'is', null)
    .limit(500);
  if (error) {
    return { podcastId: null, via: 'unavailable', detail: `podcasts table unreadable: ${error.message}` };
  }

  const matches = (data ?? []).filter(
    (p: { rss_feed_url?: string | null }) => normaliseFeedUrl(p.rss_feed_url) === wanted,
  );
  if (matches.length === 1) return { podcastId: String(matches[0].id), via: 'feed_url' };
  if (matches.length > 1) {
    return {
      podcastId: null,
      via: 'ambiguous',
      detail:
        `${matches.length} podcasts carry this feed URL (`
        + `${matches.map((m: { name?: string }) => m.name ?? '?').join(', ')}`
        + '). Set config.podcast_id on the connection to say which one.',
    };
  }
  return {
    podcastId: null,
    via: 'none',
    detail:
      'no podcast carries this feed URL. Put it in the podcast\'s RSS feed field, '
      + 'or set config.podcast_id on the connection.',
  };
}
