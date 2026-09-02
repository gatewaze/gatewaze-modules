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

describe('richer detail extracted for the results view', () => {
  const full = {
    testId: 't1',
    finished: true,
    stats: { inbox: 2, spam: 1, other: 1, notDelivered: 0 },
    inboxes: [
      { email: 'a@gmail.com', iType: 'Inbox', spf: 'pass', dkim: 'pass', dmarc: 'pass', ip: '1.2.3.4', deliveredIn: 12, seedName: 'Gmail US', finished: true },
      { email: 'b@outlook.com', iType: 'Spam', spf: 'pass', dkim: 'fail', dmarc: 'fail', deliveredIn: 40, finished: true },
    ],
    authenticationResult: {
      senderDomain: 'aaif.live', senderIp: '5.6.7.8', senderScore: 98,
      rdns: 'o1.sendgrid.net', rDNSStatus: 'valid', helo: 'sendgrid.net',
      returnPath: 'bounces@aaif.live', spfAuth: 'pass', dkimAuth: 'pass',
      dmarcAuth: 'pass', dmarcRecord: { record: 'v=DMARC1; p=none' }, bimi: '', isp: 'SendGrid',
    },
    spamAssassin: { active: true, score: 1.2 },
    microsoftEOP: { active: true, scl: 1, bcl: 0, cat: 'NONE' },
    googleApps: { active: true, spam: false, phishy: false },
    proofPoint: { active: true, spam: true },
    dnsbl: { finished: true, results: [{ name: 'zen.spamhaus.org', listed: false }, { name: 'bl.example', listed: true }] },
    uribl: { finished: true, results: [] },
  };

  it('flattens seed rows for the filterable table', () => {
    const r = normalisePlacement(full);
    expect(r.seeds).toHaveLength(2);
    expect(r.seeds[0]).toMatchObject({
      email: 'a@gmail.com', provider: 'gmail', placement: 'inbox',
      spf: 'pass', ip: '1.2.3.4', deliveredIn: 12, seedName: 'Gmail US',
    });
    expect(r.seeds[1]).toMatchObject({ provider: 'outlook', placement: 'spam', dkim: 'fail' });
  });

  it('keeps the raw placement label so an unknown value is still shown', () => {
    const r = normalisePlacement({ inboxes: [{ email: 'a@gmail.com', iType: 'SomethingNew' }] });
    expect(r.seeds[0].placement).toBeNull();
    expect(r.seeds[0].placementLabel).toBe('SomethingNew');
  });

  it('reads sender-level authentication including the DMARC record', () => {
    const r = normalisePlacement(full);
    expect(r.senderAuth).toMatchObject({
      senderDomain: 'aaif.live', senderIp: '5.6.7.8', senderScore: 98,
      dmarcAuth: 'pass', dmarcRecord: 'v=DMARC1; p=none', rdnsStatus: 'valid',
    });
    // Empty strings become null rather than rendering as blanks.
    expect(r.senderAuth?.bimi).toBeNull();
  });

  it('accepts a bare-string dmarcRecord as well as the object form', () => {
    const r = normalisePlacement({ authenticationResult: { dmarcRecord: 'v=DMARC1; p=reject' } });
    expect(r.senderAuth?.dmarcRecord).toBe('v=DMARC1; p=reject');
  });

  it('normalises each filter to one vocabulary', () => {
    const r = normalisePlacement(full);
    const byName = Object.fromEntries(r.filters.map((f) => [f.name, f]));
    expect(byName['SpamAssassin']).toMatchObject({ verdict: 'pass', score: 1.2 });
    expect(byName['Microsoft EOP']).toMatchObject({ verdict: 'pass', detail: 'SCL 1 · BCL 0 · cat NONE' });
    expect(byName['Google']).toMatchObject({ verdict: 'pass' });
    expect(byName['ProofPoint']).toMatchObject({ verdict: 'spam' });
  });

  it('treats a high SpamAssassin score as spam', () => {
    const r = normalisePlacement({ spamAssassin: { active: true, score: 7.5 } });
    expect(r.filters[0]).toMatchObject({ name: 'SpamAssassin', verdict: 'spam', score: 7.5 });
  });

  it('skips filters that are not active', () => {
    const r = normalisePlacement({ spamAssassin: { active: false, score: 9 } });
    expect(r.filters).toEqual([]);
  });

  it('lists only blocklists that actually list us', () => {
    const r = normalisePlacement(full);
    expect(r.blocklists).toEqual(['bl.example']);
  });

  it('returns empty detail rather than throwing on an unfamiliar payload', () => {
    const r = normalisePlacement({ inboxes: [], authenticationResult: 'nonsense', dnsbl: 'nope' });
    expect(r.seeds).toEqual([]);
    expect(r.senderAuth).toBeNull();
    expect(r.filters).toEqual([]);
    expect(r.blocklists).toEqual([]);
  });
});
