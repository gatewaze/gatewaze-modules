/**
 * The generated titles and copy (lib/titles.ts, spec §18.3).
 *
 * The cases that matter are the ones where a naive template produces
 * something embarrassing on a public channel: a title truncated mid-word, a
 * speaker list that eats the whole 100-character budget, and a talk with no
 * programme data at all.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTitle,
  buildDescription,
  buildPostVariants,
  generateCopy,
  truncateWords,
  speakerNames,
  speakerCredit,
  cleanLine,
  TITLE_LIMITS,
} from '../lib/titles.js';

const liran = { name: 'Liran Tal', role: 'Director of Developer Relations', company: 'Snyk' };
const jake = { name: 'Jake Moghtader', role: 'Founding ML Engineer', company: 'Runlayer' };

describe('buildTitle', () => {
  it('NEVER appends the speaker, because neither real channel does', () => {
    // Measured on 2026-10-11 across the 30 most recent videos on
    // @AgenticAI-Foundation (40.8k subs) and @AAIFLive: 0 of 30 titles carry
    // a "Talk | Speaker" separator, and no title names the speaker at all.
    // This template used to emit exactly that shape.
    expect(buildTitle({ talkTitle: 'Most MCP Servers are Empty', speakers: [liran] }))
      .toBe('Most MCP Servers are Empty');
    expect(buildTitle({ talkTitle: 'Most MCP Servers are Empty', speakers: [liran, jake] }))
      .not.toContain('|');
  });

  it('names the speaker ONLY when there is no title to use instead', () => {
    expect(buildTitle({ talkTitle: '', speakers: [liran] })).toBe('Liran Tal');
  });

  it('keeps every platform title inside that platform\'s own limit', () => {
    const long = {
      talkTitle: 'Agents Talking To Agents: MCP, A2A and the Reality of Multi-Agent Orchestration in Production',
      speakers: [liran, jake],
    };
    for (const [platform, limit] of Object.entries(TITLE_LIMITS)) {
      const t = buildTitle(long, platform);
      expect(t.length, `${platform} title was ${t.length} > ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it('never truncates mid-word', () => {
    const t = buildTitle({
      talkTitle: 'Agents Talking To Agents: MCP, A2A and the Reality of Multi-Agent Orchestration in Production',
      speakers: [liran],
    }, 'youtube');
    // The ellipsis is the only thing allowed to follow a partial word, and the
    // character before it must not be a letter mid-word.
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t).not.toMatch(/Produc\b/);
  });

  it('drops the speakers rather than squeezing the talk into nothing', () => {
    // Five long names would leave almost no room for the title.
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `Bartholomew Fitzgerald-Smythe ${i}` }));
    const t = buildTitle({ talkTitle: 'Stateless: The Future of MCP Transports', speakers: many }, 'youtube');
    expect(t).toContain('Stateless');
    expect(t.length).toBeLessThanOrEqual(100);
  });

  it('leads a short with the hook, because a feed gives it no context', () => {
    const t = buildTitle({
      talkTitle: 'Most MCP Servers are Empty',
      kind: 'short',
      quote: 'Most MCP servers ship with no tools at all',
      speakers: [liran],
    });
    expect(t).toContain('Most MCP servers ship with no tools');
    // The hook replaces the title; it does not get a speaker bolted on.
    expect(t).not.toContain('Liran Tal');
  });

  it('falls back to the talk title for a short with no hook', () => {
    expect(buildTitle({ talkTitle: 'Most MCP Servers are Empty', kind: 'short', speakers: [liran] }))
      .toBe('Most MCP Servers are Empty');
  });

  it('stays near the length the real channels publish at', () => {
    // Median 40 characters on @AgenticAI-Foundation, 42 on @AAIFLive, against
    // a 100-character budget. A programme title that is already short should
    // come through untouched rather than padded.
    const t = buildTitle({ talkTitle: 'AI Agents Can Delete Everything', speakers: [liran, jake] });
    expect(t).toBe('AI Agents Can Delete Everything');
    expect(t.length).toBeLessThan(60);
  });

  it('stays honest when there is no programme data', () => {
    expect(buildTitle({ talkTitle: '' })).toBe('Conference talk');
    expect(buildTitle({ talkTitle: '', speakers: [liran] })).toBe('Liran Tal');
  });

  it('strips newlines and control characters, which would break a title field', () => {
    const t = buildTitle({ talkTitle: 'Line one\nLine two\tand\x00more', speakers: [] });
    expect(t).not.toMatch(/[\n\t\x00]/);
    expect(t).toBe('Line one Line two and more');
  });
});

describe('truncateWords', () => {
  it('leaves a short string untouched', () => {
    expect(truncateWords('short', 100)).toBe('short');
  });

  it('breaks on a word and marks the cut', () => {
    expect(truncateWords('the quick brown fox jumps', 15)).toBe('the quick…');
  });

  it('hard-cuts rather than returning one word from a long first token', () => {
    const t = truncateWords('Supercalifragilisticexpialidocious extra', 12);
    expect(t.length).toBeLessThanOrEqual(12);
  });

  it('does not leave dangling punctuation before the ellipsis', () => {
    expect(truncateWords('Attribution by Design: Skills, MCP, and more', 24)).not.toMatch(/[,:]…$/);
  });
});

describe('speakerNames and speakerCredit', () => {
  it('joins two with an ampersand and three with a comma then ampersand', () => {
    expect(speakerNames([liran])).toBe('Liran Tal');
    expect(speakerNames([liran, jake])).toBe('Liran Tal & Jake Moghtader');
    expect(speakerNames([liran, jake, { name: 'Ola Hungerford' }]))
      .toBe('Liran Tal, Jake Moghtader & Ola Hungerford');
  });

  it('caps the list so a nine-person panel does not fill the title', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `Person ${i}` }));
    expect(speakerNames(many).split(',').length).toBeLessThanOrEqual(3);
  });

  it('builds "role, company" and copes with either missing', () => {
    expect(speakerCredit(liran)).toBe('Director of Developer Relations, Snyk');
    expect(speakerCredit({ name: 'X', company: 'Snyk' })).toBe('Snyk');
    expect(speakerCredit({ name: 'X', role: 'Engineer' })).toBe('Engineer');
    expect(speakerCredit({ name: 'X' })).toBe('');
    expect(speakerCredit(undefined)).toBe('');
  });

  it('tolerates a missing or non-string name', () => {
    expect(speakerNames([{ name: '' }, liran])).toBe('Liran Tal');
    expect(speakerNames(undefined)).toBe('');
  });
});

describe('buildDescription', () => {
  it('orders it talk, speakers, takeaway, quote, event, link', () => {
    const d = buildDescription({
      talkTitle: 'Most MCP Servers are Empty',
      speakers: [liran, jake],
      worthNoting: 'Argues most servers ship with no tools.',
      quote: 'Most MCP servers are empty',
      eventName: 'AGNTCon + MCPCon Europe',
      url: 'https://youtu.be/abc',
    });
    const iTalk = d.indexOf('Most MCP Servers are Empty');
    const iSpeakers = d.indexOf('Liran Tal — Director');
    const iTakeaway = d.indexOf('Argues most servers');
    const iEvent = d.indexOf('Recorded at AGNTCon');
    const iUrl = d.indexOf('https://youtu.be/abc');
    expect(iTalk).toBeLessThan(iSpeakers);
    expect(iSpeakers).toBeLessThan(iTakeaway);
    expect(iTakeaway).toBeLessThan(iEvent);
    expect(iEvent).toBeLessThan(iUrl);
  });

  it('says Speaker or Speakers according to how many there are', () => {
    expect(buildDescription({ talkTitle: 'T', speakers: [liran] })).toContain('\nSpeaker\n');
    expect(buildDescription({ talkTitle: 'T', speakers: [liran, jake] })).toContain('\nSpeakers\n');
  });

  it('omits every optional section cleanly', () => {
    expect(buildDescription({ talkTitle: 'Just a title' })).toBe('Just a title');
  });

  it('refuses a non-https link rather than publishing it', () => {
    const d = buildDescription({ talkTitle: 'T', url: 'javascript:alert(1)' });
    expect(d).not.toContain('javascript:');
  });

  it('stays within the description limit', () => {
    const d = buildDescription({ talkTitle: 'T'.repeat(300), worthNoting: 'x'.repeat(4000), quote: 'y'.repeat(2000) });
    expect(d.length).toBeLessThanOrEqual(5000);
  });
});

describe('buildPostVariants', () => {
  it('produces three distinct drafts', () => {
    const posts = buildPostVariants({ talkTitle: 'Most MCP Servers are Empty', speakers: [liran], eventName: 'AGNTCon' });
    expect(posts.map((p) => p.key)).toEqual(['professional', 'technical', 'community']);
    expect(new Set(posts.map((p) => p.text)).size).toBe(3);
  });

  it('keeps the credit in the professional variant', () => {
    const posts = buildPostVariants({ talkTitle: 'T', speakers: [liran] });
    expect(posts[0].text).toContain('Director of Developer Relations, Snyk');
  });

  it('keeps paragraph breaks but no stray control characters', () => {
    const posts = buildPostVariants({ talkTitle: 'T', worthNoting: 'A point.', url: 'https://x.test/a' });
    expect(posts[0].text).toContain('\n\n');
    expect(posts[0].text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });
});

describe('generateCopy', () => {
  it('returns a per-platform title for each platform asked for', () => {
    const copy = generateCopy(
      { talkTitle: 'Most MCP Servers are Empty', speakers: [liran] },
      ['youtube', 'linkedin', 'tiktok'],
    );
    expect(Object.keys(copy.titlesByPlatform).sort()).toEqual(['linkedin', 'tiktok', 'youtube']);
    for (const [p, t] of Object.entries(copy.titlesByPlatform)) {
      expect(t.length).toBeLessThanOrEqual(TITLE_LIMITS[p]);
    }
    expect(copy.posts).toHaveLength(3);
  });

  it('normalises the platform name before matching', () => {
    const copy = generateCopy({ talkTitle: 'T', speakers: [] }, [' YouTube ', 'TIKTOK']);
    expect(Object.keys(copy.titlesByPlatform).sort()).toEqual(['tiktok', 'youtube']);
  });

  it('ignores a platform it has no title limit for', () => {
    // The stored `platform` column is free text on purpose, so an unknown
    // value must not throw. It just gets no per-platform entry, and the UI
    // falls back to `title`.
    const copy = generateCopy({ talkTitle: 'T', speakers: [] }, ['bluesky']);
    expect(copy.titlesByPlatform).toEqual({});
    expect(copy.title.length).toBeGreaterThan(0);
  });

  it('cannot be made to write a prototype key from the request', () => {
    // `platforms` comes off the query string. Before the keys were built from
    // the constant list, this set Object.prototype.toString to a string and
    // every object in the process inherited it.
    const copy = generateCopy({ talkTitle: 'T', speakers: [] }, [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
    ]);
    expect(Object.keys(copy.titlesByPlatform)).toEqual([]);
    expect(typeof ({} as Record<string, unknown>).toString).toBe('function');
    expect(Object.getPrototypeOf({}).polluted).toBeUndefined();
    // Null prototype, so even a lookup of an inherited name returns nothing.
    expect(Object.getPrototypeOf(copy.titlesByPlatform)).toBe(null);
  });
});

describe('cleanLine', () => {
  it('collapses whitespace and caps length', () => {
    expect(cleanLine('  a   b  ')).toBe('a b');
    expect(cleanLine('x'.repeat(500), 10)).toHaveLength(10);
  });

  it('tolerates null and non-strings', () => {
    expect(cleanLine(null)).toBe('');
    expect(cleanLine(undefined)).toBe('');
    expect(cleanLine(42)).toBe('42');
  });
});
