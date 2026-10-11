import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { schedSource, parseIcs, parseDescriptionsHtml } from '../lib/schedule-sources/sched';
import {
  normalizeTitle, stripSpeakerSuffix, splitRoleCompany, extractSessionType,
} from '../lib/normalize-title';

const dir = join(__dirname, '..', '__fixtures__', 'sched', 'agntconmcpconeu26');
const raw = {
  kind: 'sched',
  resolvedUrl: 'https://agntconmcpconeu26.sched.com',
  parts: {
    ics: readFileSync(join(dir, 'all.ics'), 'utf8'),
    html: readFileSync(join(dir, 'descriptions.html'), 'utf8'),
  },
};

describe('title helpers', () => {
  it('strips a speaker suffix only when the tail looks like a person list', () => {
    expect(stripSpeakerSuffix('Keynote: Welcome - Angie Jones, Vice President, AAIF'))
      .toBe('Keynote: Welcome');
    // A dash with no comma or ampersand is part of the title, not a speaker.
    expect(stripSpeakerSuffix('Agents - From Prototype to Production'))
      .toBe('Agents - From Prototype to Production');
  });

  it('splits Role, Company on the LAST comma — roles contain commas', () => {
    expect(splitRoleCompany('Organizer | Platform Engineer, AAIF Community Seoul'))
      .toEqual({ role: 'Organizer | Platform Engineer', company: 'AAIF Community Seoul' });
    // No comma: sched renders an employer-only speaker this way.
    expect(splitRoleCompany('Solo.io')).toEqual({ role: null, company: 'Solo.io' });
    expect(splitRoleCompany('')).toEqual({ role: null, company: null });
  });

  it('lifts a type prefix off the title', () => {
    expect(extractSessionType('Workshop: Building Agents'))
      .toEqual({ title: 'Building Agents', sessionType: 'workshop' });
    expect(extractSessionType('Scaling Agents'))
      .toEqual({ title: 'Scaling Agents', sessionType: null });
  });

  it('normalises sched and YouTube spellings of the same talk to one key', () => {
    expect(normalizeTitle('Keynote: Welcome - Angie Jones, VP, AAIF'))
      .toBe(normalizeTitle('Welcome'));
  });
});

describe('sched detect', () => {
  it('accepts a sched host and rebuilds the origin', () => {
    expect(schedSource.detect('https://agntconmcpconeu26.sched.com/list/simple?iframe=no'))
      .toEqual({ resolvedUrl: 'https://agntconmcpconeu26.sched.com' });
  });

  it('finds the host in an embedding page, never from the event slug', () => {
    const html = '<script src="//mcpseoul2026.sched.com/js/embed.js"></script>';
    expect(schedSource.detect('https://events.linuxfoundation.org/x/program/schedule/', html))
      .toEqual({ resolvedUrl: 'https://mcpseoul2026.sched.com' });
  });

  it('claims nothing for an unrelated page', () => {
    expect(schedSource.detect('https://example.com/schedule', '<html></html>')).toBeNull();
    expect(schedSource.detect('https://sched.com.evil.com/')).toBeNull();
  });
});

describe('sched parse against the captured programme', () => {
  const parsed = schedSource.parse(raw as never);

  it('joins ICS to HTML 1:1 on the a.name id attribute', () => {
    // Grounded correction: the spec said the join key was the href id
    // ("event/2RBSv/..."); it is the `id` attribute, which equals the ICS UID.
    expect(parsed.diagnostics.sessionsFromIcs).toBe(113);
    expect(parsed.diagnostics.sessionsFromHtml).toBe(113);
    expect(parsed.diagnostics.skeletonMismatch).toBe(0);
  });

  it('separates programme content from logistics and expo slots', () => {
    const sessions = parsed.sessions.filter((s) => s.kind === 'session');
    const breaks = parsed.sessions.filter((s) => s.kind === 'break');
    expect(sessions).toHaveLength(92);
    expect(breaks).toHaveLength(21);
    // Every real session has someone presenting it — the signal that the
    // break/expo classification is not swallowing talks or leaking stands.
    expect(sessions.filter((s) => s.speakers.length === 0)).toHaveLength(0);
  });

  it('carries the speaker detail the recap was previously guessing', () => {
    const speakers = parsed.sessions.flatMap((s) => s.speakers);
    expect(speakers).toHaveLength(114);
    expect(new Set(speakers.map((s) => s.ref)).size).toBe(107);
    expect(speakers.filter((s) => s.company)).toHaveLength(114);
    expect(speakers.filter((s) => s.role)).toHaveLength(113);
  });

  it('classifies session types from category, prefix and speaker count', () => {
    const byType = parsed.sessions
      .filter((s) => s.kind === 'session')
      .reduce<Record<string, number>>((a, s) => {
        a[s.sessionType] = (a[s.sessionType] ?? 0) + 1;
        return a;
      }, {});
    expect(byType).toEqual({ keynote: 15, talk: 69, workshop: 5, panel: 3 });
  });

  it('takes the room from the HTML, not the ICS venue+city string', () => {
    const withLoc = parsed.sessions.find((s) => s.location);
    expect(withLoc?.location).toBeTruthy();
    expect(withLoc?.location).not.toMatch(/Netherlands/);
  });

  it('tolerates a programme with no Presentation Language field', () => {
    // Seoul carried one on every talk; this event carries none at all, so the
    // field must stay optional rather than being assumed present.
    expect(parsed.sessions.every((s) => s.language === null)).toBe(true);
  });

  it('builds one track per distinct category', () => {
    expect(parsed.tracks.length).toBe(15);
    expect(parsed.tracks.every((t) => t.ref && t.name)).toBe(true);
  });
});

describe('ics parsing', () => {
  it('unfolds lines and unescapes values', () => {
    const events = parseIcs(raw.parts.ics);
    expect(events).toHaveLength(113);
    expect(events.every((e) => e.uid && e.summary)).toBe(true);
    expect(events.some((e) => (e.location ?? '').includes(','))).toBe(true);
  });
});

describe('html parsing', () => {
  it('reads every session block, keyed by the ICS uid', () => {
    const sessions = parseDescriptionsHtml(raw.parts.html);
    expect(sessions).toHaveLength(113);
    expect(sessions.every((s) => /^[0-9a-f]{32}$/.test(s.uid))).toBe(true);
  });
});

describe('the sched account id, which is what dedupe keys on', () => {
  const parsed = schedSource.parse(raw as never);
  const speakers = parsed.sessions.flatMap((s) => s.speakers);

  it('extracts a numeric account id for every speaker who has an avatar', () => {
    const withAvatar = speakers.filter((s) => s.avatarUrl);
    expect(withAvatar.length).toBeGreaterThan(90);
    // 100% on the real programme: every avatar URL carries the id.
    expect(withAvatar.filter((s) => s.sourceUserId).length).toBe(withAvatar.length);
    expect(withAvatar.every((s) => /^\d{3,}$/.test(String(s.sourceUserId)))).toBe(true);
  });

  it('reads the id even when the first path segment is a digit', () => {
    // //avatars.sched.co/0/64/25824676/avatar.jpg — a [a-z] class here silently
    // missed 65 of 112 avatars and made coverage look like 42%.
    const digitFirst = speakers.filter((s) => /avatars\.sched\.co\/\d\//.test(s.avatarUrl ?? ''));
    expect(digitFirst.length).toBeGreaterThan(0);
    expect(digitFirst.every((s) => s.sourceUserId)).toBe(true);
  });

  it('leaves the id null when a speaker has no avatar, rather than inventing one', () => {
    for (const s of speakers.filter((x) => !x.avatarUrl)) {
      expect(s.sourceUserId).toBeNull();
    }
  });

  it('gives the same person the same id across their sessions', () => {
    const byId = new Map<string, Set<string>>();
    for (const s of speakers) {
      if (!s.sourceUserId) continue;
      const set = byId.get(s.sourceUserId) ?? new Set<string>();
      set.add(s.ref);
      byId.set(s.sourceUserId, set);
    }
    // At least one id spans two slugs — that is the case the id exists for,
    // and the reason the slug alone is not the key.
    expect([...byId.values()].some((refs) => refs.size >= 1)).toBe(true);
    expect(byId.size).toBeGreaterThan(40);
  });
});
