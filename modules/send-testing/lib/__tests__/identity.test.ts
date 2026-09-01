import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEZONE_DISTRIBUTION,
  buildTestPeople,
  buildTestPerson,
  isInspectable,
  parseSequence,
  pickTimezone,
  sequenceToEmail,
  sequenceToLocalPart,
} from '../identity';

describe('sequenceToLocalPart', () => {
  it('zero-pads so lexicographic order matches numeric order', () => {
    // Shrink-to-count deletes highest-sequence-first with an ORDER BY email
    // DESC, which is only correct while padding holds.
    const sorted = [1, 2, 10, 99, 100, 1000]
      .map(sequenceToLocalPart)
      .sort();
    expect(sorted).toEqual([
      'st-000001', 'st-000002', 'st-000010',
      'st-000099', 'st-000100', 'st-001000',
    ]);
  });

  it('rejects non-positive and non-integer sequences', () => {
    expect(() => sequenceToLocalPart(0)).toThrow();
    expect(() => sequenceToLocalPart(-1)).toThrow();
    expect(() => sequenceToLocalPart(1.5)).toThrow();
  });
});

describe('sequenceToEmail / parseSequence', () => {
  it('round-trips', () => {
    const email = sequenceToEmail(4242, 'sendtest.example.org');
    expect(email).toBe('st-004242@sendtest.example.org');
    expect(parseSequence(email)).toBe(4242);
  });

  it('lowercases the domain so inserts match the DB guard', () => {
    expect(sequenceToEmail(1, 'SendTest.Example.ORG'))
      .toBe('st-000001@sendtest.example.org');
  });

  it('returns null for addresses outside the scheme', () => {
    expect(parseSequence('someone@example.com')).toBeNull();
    expect(parseSequence('st-abc@sendtest.example.org')).toBeNull();
  });

  it('handles sequences beyond six digits', () => {
    const email = sequenceToEmail(1234567, 'sendtest.example.org');
    expect(parseSequence(email)).toBe(1234567);
  });
});

describe('pickTimezone', () => {
  it('is deterministic for a given sequence', () => {
    for (const seq of [1, 17, 5000, 24999]) {
      expect(pickTimezone(seq)).toBe(pickTimezone(seq));
    }
  });

  it('only ever returns zones from the distribution', () => {
    const allowed = new Set(Object.keys(DEFAULT_TIMEZONE_DISTRIBUTION));
    for (let seq = 1; seq <= 2000; seq++) {
      expect(allowed.has(pickTimezone(seq))).toBe(true);
    }
  });

  it('approximates the configured weights over a large population', () => {
    const counts: Record<string, number> = {};
    const n = 20000;
    for (let seq = 1; seq <= n; seq++) {
      const zone = pickTimezone(seq);
      counts[zone] = (counts[zone] ?? 0) + 1;
    }
    // A wrong distribution is not a crash, it is a silently unrealistic
    // delivery-wave chart, so assert the shape rather than trusting it.
    for (const [zone, weight] of Object.entries(DEFAULT_TIMEZONE_DISTRIBUTION)) {
      const share = ((counts[zone] ?? 0) / n) * 100;
      expect(Math.abs(share - weight)).toBeLessThan(2);
    }
  });

  it('does not walk the zones in sequence order', () => {
    // `seq % total` would make consecutive people march through the zones,
    // turning the delivery waves into an artefact of ordering.
    const first = Array.from({ length: 8 }, (_, i) => pickTimezone(i + 1));
    expect(new Set(first).size).toBeGreaterThan(1);
    const cyclic = Object.keys(DEFAULT_TIMEZONE_DISTRIBUTION).slice(0, 8);
    expect(first).not.toEqual(cyclic);
  });

  it('honours a custom distribution and falls back to UTC when empty', () => {
    const only = { 'Europe/London': 1 };
    expect(pickTimezone(99, only)).toBe('Europe/London');
    expect(pickTimezone(99, {})).toBe('UTC');
    expect(pickTimezone(99, { 'Asia/Tokyo': 0 })).toBe('UTC');
  });
});

describe('buildTestPerson', () => {
  it('is stable across re-provisioning', () => {
    const a = buildTestPerson(1234, 'sendtest.example.org');
    const b = buildTestPerson(1234, 'sendtest.example.org');
    expect(a).toEqual(b);
  });

  it('carries the markers the platform relies on', () => {
    const person = buildTestPerson(7, 'sendtest.example.org');
    // is_test is what the People admin filters on; the sequence is what the
    // inbox view and shrink-to-count use.
    expect(person.attributes.is_test).toBe(true);
    expect(person.attributes.send_testing_sequence).toBe(7);
    expect(person.attributes.first_name).toBeTruthy();
    expect(person.attributes.last_name).toBeTruthy();
    expect(person.attributes.timezone).toBeTruthy();
  });

  it('produces varied names rather than a short repeating cycle', () => {
    const names = new Set(
      buildTestPeople(1, 200, 'sendtest.example.org')
        .map((p) => `${p.attributes.first_name} ${p.attributes.last_name}`),
    );
    expect(names.size).toBeGreaterThan(100);
  });
});

describe('buildTestPeople', () => {
  it('covers the inclusive range with unique addresses', () => {
    const rows = buildTestPeople(1, 1000, 'sendtest.example.org');
    expect(rows).toHaveLength(1000);
    expect(new Set(rows.map((r) => r.email)).size).toBe(1000);
    expect(rows[0].email).toBe('st-000001@sendtest.example.org');
    expect(rows[999].email).toBe('st-001000@sendtest.example.org');
  });
});

describe('isInspectable', () => {
  it('marks only the leading sample', () => {
    expect(isInspectable(1, 20)).toBe(true);
    expect(isInspectable(20, 20)).toBe(true);
    expect(isInspectable(21, 20)).toBe(false);
    expect(isInspectable(0, 20)).toBe(false);
  });
});
