import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sessionizeSource, parseSessionize, speakerRoleCompany, trackCategory } from '../lib/schedule-sources/sessionize';
import { detectSource } from '../lib/schedule-sources/index';
import { toIanaZone, localToUtcIso, offsetMinutesAt } from '../lib/tz';
import { hostAllowed, DEFAULT_HOST_ALLOWLIST, safeAvatarUrl } from '../lib/import-safety';

const dir = join(__dirname, '..', '__fixtures__', 'sessionize', 'toronto2026');
const raw = {
  kind: 'sessionize',
  resolvedUrl: 'https://mcp-dev-summit-toronto-2026.sessionize.com',
  parts: {
    schedule: readFileSync(join(dir, 'schedule.json'), 'utf8'),
    data: readFileSync(join(dir, 'data.json'), 'utf8'),
  },
};

describe('timezones', () => {
  it('maps Windows names to IANA zones and passes IANA names through', () => {
    expect(toIanaZone('Atlantic Standard Time')).toBe('America/Halifax');
    expect(toIanaZone('Eastern Standard Time')).toBe('America/New_York');
    expect(toIanaZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(toIanaZone('Not A Zone')).toBeNull();
    expect(toIanaZone('')).toBeNull();
  });
  it('converts a naive local time with the zone\'s offset at that instant, daylight saving included', () => {
    // Halifax is UTC-3 in early October (ADT) and UTC-4 in January (AST).
    expect(localToUtcIso('2026-10-05T10:50:00', 'America/Halifax')).toBe('2026-10-05T13:50:00Z');
    expect(localToUtcIso('2026-01-15T10:50:00', 'America/Halifax')).toBe('2026-01-15T14:50:00Z');
    expect(localToUtcIso('2026-10-05T10:50:00', null)).toBe('2026-10-05T10:50:00Z');
    expect(localToUtcIso('garbage', 'America/Halifax')).toBeNull();
    expect(offsetMinutesAt('Asia/Kolkata', Date.UTC(2026, 5, 1))).toBe(330);
  });
});

describe('detect', () => {
  it('claims a hosted sessionize site, an embedded API v2 feed, and nothing else', () => {
    expect(sessionizeSource.detect('https://mcp-dev-summit-toronto-2026.sessionize.com/schedule/day/20261005'))
      .toEqual({ resolvedUrl: 'https://mcp-dev-summit-toronto-2026.sessionize.com' });
    expect(sessionizeSource.detect('https://sessionize.com/api/v2/abc123/view/Sessions'))
      .toEqual({ resolvedUrl: 'https://sessionize.com/api/v2/abc123/view/All' });
    expect(sessionizeSource.detect('https://events.linuxfoundation.org/x/', '<script src="https://sessionize.com/api/v2/q9z8/view/GridSmart"></script>'))
      .toEqual({ resolvedUrl: 'https://sessionize.com/api/v2/q9z8/view/All' });
    expect(sessionizeSource.detect('https://events.linuxfoundation.org/x/', '<a href="//myconf.sessionize.com/">schedule</a>'))
      .toEqual({ resolvedUrl: 'https://myconf.sessionize.com' });
    expect(sessionizeSource.detect('https://myevent.sched.com/')).toBeNull();
    expect(sessionizeSource.detect('https://evil.com/sessionize.com/api/v2/x/view/All')).toBeNull();
  });
  it('the registry still gives sched a sched URL and sessionize a sessionize one', () => {
    expect(detectSource('https://agntconmcpconeu26.sched.com/')?.source.kind).toBe('sched');
    expect(detectSource('https://mcp-dev-summit-toronto-2026.sessionize.com/')?.source.kind).toBe('sessionize');
  });
  it('the fetch allowlists admit the hosted site, the API and the avatar CDN', () => {
    expect(hostAllowed('mcp-dev-summit-toronto-2026.sessionize.com', DEFAULT_HOST_ALLOWLIST)).toBe(true);
    expect(hostAllowed('sessionize.com', DEFAULT_HOST_ALLOWLIST)).toBe(true);
    expect(safeAvatarUrl('https://cdn.sessionize.com/image/dbfc-400o400o1-LBTdyQWHqouHhNUWT2Zisn.jpg')).toContain('cdn.sessionize.com');
  });
});

describe('Toronto 2026 fixture', () => {
  const parsed = sessionizeSource.parse(raw);

  it('reads every accepted session, the rooms, and the tracks from the session category', () => {
    expect(parsed.sessions).toHaveLength(63);
    expect(parsed.tracks.map((t) => t.name)).toContain('MCP Protocol in Depth');
    expect(parsed.tracks.map((t) => t.name)).not.toContain('Beginner');
    const talk = parsed.sessions.find((s) => s.rawTitle === 'Sessions Are Dead. Now What Breaks?');
    expect(talk).toBeTruthy();
    expect(talk!.kind).toBe('session');
    expect(talk!.location).toBe('Giovanni');
    expect(talk!.trackRef).toBe('459762');
    expect(talk!.startsAt).toBe('2026-10-05T13:50:00Z'); // 10:50 Atlantic daylight time
    expect(talk!.endsAt).toBe('2026-10-05T14:15:00Z');
    expect(talk!.speakers).toHaveLength(1);
    expect(talk!.sourceUrl).toBe(`https://mcp-dev-summit-toronto-2026.sessionize.com/session/${talk!.ref}`);
    expect(talk!.ref).toMatch(/^\d+$/);
  });

  it('treats registration, breaks and lunch as breaks with no speakers', () => {
    const breaks = parsed.sessions.filter((s) => s.kind === 'break');
    expect(breaks.length).toBe(8);
    expect(new Set(breaks.map((s) => s.rawTitle))).toEqual(new Set(['Registration', 'Break', 'Lunch']));
    for (const b of breaks) expect(b.speakers).toEqual([]);
  });

  it('keynotes and workshops come from the track, panels from the speaker count or the title', () => {
    const keynotes = parsed.sessions.filter((s) => s.sessionType === 'keynote');
    expect(keynotes.length).toBeGreaterThan(0);
    for (const k of keynotes) expect(k.trackRef).toBe('505265');
    const workshops = parsed.sessions.filter((s) => s.sessionType === 'workshop');
    expect(workshops.length).toBeGreaterThan(0);
  });

  it('speakers carry name, role, company (from the custom questions), bio, a CDN avatar and a prefixed source id', () => {
    const all = new Map<string, (typeof parsed.sessions)[number]['speakers'][number]>();
    for (const s of parsed.sessions) for (const k of s.speakers) all.set(k.ref, k);
    expect(all.size).toBeGreaterThan(55);
    const karen = [...all.values()].find((k) => k.name === 'Karen Bennet');
    expect(karen).toBeTruthy();
    expect(karen!.role).toBe('Founder');
    expect(karen!.company).toBe('xplAInr.ai');
    expect(karen!.avatarUrl).toMatch(/^https:\/\/cdn\.sessionize\.com\//);
    expect(karen!.sourceUserId).toBe('sessionize:8a153107-ad2b-42e1-84d3-ddc0a0da424f');
    expect(karen!.bio).toContain('Founder');
    for (const k of all.values()) expect(k.name.trim()).toBe(k.name);
  });

  it('diagnostics say the times were zoned', () => {
    expect(parsed.diagnostics.skeletonMismatch).toBe(0);
    expect(parsed.diagnostics.sessionsFromHtml).toBe(63);
  });
});

describe('speakerRoleCompany', () => {
  const qs = [{ id: 1, question: 'Company' }, { id: 2, question: 'Speaker Title' }];
  it('prefers the custom answers, then splits the tag line', () => {
    expect(speakerRoleCompany({ id: 'a', questionAnswers: [{ questionId: 1, answerValue: ' Okta ' }, { questionId: 2, answerValue: 'Builder Advocate' }] }, qs))
      .toEqual({ role: 'Builder Advocate', company: 'Okta' });
    expect(speakerRoleCompany({ id: 'b', tagLine: 'Senior Developer Advocate, Okta' }, qs)).toEqual({ role: 'Senior Developer Advocate', company: 'Okta' });
    expect(speakerRoleCompany({ id: 'c', tagLine: 'Staff Software Engineer at TRM Labs' }, qs)).toEqual({ role: 'Staff Software Engineer', company: 'TRM Labs' });
    expect(speakerRoleCompany({ id: 'd', tagLine: 'Solutions Consultant - Sahaj Software' }, qs)).toEqual({ role: 'Solutions Consultant', company: 'Sahaj Software' });
    expect(speakerRoleCompany({ id: 'e', tagLine: 'Independent' }, qs)).toEqual({ role: null, company: 'Independent' });
    expect(speakerRoleCompany({ id: 'f' }, qs)).toEqual({ role: null, company: null });
  });
  it('picks the track category by name, else the first session category that is not a level', () => {
    expect(trackCategory([
      { id: 1, title: 'Audience Level', type: 'session', items: [{ id: 10, name: 'Beginner' }] },
      { id: 2, title: 'All Sessions', type: 'session', items: [{ id: 20, name: 'Security' }] },
    ])?.id).toBe(2);
    expect(trackCategory([{ id: 3, title: 'Track', type: 'session', items: [{ id: 30, name: 'A' }] }, { id: 2, title: 'All Sessions', type: 'session', items: [{ id: 20, name: 'S' }] }])?.id).toBe(3);
    expect(trackCategory([])).toBeNull();
  });
  it('an API v2 feed parses the same way with floating times and no session links', () => {
    const p = parseSessionize(JSON.parse(raw.parts.schedule), null, null);
    expect(p.sessions[5].startsAt).toBe('2026-10-05T10:50:00Z');
    expect(p.sessions[5].sourceUrl).toBeNull();
    expect(p.diagnostics.skeletonMismatch).toBe(63);
  });
});
