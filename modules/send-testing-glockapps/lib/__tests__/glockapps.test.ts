import { describe, it, expect } from 'vitest';
import { normalisePlacement } from '../placement-parse';

describe('normalisePlacement', () => {
  it('reads the common providers array shape', () => {
    const result = normalisePlacement({
      status: 'complete',
      providers: [
        { provider: 'Gmail', inbox: 10, tabs: 2, spam: 1, missing: 0 },
        { provider: 'Outlook', inbox: 8, tabs: 0, spam: 4, missing: 1 },
      ],
    });
    expect(result.complete).toBe(true);
    // Providers are lowercased so 'Gmail' and 'gmail' cannot become two rows.
    expect(result.providers.map((p) => p.provider)).toEqual(['overall', 'gmail', 'outlook']);
  });

  it('adds a rolled-up overall row so the panel can lead with one number', () => {
    const result = normalisePlacement({
      providers: [
        { provider: 'gmail', inbox: 10, tabs: 2, spam: 1, missing: 0 },
        { provider: 'yahoo', inbox: 5, tabs: 1, spam: 2, missing: 3 },
      ],
    });
    const overall = result.providers.find((p) => p.provider === 'overall');
    expect(overall).toEqual({ provider: 'overall', inbox: 15, tabs: 3, spam: 3, missing: 3 });
  });

  it('accepts the alternative key names the API uses across report styles', () => {
    const result = normalisePlacement({
      results: [
        { isp: 'yahoo', inbox_count: 4, promotions: 3, spam_count: 2, not_received: 1 },
      ],
    });
    const yahoo = result.providers.find((p) => p.provider === 'yahoo');
    expect(yahoo).toEqual({ provider: 'yahoo', inbox: 4, tabs: 3, spam: 2, missing: 1 });
  });

  it('treats a still-running test as incomplete', () => {
    const result = normalisePlacement({
      status: 'running',
      providers: [{ provider: 'gmail', inbox: 1, tabs: 0, spam: 0, missing: 9 }],
    });
    expect(result.complete).toBe(false);
  });

  it('survives an empty or unrecognised payload without throwing', () => {
    // The panel must degrade to "no results yet", never crash the run page.
    for (const payload of [{}, null, { providers: 'nonsense' }, { data: [] }]) {
      const result = normalisePlacement(payload);
      expect(result.providers).toEqual([]);
      expect(result.complete).toBe(false);
    }
  });

  it('coerces junk counts to zero rather than NaN', () => {
    const result = normalisePlacement({
      providers: [{ provider: 'gmail', inbox: 'x', tabs: -4, spam: null, missing: 2.7 }],
    });
    const gmail = result.providers.find((p) => p.provider === 'gmail');
    expect(gmail).toEqual({ provider: 'gmail', inbox: 0, tabs: 0, spam: 0, missing: 2 });
  });

  it('skips rows with no identifiable provider', () => {
    const result = normalisePlacement({
      providers: [{ inbox: 5 }, { provider: 'gmail', inbox: 1 }],
    });
    expect(result.providers.map((p) => p.provider)).toEqual(['overall', 'gmail']);
  });
});
