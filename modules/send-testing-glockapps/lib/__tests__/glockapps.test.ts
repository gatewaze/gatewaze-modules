import { describe, it, expect } from 'vitest';
import { classifyPlacement, normalisePlacement, providerFromEmail } from '../placement-parse';

/** Shaped like glockapps_apiTestItem from the Spamtest v2 spec. */
function testItem(overrides: Record<string, unknown> = {}) {
  return {
    testId: 'abc123',
    finished: true,
    stats: { inbox: 12, spam: 3, other: 4, notDelivered: 1 },
    inboxes: [
      { email: 'seed1@gmail.com', iType: 'Inbox', spf: 'pass', dkim: 'pass', dmarc: 'pass', finished: true },
      { email: 'seed2@gmail.com', iType: 'Promotions', spf: 'pass', dkim: 'pass', dmarc: 'pass', finished: true },
      { email: 'seed3@outlook.com', iType: 'Spam', spf: 'pass', dkim: 'fail', dmarc: 'fail', finished: true },
      { email: 'seed4@yahoo.co.uk', iType: 'Inbox', spf: 'pass', dkim: 'pass', dmarc: 'pass', finished: true },
    ],
    ...overrides,
  };
}

describe('providerFromEmail', () => {
  it('reads the brand label out of the domain', () => {
    expect(providerFromEmail('a@gmail.com')).toBe('gmail');
    expect(providerFromEmail('a@outlook.com')).toBe('outlook');
    expect(providerFromEmail('a@mail.yahoo.co.uk')).toBe('yahoo');
    expect(providerFromEmail('a@corp.example.org')).toBe('example');
  });

  it('degrades to "other" rather than throwing', () => {
    for (const v of ['', 'not-an-email', null, undefined, 42]) {
      expect(providerFromEmail(v)).toBe('other');
    }
  });
});

describe('classifyPlacement', () => {
  it('matches the placements GlockApps actually returns', () => {
    expect(classifyPlacement('Inbox')).toBe('inbox');
    expect(classifyPlacement('Primary')).toBe('inbox');
    expect(classifyPlacement('Spam')).toBe('spam');
    expect(classifyPlacement('Junk')).toBe('spam');
    expect(classifyPlacement('Promotions')).toBe('tabs');
    expect(classifyPlacement('Categories')).toBe('tabs');
  });

  it('returns null for anything unrecognised rather than guessing a bucket', () => {
    // iType is an untyped string in the spec, so an unknown value must not be
    // silently counted as inbox.
    expect(classifyPlacement('somethingNew')).toBeNull();
    expect(classifyPlacement('')).toBeNull();
    expect(classifyPlacement(undefined)).toBeNull();
  });
});

describe('normalisePlacement', () => {
  it('takes the overall row from stats, not from summing seeds', () => {
    // stats is GlockApps' own total and includes seeds still in flight.
    const r = normalisePlacement(testItem());
    const overall = r.providers.find((p) => p.provider === 'overall');
    expect(overall).toEqual({ provider: 'overall', inbox: 12, tabs: 4, spam: 3, missing: 1 });
  });

  it('groups seed rows by provider', () => {
    const r = normalisePlacement(testItem());
    const byName = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
    expect(byName.gmail).toMatchObject({ inbox: 1, tabs: 1, spam: 0 });
    expect(byName.outlook).toMatchObject({ spam: 1, inbox: 0 });
    expect(byName.yahoo).toMatchObject({ inbox: 1 });
  });

  it('reports per-seed authentication verdicts', () => {
    // This is the module's only source of SPF/DKIM/DMARC — Inbound Parse adds
    // no Authentication-Results header to the synthetic arrivals.
    const r = normalisePlacement(testItem());
    expect(r.auth).toEqual({ spf_pass: 4, dkim_pass: 3, dmarc_pass: 3, evaluated: 4 });
  });

  it('is null-auth when the test carries no verdicts', () => {
    const r = normalisePlacement(
      testItem({ inboxes: [{ email: 'a@gmail.com', iType: 'Inbox', finished: true }] }),
    );
    expect(r.auth).toBeNull();
  });

  it('tracks completion from the test row', () => {
    expect(normalisePlacement(testItem({ finished: false })).complete).toBe(false);
    expect(normalisePlacement(testItem({ finished: true })).complete).toBe(true);
  });

  it('counts an unfinished seed as missing', () => {
    const r = normalisePlacement(
      testItem({ stats: null, inboxes: [{ email: 'a@gmail.com', iType: '', finished: false }] }),
    );
    expect(r.providers.find((p) => p.provider === 'gmail')).toMatchObject({ missing: 1 });
  });

  it('skips seeds flagged not visible', () => {
    const r = normalisePlacement(
      testItem({
        stats: null,
        inboxes: [
          { email: 'a@gmail.com', iType: 'Inbox', finished: true },
          { email: 'b@gmail.com', iType: 'Inbox', finished: true, visible: false },
        ],
      }),
    );
    expect(r.providers.find((p) => p.provider === 'gmail')).toMatchObject({ inbox: 1 });
  });

  it('survives empty or unrecognised payloads without throwing', () => {
    for (const payload of [{}, null, { inboxes: 'nonsense' }, { stats: null }]) {
      const r = normalisePlacement(payload);
      expect(r.providers).toEqual([]);
      expect(r.complete).toBe(false);
      expect(r.auth).toBeNull();
    }
  });

  it('coerces junk counts in stats to zero rather than NaN', () => {
    const r = normalisePlacement(
      testItem({ stats: { inbox: 'x', spam: -4, other: null, notDelivered: 2.7 }, inboxes: [] }),
    );
    expect(r.providers[0]).toEqual({ provider: 'overall', inbox: 0, tabs: 0, spam: 0, missing: 2 });
  });
});
