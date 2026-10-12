/**
 * Feed items becoming podcast episodes (lib/episodes.ts, lib/podcast-link.ts).
 *
 * These two files decide where 555 episodes land and what they say, so the
 * cases that matter are the ones where getting it wrong is silent: a feed URL
 * that differs only by a trailing slash, two podcasts claiming the same feed,
 * and feed markup reaching a column the rest of the system reads as text.
 */

import { describe, it, expect } from 'vitest';
import {
  episodeFieldsFromFeed,
  episodeRefreshFields,
  episodeSlug,
  normaliseFeedUrl,
  toPlainText,
} from '../lib/episodes';
import { resolvePodcast } from '../lib/podcast-link';
import type { FeedEpisode } from '../lib/rss';

const PODCAST = '615458b5-80f3-4d5b-ad6c-7347b55b68c6';

const EP: FeedEpisode = {
  guid: '5cbf4845-c44c-4cd5-a502-6b8b4faac06d',
  title: 'Inside a Game Where AI Agents Never Sleep',
  description: '<p>What happens when half the players <b>never</b> log off?</p>',
  publishedAt: '2026-10-08T16:26:51.000Z',
  link: 'https://podcasters.spotify.com/pod/show/mlops/episodes/Inside-a-Game',
  audioUrl: 'https://anchor.fm/s/174cb1b8/podcast/play/127115050/file.mp3',
  durationSeconds: 3663,
  imageUrl: 'https://cdn.test/ep1.jpg',
  episodeNumber: null,
};

describe('normaliseFeedUrl', () => {
  it('treats the same feed written differently as the same feed', () => {
    // These are what a person types into two different forms months apart.
    const canonical = normaliseFeedUrl('https://anchor.fm/s/174cb1b8/podcast/rss');
    expect(normaliseFeedUrl('http://anchor.fm/s/174cb1b8/podcast/rss')).toBe(canonical);
    expect(normaliseFeedUrl('https://www.anchor.fm/s/174cb1b8/podcast/rss')).toBe(canonical);
    expect(normaliseFeedUrl('https://ANCHOR.FM/s/174cb1b8/podcast/rss')).toBe(canonical);
    expect(normaliseFeedUrl('https://anchor.fm/s/174cb1b8/podcast/rss/')).toBe(canonical);
    expect(normaliseFeedUrl('  https://anchor.fm/s/174cb1b8/podcast/rss  ')).toBe(canonical);
  });

  it('keeps the path case, because a feed id is an identifier', () => {
    expect(normaliseFeedUrl('https://host.test/s/AbCdEf/rss'))
      .not.toBe(normaliseFeedUrl('https://host.test/s/abcdef/rss'));
  });

  it('does not conflate two different feeds', () => {
    expect(normaliseFeedUrl('https://anchor.fm/s/174cb1b8/podcast/rss'))
      .not.toBe(normaliseFeedUrl('https://anchor.fm/s/999999/podcast/rss'));
  });

  it('refuses anything that is not a web URL', () => {
    expect(normaliseFeedUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseFeedUrl('file:///etc/passwd')).toBeNull();
    expect(normaliseFeedUrl('not a url')).toBeNull();
    expect(normaliseFeedUrl('')).toBeNull();
    expect(normaliseFeedUrl(null)).toBeNull();
  });
});

describe('toPlainText', () => {
  it('strips the markup every feed description carries', () => {
    expect(toPlainText('<p>What happens when half the players <b>never</b> log off?</p>'))
      .toBe('What happens when half the players never log off?');
  });

  it('keeps a sentence boundary where a block tag was', () => {
    // Without this, "one.Two" comes out as one word.
    expect(toPlainText('<p>One.</p><p>Two.</p>')).toBe('One. Two.');
    expect(toPlainText('a<br>b')).toBe('a b');
  });

  it('removes a script rather than storing it', () => {
    // podcast_episodes.description is read as text today. It would take one
    // dangerouslySetInnerHTML on a show-notes page to turn stored feed markup
    // into stored XSS, so the tags do not get stored in the first place.
    expect(toPlainText('<script>alert(document.cookie)</script>hello')).toBe('alert(document.cookie)hello');
    expect(toPlainText('<img src=x onerror=alert(1)>caption')).toBe('caption');
  });

  it('decodes entities first, so an escaped tag becomes a tag and is then removed', () => {
    // Decoding last leaves the literal text "<script>" in the column, which
    // is safe only while every reader escapes it. CodeQL flagged exactly that.
    expect(toPlainText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('alert(1)');
    expect(toPlainText('Q&amp;A')).toBe('Q&A');
    expect(toPlainText('a&nbsp;b')).toBe('a b');
    // A double-escaped entity is text, and stays text.
    expect(toPlainText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('strips to a fixed point, so one pass cannot splice a new tag', () => {
    // A single `.replace(/<[^>]*>/g, '')` can leave the halves of two
    // fragments adjacent and form a tag that was not in the input.
    //
    // What survives is inert text, not reconstructed intent: "<scr<x>ipt>"
    // leaves the characters "ipt" behind. That is the right outcome. The
    // guarantee is that no tag survives, not that a mangled input is tidied.
    expect(toPlainText('<scr<x>ipt>alert(1)')).toBe('iptalert(1)');
    expect(toPlainText('<<script>script>alert(1)<</script>/script>')).toBe('script>alert(1)/script>'.replace(/[<>]/g, ''));
  });

  it('never returns an angle bracket at all', () => {
    // The guarantee the rest of the system can rely on: whatever the feed
    // sent, no element can be rebuilt from what is stored.
    for (const input of [
      '<script>x</script>',
      '&lt;script&gt;x&lt;/script&gt;',
      '<scr<x>ipt>x',
      '<img src=x onerror=alert(1)>x',
      'a < b and c > d',
      '&lt;&lt;&gt;&gt;',
    ]) {
      const out = toPlainText(input) ?? '';
      expect(out, `input: ${input}`).not.toMatch(/[<>]/);
    }
  });

  it('returns null rather than an empty string', () => {
    expect(toPlainText('<p></p>')).toBeNull();
    expect(toPlainText('   ')).toBeNull();
    expect(toPlainText(null)).toBeNull();
    expect(toPlainText(undefined)).toBeNull();
  });
});

describe('episodeSlug', () => {
  it('makes a readable slug', () => {
    expect(episodeSlug('Inside a Game Where AI Agents Never Sleep', null))
      .toBe('inside-a-game-where-ai-agents-never-sleep');
  });

  it('prefixes the episode number when the feed gives one', () => {
    // Two episodes called "Part 1" otherwise produce the same slug.
    expect(episodeSlug('Part 1', 42)).toBe('42-part-1');
    expect(episodeSlug('Part 1', null)).toBe('part-1');
  });

  it('keeps accented words readable instead of eating them', () => {
    expect(episodeSlug('Ürün Yönetimi', null)).toBe('urun-yonetimi');
  });

  it('does not end in a dash after the length cap', () => {
    const slug = episodeSlug('x'.repeat(40) + ' ' + 'y'.repeat(40), null)!;
    expect(slug.length).toBeLessThanOrEqual(70);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns null when there is nothing to slug', () => {
    expect(episodeSlug('!!!', null)).toBeNull();
    expect(episodeSlug('', null)).toBeNull();
  });
});

describe('episodeFieldsFromFeed', () => {
  const f = episodeFieldsFromFeed(EP, PODCAST);

  it('carries the feed through', () => {
    expect(f.podcast_id).toBe(PODCAST);
    expect(f.title).toBe(EP.title);
    expect(f.publish_date).toBe(EP.publishedAt);
    expect(f.duration_seconds).toBe(3663);
    expect(f.thumbnail_url).toBe(EP.imageUrl);
  });

  it('keeps the audio URL, which is OP3\'s join key back to this episode', () => {
    expect(f.audio_url).toBe(EP.audioUrl);
  });

  it('marks it published, because it already is', () => {
    // podcast_episodes.status defaults to 'draft'. An episode that has been
    // public for two years is not a draft, and a draft would be hidden.
    expect(f.status).toBe('published');
    expect(f.publish_state).toBe('published');
  });

  it('never leaves the NOT NULL title empty', () => {
    const blank = episodeFieldsFromFeed({ ...EP, title: '   ' }, PODCAST);
    expect(blank.title).toBe('Untitled episode');
  });
});

describe('episodeRefreshFields', () => {
  it('refreshes only what the feed owns', () => {
    const patch = episodeRefreshFields(episodeFieldsFromFeed(EP, PODCAST));
    // An editor's title, description and show notes survive a re-run.
    // Reverting them every night would make their work look broken.
    expect(patch).not.toHaveProperty('title');
    expect(patch).not.toHaveProperty('description');
    expect(patch).not.toHaveProperty('slug');
    expect(patch.publish_date).toBe(EP.publishedAt);
    expect(patch.duration_seconds).toBe(3663);
  });

  it('does not overwrite a known value with a blank one', () => {
    const patch = episodeRefreshFields(
      episodeFieldsFromFeed({ ...EP, durationSeconds: null, publishedAt: null, audioUrl: null }, PODCAST),
    );
    expect(patch).toEqual({});
  });
});

// ── resolvePodcast ──────────────────────────────────────────────────────────

/** A supabase stub that answers one query against `podcasts`. */
function stub(rows: unknown[], error: { message: string } | null = null) {
  const self: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: error ? null : rows, error }).then(resolve);
      }
      return () => self;
    },
  });
  return { from: () => self };
}

const FEED = 'https://anchor.fm/s/174cb1b8/podcast/rss';

describe('resolvePodcast', () => {
  it('uses an explicit config.podcast_id', async () => {
    const r = await resolvePodcast(stub([{ id: PODCAST }]), { id: 'c1', config: { podcast_id: PODCAST } }, FEED);
    expect(r).toEqual({ podcastId: PODCAST, via: 'config' });
  });

  it('refuses a configured id that is not a podcast that exists', async () => {
    // Otherwise 555 episodes get written against a dead uuid and no page
    // ever shows them.
    const r = await resolvePodcast(stub([]), { id: 'c1', config: { podcast_id: PODCAST } }, FEED);
    expect(r.podcastId).toBeNull();
    expect(r.detail).toMatch(/not a podcast that exists/);
  });

  it('refuses a configured id that is not a uuid', async () => {
    const r = await resolvePodcast(stub([]), { id: 'c1', config: { podcast_id: 'the-show' } }, FEED);
    expect(r.podcastId).toBeNull();
    expect(r.detail).toMatch(/not a uuid/);
  });

  it('falls back to the podcast carrying the same feed', async () => {
    const r = await resolvePodcast(
      stub([{ id: PODCAST, name: 'Agentic Conversations', rss_feed_url: 'http://www.anchor.fm/s/174cb1b8/podcast/rss/' }]),
      { id: 'c1', config: {} },
      FEED,
    );
    expect(r).toEqual({ podcastId: PODCAST, via: 'feed_url' });
  });

  it('refuses to guess when two podcasts claim the same feed', async () => {
    // Picking one would attach 555 episodes to a show at random.
    const r = await resolvePodcast(
      stub([
        { id: PODCAST, name: 'Show A', rss_feed_url: FEED },
        { id: '11111111-1111-1111-1111-111111111111', name: 'Show B', rss_feed_url: FEED },
      ]),
      { id: 'c1', config: {} },
      FEED,
    );
    expect(r.podcastId).toBeNull();
    expect(r.via).toBe('ambiguous');
    expect(r.detail).toContain('Show A');
    expect(r.detail).toContain('Show B');
  });

  it('says what to do when nothing matches', async () => {
    const r = await resolvePodcast(
      stub([{ id: PODCAST, name: 'Other', rss_feed_url: 'https://elsewhere.test/rss' }]),
      { id: 'c1', config: {} },
      FEED,
    );
    expect(r.podcastId).toBeNull();
    expect(r.via).toBe('none');
    expect(r.detail).toMatch(/RSS feed field|config.podcast_id/);
  });

  it('reports an unreadable podcasts table as unavailable, not as "no match"', async () => {
    // The podcasts module may not be installed. That is not the same as the
    // operator having forgotten to set something, and the message differs.
    const r = await resolvePodcast(stub([], { message: 'relation does not exist' }), { id: 'c1', config: {} }, FEED);
    expect(r.via).toBe('unavailable');
  });
});
