/**
 * GET /test-env/env-events query parsing + summary aggregation
 * (lib/env-events-query.ts). This is the trust boundary for the log explorer:
 * every value here ends up in a PostgREST filter, and two of them (the env
 * `.or()` leg and the keyset cursor) end up inside a filter EXPRESSION, where a
 * stray comma or paren would change what the query means. The tests below pin
 * both the happy path and the refusals.
 */
import { describe, it, expect } from 'vitest';
import {
  parseEventQuery, sanitizeSearch, normalizeInstant, summarizeEvents,
  ENV_LABEL_SHAPE, ISO_INSTANT_RE, DEFAULT_LIMIT, MAX_LIMIT, MAX_SEARCH,
} from '../env-events-query.js';

const ok = (raw: Record<string, unknown>) => {
  const r = parseEventQuery(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.query;
};
const bad = (raw: Record<string, unknown>) => {
  const r = parseEventQuery(raw);
  expect(r.ok, `expected a refusal for ${JSON.stringify(raw)}`).toBe(false);
  return r.ok ? '' : r.message;
};

describe('defaults', () => {
  it('an empty query is an unfiltered newest-first page', () => {
    expect(ok({})).toEqual({
      envs: [], includeUnattributed: false, envFilterPresent: false, kinds: [],
      since: null, until: null, search: null,
      limit: DEFAULT_LIMIT, beforeTs: null, beforeId: null, summary: false, buckets: 48,
    });
  });
});

describe('env filter', () => {
  it('accepts a multi-select of grammar-shaped labels, de-duplicated', () => {
    const q = ok({ env: 'lfx--newsletter-80,lfx--api-12,lfx--newsletter-80' });
    expect(q.envs).toEqual(['lfx--newsletter-80', 'lfx--api-12']);
    expect(q.includeUnattributed).toBe(false);
    expect(q.envFilterPresent).toBe(true);
  });
  it('"none" selects the unattributed (shared-Authelia) events', () => {
    expect(ok({ env: 'none' })).toMatchObject({ envs: [], includeUnattributed: true, envFilterPresent: true });
    expect(ok({ env: 'lfx--a1,none' })).toMatchObject({ envs: ['lfx--a1'], includeUnattributed: true });
  });
  it('refuses anything that could break out of an .in.() list', () => {
    // Each of these would change the meaning of `env_label.in.(…)` inside .or().
    for (const env of [
      'lfx--a),env_label.is.null,x.in.(y',
      'lfx--a,,lfx--b'.replace(',,', ',("'),   // quote + paren
      'lfx--a b',
      'LFX--A',
      'lfx--a.b',
      'notlfx--a',
      '*',
      'lfx--' + 'a'.repeat(80),
    ]) expect(bad({ env }), env).toMatch(/environment label|env filter/i);
  });
  it('caps the number of selected envs', () => {
    const many = Array.from({ length: 26 }, (_, i) => `lfx--e${i}`).join(',');
    expect(bad({ env: many })).toBe('Bad env filter');
  });
  it('every accepted label matches the shape the ingester stores', () => {
    for (const l of ok({ env: 'lfx--newsletter-80,lfx--api-12' }).envs) expect(l).toMatch(ENV_LABEL_SHAPE);
  });
});

describe('kind filter', () => {
  it('accepts a shaped set', () => {
    expect(ok({ kind: 'visit,service_error,login_failure' }).kinds)
      .toEqual(['visit', 'service_error', 'login_failure']);
  });
  it('refuses an unshaped kind rather than silently dropping it', () => {
    for (const kind of ['visit,DROP', 'visit,a-b', 'visit,(x)', '1visit', 'visit,x'.replace('x', 'y'.repeat(40))]) {
      expect(bad({ kind }), kind).toBe('Bad kind filter');
    }
  });
});

describe('time range', () => {
  it('re-serialises the caller value to our own strict ISO instant', () => {
    const q = ok({ since: '2026-08-23T10:00:00Z', until: '2026-08-23T11:30:00+01:00' });
    expect(q.since).toBe('2026-08-23T10:00:00.000Z');
    expect(q.until).toBe('2026-08-23T10:30:00.000Z');
    expect(q.since).toMatch(ISO_INSTANT_RE);
    expect(q.until).toMatch(ISO_INSTANT_RE);
  });
  it('refuses an unparseable bound and an inverted window', () => {
    expect(bad({ since: 'yesterday' })).toBe('Bad since');
    expect(bad({ until: "2026-01-01') or true--" })).toBe('Bad until');
    expect(bad({ since: '2026-08-23T11:00:00Z', until: '2026-08-23T10:00:00Z' })).toBe('since is after until');
  });
  it('normalizeInstant never returns a caller-shaped string', () => {
    expect(normalizeInstant('2026-08-23T10:00:00Z')).toBe('2026-08-23T10:00:00.000Z');
    expect(normalizeInstant('nope')).toBeNull();
    expect(normalizeInstant(undefined)).toBeNull();
  });
});

describe('limit + buckets', () => {
  it('accepts the documented band', () => {
    expect(ok({ limit: '1' }).limit).toBe(1);
    expect(ok({ limit: String(MAX_LIMIT) }).limit).toBe(MAX_LIMIT);
    expect(ok({ buckets: '60' }).buckets).toBe(60);
  });
  it('refuses out-of-band or non-integer values instead of clamping', () => {
    for (const limit of ['0', '201', '5.5', 'all', '-1', '1e3']) expect(bad({ limit }), limit).toBe('Bad limit');
    for (const buckets of ['1', '241', 'x']) expect(bad({ buckets }), buckets).toBe('Bad buckets');
  });
});

describe('keyset cursor', () => {
  it('accepts a matched pair and re-serialises both halves', () => {
    const q = ok({ before_ts: '2026-08-23T10:00:00Z', before_id: '4211' });
    expect(q.beforeTs).toBe('2026-08-23T10:00:00.000Z');
    expect(q.beforeId).toBe(4211);
  });
  it('refuses a half cursor or a non-numeric id (both would land in an .or() expression)', () => {
    expect(bad({ before_ts: '2026-08-23T10:00:00Z' })).toBe('Bad cursor');
    expect(bad({ before_id: '5' })).toBe('Bad cursor');
    expect(bad({ before_ts: '2026-08-23T10:00:00Z', before_id: '1,ts.gt.2000-01-01' })).toBe('Bad cursor');
    expect(bad({ before_ts: '2026-08-23T10:00:00Z', before_id: '0' })).toBe('Bad cursor');
    expect(bad({ before_ts: 'x', before_id: '5' })).toBe('Bad cursor');
  });
});

describe('sanitizeSearch', () => {
  it('keeps the characters this data is actually made of', () => {
    expect(sanitizeSearch('lfx--api-12 newsletter/send @host:4201 #3')).toBe('lfx--api-12 newsletter/send @host:4201 #3');
    expect(sanitizeSearch('service_error')).toBe('service_error');
  });
  it('strips every LIKE / PostgREST metacharacter', () => {
    expect(sanitizeSearch('%boom%')).toBe('boom');
    expect(sanitizeSearch('a*b')).toBe('a b');
    expect(sanitizeSearch("x,or(ts.gt.2000-01-01)")).toBe('x or ts gt 2000-01-01');
    expect(sanitizeSearch('back\\slash')).toBe('back slash');
    expect(sanitizeSearch('"quoted\'')).toBe('quoted');
    for (const s of ['%', '*', '\\', ',', '(', ')', '"', "'", '`', '.']) {
      expect(sanitizeSearch(`a${s}b`), s).not.toContain(s);
    }
  });
  it('drops control characters and collapses whitespace', () => {
    expect(sanitizeSearch('a\u0000b\n  c')).toBe('a b c');
  });
  it('caps the length and normalises empty to null', () => {
    expect(sanitizeSearch('x'.repeat(500))!.length).toBe(MAX_SEARCH);
    expect(sanitizeSearch('   ')).toBeNull();
    expect(sanitizeSearch('%%%')).toBeNull();
    expect(sanitizeSearch(undefined)).toBeNull();
  });
});

describe('summarizeEvents', () => {
  const W = { from: '2026-08-23T10:00:00.000Z', to: '2026-08-23T11:00:00.000Z' };
  const ev = (ts: string, kind: string, env: string | null = 'lfx--a1') => ({ ts, kind, env_label: env });

  it('counts per env and in total, with logins split out', () => {
    const s = summarizeEvents([
      ev('2026-08-23T10:05:00Z', 'visit'),
      ev('2026-08-23T10:06:00Z', 'visit'),
      ev('2026-08-23T10:07:00Z', 'service_error'),
      ev('2026-08-23T10:08:00Z', 'ready'),
      ev('2026-08-23T10:09:00Z', 'login_success', null),
      ev('2026-08-23T10:10:00Z', 'login_failure', null),
    ], W);
    expect(s.total).toBe(6);
    expect(s.totals).toMatchObject({ visits: 2, errors: 2, lifecycle: 1, logins: 2, login_failures: 1, total: 6 });
    const a1 = s.per_env.find((r) => r.env === 'lfx--a1')!;
    expect(a1).toMatchObject({ visits: 2, errors: 1, lifecycle: 1, total: 4 });
    const shared = s.per_env.find((r) => r.env === null)!;
    expect(shared).toMatchObject({ logins: 2, login_failures: 1, errors: 1, total: 2 });
  });

  it('sorts the per-env rows so the erroring env is first', () => {
    const s = summarizeEvents([
      ev('2026-08-23T10:05:00Z', 'visit', 'lfx--quiet'),
      ev('2026-08-23T10:05:00Z', 'visit', 'lfx--quiet'),
      ev('2026-08-23T10:05:00Z', 'visit', 'lfx--quiet'),
      ev('2026-08-23T10:06:00Z', 'fail', 'lfx--broken'),
    ], W);
    expect(s.per_env.map((r) => r.env)).toEqual(['lfx--broken', 'lfx--quiet']);
  });

  it('buckets both sparklines across the window', () => {
    const s = summarizeEvents([
      ev('2026-08-23T10:00:30Z', 'visit'),
      ev('2026-08-23T10:59:30Z', 'service_error'),
    ], { ...W, buckets: 4 });
    expect(s.sparkline).toEqual([1, 0, 0, 1]);
    expect(s.error_sparkline).toEqual([0, 0, 0, 1]);
  });

  it('clamps a row outside the window into the edge bucket rather than losing it', () => {
    const s = summarizeEvents([
      ev('2026-08-23T09:00:00Z', 'service_error'),
      ev('2026-08-23T12:00:00Z', 'service_error'),
    ], { ...W, buckets: 4 });
    expect(s.error_sparkline).toEqual([1, 0, 0, 1]);
    expect(s.totals.errors).toBe(2);
  });

  it('reports the scan cap so the UI can say "counts capped"', () => {
    expect(summarizeEvents([], { ...W, truncated: true }).truncated).toBe(true);
    expect(summarizeEvents([], W)).toMatchObject({ total: 0, truncated: false, per_env: [] });
  });

  it('counts an unknown future kind as lifecycle, not as an error', () => {
    const s = summarizeEvents([ev('2026-08-23T10:30:00Z', 'some_future_kind')], W);
    expect(s.totals).toMatchObject({ lifecycle: 1, errors: 0, total: 1 });
  });
});
