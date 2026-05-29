import { describe, it, expect } from 'vitest';
import { contentHash } from '../lib/wiki/hash.js';
import { fuseRRF, DEFAULT_RRF_K } from '../lib/wiki/rrf.js';

describe('contentHash', () => {
  it('is deterministic and sensitive to title and body', () => {
    const a = contentHash('Title', 'Body');
    expect(a).toBe(contentHash('Title', 'Body'));
    expect(a).not.toBe(contentHash('Title', 'Body2'));
    expect(a).not.toBe(contentHash('Title2', 'Body'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('does not collide title/body boundary', () => {
    // 'a' + '\n' + 'b'  vs  'a\nb' + '' would collide without a separator
    expect(contentHash('a', 'b')).not.toBe(contentHash('a\nb', ''));
  });
});

describe('fuseRRF', () => {
  const kw = [
    { use_case: 'cfp', slug: 'a' },
    { use_case: 'cfp', slug: 'b' },
    { use_case: 'cfp', slug: 'c' },
  ];
  const sem = [
    { use_case: 'cfp', slug: 'b' },
    { use_case: 'cfp', slug: 'd' },
  ];

  it('ranks a doc appearing high in both lists first', () => {
    const fused = fuseRRF([kw, sem]);
    expect(fused[0]!.item.slug).toBe('b'); // rank2 keyword + rank1 semantic
    // b's score = 1/(60+2) + 1/(60+1) > a's 1/(60+1)
    const b = fused.find((f) => f.item.slug === 'b')!;
    const a = fused.find((f) => f.item.slug === 'a')!;
    expect(b.score).toBeGreaterThan(a.score);
    expect(fused.map((f) => f.item.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('separates identities by kind (page vs raw)', () => {
    const fused = fuseRRF([[{ use_case: 'cfp', slug: 'x', kind: 'page' }], [{ use_case: 'cfp', slug: 'x', kind: 'raw' }]]);
    expect(fused).toHaveLength(2);
  });

  it('applies per-list weights (down-weighting raw)', () => {
    const pages = [{ use_case: 'cfp', slug: 'p', kind: 'page' }];
    const raw = [{ use_case: 'cfp', slug: 'r', kind: 'raw' }];
    const fused = fuseRRF([pages, raw], { weights: [1, 0.3] });
    const p = fused.find((f) => f.item.slug === 'p')!;
    const r = fused.find((f) => f.item.slug === 'r')!;
    expect(p.score).toBeGreaterThan(r.score);
    expect(p.score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1));
    expect(r.score).toBeCloseTo(0.3 / (DEFAULT_RRF_K + 1));
  });
});
