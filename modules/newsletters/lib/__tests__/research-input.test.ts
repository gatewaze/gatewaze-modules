import { describe, expect, it } from 'vitest';
import { dateLabel, entryBlurb, oneSentence, queryDiscoveryPosts } from '../research-input.js';
import type { ResearchWindow } from '../research-window.js';

describe('oneSentence', () => {
  it('takes the first sentence when it is long enough', () => {
    expect(oneSentence('This is the first sentence of the excerpt, long enough. And a second one.')).toBe('This is the first sentence of the excerpt, long enough.');
  });

  it('keeps going past a short first sentence', () => {
    expect(oneSentence('Short. Then the rest of it.')).toBe('Short. Then the rest of it.');
  });

  it('strips tags and entities and cuts long text on a word with an ellipsis', () => {
    const long = `<p>${'word '.repeat(60)}</p>`;
    const out = oneSentence(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(151);
    expect(out).not.toMatch(/</);
    expect(oneSentence('Tom &amp; Jerry&nbsp;went to the shops and bought a great many things.')).toBe('Tom & Jerry went to the shops and bought a great many things.');
  });

  it('drops the boilerplate lead-ins', () => {
    expect(oneSentence('Overview The project shipped a new scheduler for the cluster this week.')).toBe('The project shipped a new scheduler for the cluster this week.');
  });

  it('empty in, empty out', () => {
    expect(oneSentence('')).toBe('');
    expect(oneSentence('<br>')).toBe('');
  });
});

describe('entryBlurb', () => {
  it('suppresses release-note titles unless told not to', () => {
    const excerpt = 'The release brings faster startup and a smaller memory footprint for everyone.';
    expect(entryBlurb('Project v1.2.0 released', excerpt)).toBe('');
    expect(entryBlurb('Project v1.2.0 released', excerpt, false)).toBe(excerpt);
  });

  it('drops a blurb that only repeats the title', () => {
    expect(entryBlurb('Scaling agents in production', 'Scaling agents in production. Read more.')).toBe('');
  });

  it('drops feed junk', () => {
    expect(entryBlurb('A post', 'The post A post appeared first on Some Blog and that is all it says.')).toBe('');
  });

  it('keeps a real blurb', () => {
    expect(entryBlurb('Why we rewrote the router', 'We rewrote the router to cut tail latency by half across all regions.')).toBe('We rewrote the router to cut tail latency by half across all regions.');
  });
});

describe('dateLabel', () => {
  it('formats in UTC as "Mon D"', () => {
    expect(dateLabel('2026-09-17T23:30:00Z')).toBe('Sep 17');
    expect(dateLabel('2026-01-01T00:00:00Z')).toBe('Jan 1');
  });

  it('empty for null or garbage', () => {
    expect(dateLabel(null)).toBe('');
    expect(dateLabel('not a date')).toBe('');
  });
});

/** A chainable stand-in for the supabase query builder that records each call. */
function recordingClient(rows: unknown[] = []) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'in', 'lte', 'gte', 'or', 'order', 'limit']) {
    builder[m] = (...args: unknown[]) => { calls.push([m, args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
  const sb = { from: (t: string) => { calls.push(['from', [t]]); return builder; } };
  return { sb: sb as never, calls };
}

const win: ResearchWindow = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', excludeKeys: [], anchor: 'default' } as ResearchWindow;

describe('queryDiscoveryPosts date bounds', () => {
  it('require_date (default): both bounds on published_at, no OR', async () => {
    const { sb, calls } = recordingClient();
    await queryDiscoveryPosts(sb, { kind: 'discovery_posts' }, win);
    expect(calls).toContainEqual(['gte', ['published_at', win.from]]);
    expect(calls).toContainEqual(['lte', ['published_at', win.to]]);
    expect(calls.find(([m]) => m === 'or')).toBeUndefined();
  });

  it('require_date false: the bounds and IS NULL sit in one OR, so undated posts survive', async () => {
    const { sb, calls } = recordingClient([
      { id: '1', title: 'Undated post', excerpt: '', canonical_url: 'https://a.example/p', canonical_url_norm: 'a.example/p', published_at: null, discovery_sources: { foundation: 'F', project: 'P', status: 'active' } },
    ]);
    const res = await queryDiscoveryPosts(sb, { kind: 'discovery_posts', require_date: false }, win);
    expect(calls).toContainEqual(['or', [`and(published_at.gte.${win.from},published_at.lte.${win.to}),published_at.is.null`]]);
    // A top-level lte would AND away every NULL row before the OR could keep it.
    expect(calls.find(([m, a]) => m === 'lte' && a[0] === 'published_at')).toBeUndefined();
    expect(res.items.map((i) => i.key)).toEqual(['a.example/p']);
  });
});
