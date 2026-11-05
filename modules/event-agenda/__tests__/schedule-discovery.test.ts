import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeSchedConfig,
  detectOnPage,
  discoverSchedule,
  eventPathPrefix,
  isDiscoveryFailure,
  sameEvent,
  scheduleCandidateLinks,
  slugAlias,
} from '../lib/schedule-sources/discover';
import { speakerLinkedIn } from '../lib/schedule-sources/sessionize';

const FIX = join(__dirname, '..', '__fixtures__');
const inlinePage = readFileSync(join(FIX, 'lf-inline', 'schedule-page.html'), 'utf8');
const homePage = readFileSync(join(FIX, 'lf-inline', 'event-home.html'), 'utf8');
const HOME = 'https://events.linuxfoundation.org/agntcon-mcpcon-north-america/';

describe('decodeSchedConfig', () => {
  it('reads the inline Sessionize plugin config out of its HTML-escaped attribute', () => {
    const cfg = decodeSchedConfig(inlinePage);
    expect(cfg).toEqual({
      apiUrl: 'https://sessionize.com/api/v2/0d2wfbyq/view/All',
      apiCode: '0d2wfbyq',
      publicSlug: 'pytorch-conference-north-america-2026',
    });
  });

  it('returns null without the attribute, and falls back to the api code when the url is odd', () => {
    expect(decodeSchedConfig('<div class="sched">nothing</div>')).toBeNull();
    const html = `<div data-sched-config="${'{"sessionizeAllDataUrl":"javascript:alert(1)","sessionizeApiCode":"abc123xy"}'.replace(/"/g, '&quot;')}">`;
    expect(decodeSchedConfig(html)?.apiUrl).toBe('https://sessionize.com/api/v2/abc123xy/view/All');
    expect(decodeSchedConfig('<div data-sched-config="&quot;not json">')).toBeNull();
  });
});

describe('detectOnPage', () => {
  it('maps an inline Sessionize page to the API v2 feed and remembers the hosted site for its timezone', () => {
    const hit = detectOnPage('https://events.linuxfoundation.org/pytorch-conference/program/schedule/', inlinePage);
    expect(hit?.source.kind).toBe('sessionize');
    expect(hit?.resolvedUrl).toBe('https://sessionize.com/api/v2/0d2wfbyq/view/All');
    expect(hit?.hostedOrigin).toBe('https://pytorch-conference-north-america-2026.sessionize.com');
    expect(hit?.inline).toBe(true);
  });

  it('prefers the inline feed on a schedule page over a hosted link on the home page', async () => {
    const home = 'https://events.linuxfoundation.org/pytorch-conference-north-america/';
    const site: Record<string, { ok: boolean; status: number; text: string; finalUrl?: string }> = {
      [home]: { ok: true, status: 200, text: `<a href="https://pytorch-conference-north-america-2026.sessionize.com/">Full schedule</a> <a href="${home}program/schedule/">Schedule</a>`, finalUrl: home },
      [`${home}program/schedule/`]: { ok: true, status: 200, text: inlinePage, finalUrl: `${home}program/schedule/` },
    };
    const r = await discoverSchedule(home, async (u) => site[u] ?? { ok: false, status: 404, text: '', finalUrl: u });
    expect(!isDiscoveryFailure(r) && r.resolvedUrl).toBe('https://sessionize.com/api/v2/0d2wfbyq/view/All');
    expect(!isDiscoveryFailure(r) && r.hostedOrigin).toBe('https://pytorch-conference-north-america-2026.sessionize.com');
    // Without a schedule page the hosted link is still used.
    const only = await discoverSchedule(home, async (u) => (u === home ? site[home] : { ok: false, status: 404, text: '', finalUrl: u }));
    expect(!isDiscoveryFailure(only) && only.resolvedUrl).toBe('https://pytorch-conference-north-america-2026.sessionize.com');
  });

  it('still finds a sched embed the old way', () => {
    const hit = detectOnPage('https://events.linuxfoundation.org/oss-eu/program/schedule/', '<iframe src="https://osselceu2026.sched.com/"></iframe>');
    expect(hit?.source.kind).toBe('sched');
    expect(hit?.resolvedUrl).toBe('https://osselceu2026.sched.com');
  });
});

describe('scheduleCandidateLinks / sameEvent', () => {
  it('keeps same-site links under the event prefix, ranks the conventional path first, drops other events and other sites', () => {
    expect(scheduleCandidateLinks(HOME, homePage)).toEqual([
      'https://events.linuxfoundation.org/agntcon-mcpcon-north-america/program/schedule/',
      'https://events.linuxfoundation.org/agntcon-mcpcon-north-america/program/schedule-at-a-glance/',
      'https://events.linuxfoundation.org/agntcon-mcpcon-north-america/program/agenda/',
    ]);
  });

  it('knows which redirects leave the event', () => {
    expect(eventPathPrefix(HOME)).toBe('/agntcon-mcpcon-north-america/');
    expect(eventPathPrefix('https://events.linuxfoundation.org/')).toBeNull();
    expect(sameEvent('https://events.linuxfoundation.org/', 'https://events.linuxfoundation.org/anything/')).toBe(false);
    expect(sameEvent(HOME, 'https://events.linuxfoundation.org/agntcon-mcpcon-north-america/program/schedule/')).toBe(true);
    expect(sameEvent(HOME, 'https://events.linuxfoundation.org/chisel-community-conference/program/schedule/')).toBe(false);
    expect(sameEvent(HOME, 'https://evil.example/agntcon-mcpcon-north-america/')).toBe(false);
  });
});

describe('discoverSchedule', () => {
  const pages: Record<string, { ok: boolean; status: number; text: string; finalUrl?: string }> = {
    [HOME]: { ok: true, status: 200, text: homePage, finalUrl: HOME },
    // The conventional path 301s to a different event: must be ignored, not parsed.
    [`${HOME}program/schedule/`]: {
      ok: true, status: 200, text: inlinePage,
      finalUrl: 'https://events.linuxfoundation.org/chisel-community-conference/program/schedule/',
    },
    [`${HOME}program/schedule-at-a-glance/`]: { ok: true, status: 200, text: '<h1>Schedule coming soon</h1>', finalUrl: `${HOME}program/schedule-at-a-glance/` },
    [`${HOME}program/agenda/`]: { ok: true, status: 200, text: inlinePage, finalUrl: `${HOME}program/agenda/` },
  };
  const get = async (u: string) => pages[u] ?? { ok: false, status: 404, text: '', finalUrl: u };

  it('follows the home page to the schedule page and ignores the redirect to another event', async () => {
    const reads: string[] = [];
    const r = await discoverSchedule(HOME, async (u) => { reads.push(u); return get(u); });
    expect(isDiscoveryFailure(r)).toBe(false);
    if (!isDiscoveryFailure(r)) {
      expect(r.resolvedUrl).toBe('https://sessionize.com/api/v2/0d2wfbyq/view/All');
      expect(r.pageUrl).toBe(`${HOME}program/agenda/`);
    }
    expect(reads).toEqual([HOME, `${HOME}program/schedule/`, `${HOME}program/schedule-at-a-glance/`, `${HOME}program/agenda/`]);
  });

  it('claims a feed url without reading anything', async () => {
    const r = await discoverSchedule('https://agntcon-mcpcon-na-2026.sessionize.com/', async () => { throw new Error('must not fetch'); });
    expect(!isDiscoveryFailure(r) && r.resolvedUrl).toBe('https://agntcon-mcpcon-na-2026.sessionize.com');
  });

  it('reports the pages it read when nothing has a programme', async () => {
    const r = await discoverSchedule(HOME, async (u) => (u === HOME ? get(u) : { ok: true, status: 200, text: '<p>coming soon</p>', finalUrl: u }));
    expect(isDiscoveryFailure(r)).toBe(true);
    if (isDiscoveryFailure(r)) {
      expect(r.pagesTried).toHaveLength(4);
      expect(r.reason).toMatch(/no sched\.com or Sessionize programme/);
    }
  });

  it('refuses a site root as a start page without reading it', async () => {
    const r = await discoverSchedule('https://events.linuxfoundation.org/', async () => { throw new Error('must not fetch'); });
    expect(isDiscoveryFailure(r) && r.reason).toMatch(/site root/);
  });

  it('follows the event link to its canonical slug on the same site and discovers from there', async () => {
    const OLD = 'https://events.linuxfoundation.org/pytorch-conference/';
    const NEW = 'https://events.linuxfoundation.org/pytorch-conference-north-america/';
    const site: Record<string, { ok: boolean; status: number; text: string; finalUrl?: string }> = {
      [OLD]: { ok: true, status: 200, text: `<a href="${NEW}program/schedule/">Schedule</a>`, finalUrl: NEW },
      [`${NEW}program/schedule/`]: { ok: true, status: 200, text: inlinePage, finalUrl: `${NEW}program/schedule/` },
    };
    const r = await discoverSchedule(OLD, async (u) => site[u] ?? { ok: false, status: 404, text: '', finalUrl: u });
    expect(!isDiscoveryFailure(r) && r.pageUrl).toBe(`${NEW}program/schedule/`);
    expect(!isDiscoveryFailure(r) && r.resolvedUrl).toBe('https://sessionize.com/api/v2/0d2wfbyq/view/All');
  });

  it('does not follow a retired edition to a different year', async () => {
    const r = await discoverSchedule('https://events.linuxfoundation.org/foo-2023/', async (u) => ({ ok: true, status: 200, text: '', finalUrl: 'https://events.linuxfoundation.org/foo-2025/' }));
    expect(isDiscoveryFailure(r) && r.reason).toMatch(/different event/);
    expect(slugAlias('https://x.org/pytorch-conference/', 'https://x.org/pytorch-conference-north-america/')).toBe(true);
    expect(slugAlias('https://x.org/pytorch-conference-north-america/', 'https://x.org/pytorch-conference/')).toBe(true);
    expect(slugAlias('https://x.org/foo-2023/', 'https://x.org/foo-2025/')).toBe(false);
    expect(slugAlias('https://x.org/foo/', 'https://x.org/foobar/')).toBe(false);
  });

  it('stops when the event link redirects to another host', async () => {
    const r = await discoverSchedule(HOME, async (u) => ({ ok: true, status: 200, text: '', finalUrl: 'https://elsewhere.example/x/' }));
    expect(isDiscoveryFailure(r) && r.reason).toMatch(/redirected away from the site/);
  });

  it('treats a page the fetch guard refuses as unreadable and carries on', async () => {
    const reads: string[] = [];
    const r = await discoverSchedule(HOME, async (u) => {
      reads.push(u);
      if (u === HOME) return get(u);
      if (u === `${HOME}program/schedule/`) throw new Error('too many redirects');
      return get(u);
    });
    expect(!isDiscoveryFailure(r) && r.pageUrl).toBe(`${HOME}program/agenda/`);
    const refusedStart = await discoverSchedule(HOME, async () => { throw new Error('too many redirects'); });
    expect(isDiscoveryFailure(refusedStart) && refusedStart.reason).toMatch(/could not read the event page: too many redirects/);
  });
});

describe('speakerLinkedIn', () => {
  it('takes the LinkedIn link, strips tracking, and refuses anything that is not a profile', () => {
    expect(speakerLinkedIn({ id: 'a', links: [{ title: 'LinkedIn', url: 'https://www.linkedin.com/in/aaresh-sharma-452b72116?utm_source=share&utm_campaign=share_via', linkType: 'LinkedIn' }] }))
      .toBe('https://www.linkedin.com/in/aaresh-sharma-452b72116');
    expect(speakerLinkedIn({ id: 'b', links: [{ title: 'Website', url: 'https://linkedin.com/in/someone/', linkType: 'Other' }] }))
      .toBe('https://www.linkedin.com/in/someone');
    expect(speakerLinkedIn({ id: 'c', links: [{ title: 'LinkedIn', url: 'http://www.linkedin.com/in/plain', linkType: 'LinkedIn' }] })).toBe('https://www.linkedin.com/in/plain');
    expect(speakerLinkedIn({ id: 'c2', links: [{ title: 'LinkedIn', url: 'ftp://www.linkedin.com/in/plain', linkType: 'LinkedIn' }] })).toBeNull();
    expect(speakerLinkedIn({ id: 'd', links: [{ title: 'LinkedIn', url: 'https://www.linkedin.com/company/acme', linkType: 'LinkedIn' }] })).toBeNull();
    expect(speakerLinkedIn({ id: 'e', links: [{ title: 'LinkedIn', url: 'https://linkedin.com.evil.example/in/x', linkType: 'LinkedIn' }] })).toBeNull();
    expect(speakerLinkedIn({ id: 'f' })).toBeNull();
  });
});

describe('websiteLinkIsCandidate', () => {
  it('accepts only https links on allowlisted hosts', async () => {
    const { websiteLinkIsCandidate } = await import('../lib/import-safety');
    expect(websiteLinkIsCandidate('https://events.linuxfoundation.org/agntcon-mcpcon-north-america/')).toBe(true);
    expect(websiteLinkIsCandidate('http://events.linuxfoundation.org/x/')).toBe(false);
    expect(websiteLinkIsCandidate('https://lu.ma/some-event')).toBe(false);
    expect(websiteLinkIsCandidate('')).toBe(false);
    expect(websiteLinkIsCandidate(null)).toBe(false);
  });
});
