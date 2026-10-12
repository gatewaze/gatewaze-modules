/**
 * Turning feed items into podcast episodes.
 *
 * Two tables describe the same 555 things, on purpose. `videos` is the
 * platform asset: one row per thing that exists on an account, carrying the
 * numbers. `podcast_episodes` is the editorial record: the title an editor
 * corrected, the show notes, the guests. `video_subjects` joins them, and
 * that join is what makes a per-episode listen count possible.
 *
 * So discovery writes both. It reads the feed once and produces a video, an
 * episode, and the link between them.
 *
 * The episodes table belongs to the `podcasts` module, which is not in this
 * repo and may not be installed. Every write here is therefore guarded on the
 * table existing, and discovery carries on without it — the videos still
 * arrive and still collect metrics, they just wait in the unassigned queue.
 */

import type { FeedEpisode } from './rss.js';

/** Fields `podcast_episodes` takes from a feed item. */
export interface EpisodeFields {
  podcast_id: string;
  title: string;
  slug: string | null;
  description: string | null;
  episode_number: number | null;
  publish_date: string | null;
  audio_url: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  /** 'published', because it is already public. Nothing here is a draft. */
  status: string;
  publish_state: string;
}

/**
 * A URL reduced to the parts that identify it.
 *
 * Used only to match a connection's feed against a podcast's `rss_feed_url`,
 * where the two were typed by different people at different times. Scheme,
 * a leading "www.", a trailing slash and the case of the host all vary
 * without meaning anything. The path's case is preserved, because a feed id
 * like `/s/174cb1b8/` is a real identifier.
 */
export function normaliseFeedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}${u.search}`;
}

/**
 * A slug for an episode title.
 *
 * `podcast_episodes.slug` has no unique index, so a collision does not error.
 * It still matters for a readable URL, so the episode number is prefixed when
 * the feed gives one. Without a number two episodes called "Part 1" collide,
 * and whichever the router finds first wins.
 */
export function episodeSlug(title: string, episodeNumber: number | null): string | null {
  const base = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Ürün" becomes "urun" rather than "rn".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '');
  if (!base) return null;
  return episodeNumber && episodeNumber > 0 ? `${episodeNumber}-${base}` : base;
}

/**
 * Feed description markup reduced to plain text.
 *
 * Every one of the 555 items in the AAIF feed carries HTML in <description>,
 * which is normal for a podcast feed. It is stored as text rather than as
 * markup for two reasons. The column is read as text everywhere it is used
 * today, so the tags would show up as literal angle brackets on the page.
 * And a feed is a third party: storing its markup would put an unsanitised
 * `<script>` or `<img onerror=...>` one careless `dangerouslySetInnerHTML`
 * away from running on our own site, and the natural way to render show notes
 * is exactly that careless call. Stripping at the boundary means no renderer
 * has to be careful.
 *
 * Three things about the order, each of which was wrong in the first version
 * and caught by CodeQL as "incomplete multi-character sanitization":
 *
 *   - Entities are decoded FIRST. Decoding afterwards leaves the literal text
 *     "<script>" sitting in the column, which is safe only for as long as
 *     every reader escapes it. Decoding first turns an escaped tag into a tag,
 *     which the next step then removes.
 *   - Tags are stripped to a FIXED POINT. One pass can splice what is left of
 *     two fragments into a tag that was not there before, e.g. "<scr<x>ipt>"
 *     leaves "ipt>" from one angle and can reassemble from another.
 *   - Any angle bracket that survives all of that is dropped. After this, no
 *     element can be reconstructed from the output however it is later
 *     rendered, so no downstream renderer has to be careful.
 */
export function toPlainText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;

  let text = value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');

  // A <br> or </p> is a sentence boundary, not nothing.
  text = text.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, ' ');

  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);

  text = text
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * A feed URL that is safe to store, or null.
 *
 * These end up in `podcast_episodes.audio_url` and `.thumbnail_url`, which
 * the podcasts module reads and renders directly. Nothing between the feed
 * and that page would stop a `javascript:` value, so it stops here. A real
 * enclosure is always http(s) anyway, so nothing legitimate is lost.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : null;
}

/**
 * A feed item as an episode row.
 *
 * The audio URL is kept because it is what OP3 counts requests for, so it is
 * the join from a download figure back to this episode.
 */
export function episodeFieldsFromFeed(ep: FeedEpisode, podcastId: string): EpisodeFields {
  const title = ep.title?.trim() || 'Untitled episode';
  return {
    podcast_id: podcastId,
    title,
    slug: episodeSlug(title, ep.episodeNumber),
    description: toPlainText(ep.description),
    episode_number: ep.episodeNumber ?? null,
    publish_date: ep.publishedAt ?? null,
    audio_url: safeHttpUrl(ep.audioUrl),
    thumbnail_url: safeHttpUrl(ep.imageUrl),
    duration_seconds: ep.durationSeconds ?? null,
    status: 'published',
    publish_state: 'published',
  };
}

/**
 * Which fields discovery may overwrite on an episode it has seen before.
 *
 * Not the title, the description or the show notes. An editor corrects those,
 * and reverting them on the next run would make their work look broken. The
 * feed is authoritative only about the things an editor would not touch: when
 * it went out, how long it is, and where the audio lives.
 */
export function episodeRefreshFields(fields: EpisodeFields): Partial<EpisodeFields> {
  const patch: Partial<EpisodeFields> = {};
  if (fields.publish_date) patch.publish_date = fields.publish_date;
  if (fields.duration_seconds) patch.duration_seconds = fields.duration_seconds;
  if (fields.audio_url) patch.audio_url = fields.audio_url;
  if (fields.episode_number) patch.episode_number = fields.episode_number;
  return patch;
}
