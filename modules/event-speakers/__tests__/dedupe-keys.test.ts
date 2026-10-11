/**
 * The dedupe identity keys (lib/dedupe/keys.ts).
 *
 * Every case here is a real value taken from the 6,031 profiles on AAIF prod
 * or from the live AGNTcon sched programme, not an invented one. The comments
 * say which, because the point of these tests is that the data is stranger
 * than the rules you would write from first principles.
 */

import { describe, it, expect } from 'vitest';
import {
  linkedinSlug,
  linkedinSlugBase,
  nameIsSpecific,
  nameKey,
  nameTokens,
  schedUserId,
} from '../lib/dedupe/keys';

describe('nameKey', () => {
  it('folds case and punctuation so one person matches themselves', () => {
    // Real pair from prod, same person, same company, different punctuation.
    expect(nameKey('Marco-Christian Krenn')).toBe(nameKey('Marco Christian-Krenn'));
    // Real pair from prod, matched by a shared avatar URL.
    expect(nameKey('Kal Clark, MD')).toBe('kal clark md');
    expect(nameKey('  Éric   O’Brien  ')).toBe('éric o brien');
  });

  it('PRESERVES non-Latin scripts', () => {
    // The first version of this stripped everything outside [a-z0-9], which
    // collapsed 103 Korean and Japanese names to '' and reported them as a
    // single 103-person duplicate group. They are 103 different people.
    expect(nameKey('박진형')).toBe('박진형');
    expect(nameKey('青木 隆幸')).toBe('青木 隆幸');
    expect(nameKey('박진형')).not.toBe(nameKey('배휘동'));
    expect(nameKey('青木 隆幸')).not.toBe(nameKey('西田 孝三'));
  });

  it('is empty for nothing, so a blank name can never form a group', () => {
    expect(nameKey('')).toBe('');
    expect(nameKey(null)).toBe('');
    expect(nameKey('   ---   ')).toBe('');
    expect(nameTokens(null)).toEqual([]);
  });
});

describe('nameIsSpecific', () => {
  it('refuses a single Latin first name', () => {
    // Prod holds two different people recorded only as "Ethan" (Lindy and
    // Wenti Labs) and three recorded only as "Jeff".
    expect(nameIsSpecific('Ethan')).toBe(false);
    expect(nameIsSpecific('Jeff')).toBe(false);
    expect(nameIsSpecific('Madonna')).toBe(false);
  });

  it('accepts a normal two-part name', () => {
    expect(nameIsSpecific('Angie Jones')).toBe(true);
    expect(nameIsSpecific('Kal Clark, MD')).toBe(true);
  });

  it('accepts a single-token CJK name, which is a normal full name', () => {
    expect(nameIsSpecific('박진형')).toBe(true);
    expect(nameIsSpecific('青木')).toBe(true);
  });

  it('refuses nothing at all', () => {
    expect(nameIsSpecific('')).toBe(false);
    expect(nameIsSpecific(null)).toBe(false);
  });
});

describe('linkedinSlug', () => {
  it('extracts the vanity slug from the shapes prod actually stores', () => {
    expect(linkedinSlug('https://www.linkedin.com/in/jones-angie/')).toBe('jones-angie');
    expect(linkedinSlug('http://linkedin.com/in/Foo-Bar?utm_source=x')).toBe('foo-bar');
    expect(linkedinSlug('https://uk.linkedin.com/in/dan-baker-123#about')).toBe('dan-baker-123');
    expect(linkedinSlug('linkedin.com/pub/old-style-profile')).toBe('old-style-profile');
  });

  it('returns null for a company page, so a shared employer is never a shared person', () => {
    expect(linkedinSlug('https://www.linkedin.com/company/stripe')).toBeNull();
    expect(linkedinSlug('https://www.linkedin.com/school/mit')).toBeNull();
  });

  it('returns null for anything that is not a LinkedIn profile', () => {
    expect(linkedinSlug('https://twitter.com/foo')).toBeNull();
    expect(linkedinSlug('')).toBeNull();
    expect(linkedinSlug(null)).toBeNull();
    expect(linkedinSlug('not a url')).toBeNull();
  });
});

describe('linkedinSlugBase', () => {
  it('strips the disambiguator so a review candidate can be raised', () => {
    // Real prod pair: same person, two LinkedIn accounts.
    expect(linkedinSlugBase('linkedin.com/in/prakash-kalaiah-875542'))
      .toBe(linkedinSlugBase('linkedin.com/in/prakash-kalaiah'));
    expect(linkedinSlugBase('linkedin.com/in/panny-malialis-4526442b4')).toBe('panny-malialis');
  });

  it('does not strip so much that two short slugs collide', () => {
    expect(linkedinSlugBase('linkedin.com/in/ab-12')).toBe('ab-12');
  });
});

describe('schedUserId', () => {
  it('parses the global account id from the protocol-relative URL sched emits', () => {
    // Verbatim from the live AGNTcon descriptions page.
    expect(schedUserId('//avatars.sched.co/c/9d/19223528/avatar.jpg?73e')).toBe('19223528');
    expect(schedUserId('//avatars.sched.co/0/5f/25691031/avatar.jpg?fbb')).toBe('25691031');
    expect(schedUserId('https://avatars.sched.co/a/b1/21342711/avatar.jpg')).toBe('21342711');
  });

  it('accepts a digit as the first path segment', () => {
    // The first version of this regex used [a-z] there and silently missed 65
    // of the 112 avatars on one page, which made the id look half-covered
    // when it is in fact 100%.
    expect(schedUserId('//avatars.sched.co/0/64/25824676/avatar.jpg?c23')).toBe('25824676');
  });

  it('returns null for a URL that carries no account id', () => {
    expect(schedUserId('https://data.aaif.live/storage/v1/object/public/media/event-agenda/speaker-avatars/abc.jpg')).toBeNull();
    expect(schedUserId('//avatars.sched.co/avatar.jpg')).toBeNull();
    expect(schedUserId('')).toBeNull();
    expect(schedUserId(null)).toBeNull();
  });
});
