import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { escapeHtml, substituteVariables, assertPublicHttpsUrl } from '../lib/promo/render-cards';
import { stringToSlug, buildDestinationUrl, shortLinkDomain } from '../lib/promo/tracking-link';
import { buildRecipeParams, dateLong, readPromoTextRun } from '../lib/promo/promo-text';
import { buildPromoKitZip } from '../lib/promo/build-zip';
import { dateShort } from '../lib/promo/context';
import type { PromoKitContext } from '../lib/promo/types';

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<img src="x" onerror='a'&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&amp;',
    );
  });
});

describe('substituteVariables', () => {
  it('substitutes and escapes user-submitted values', () => {
    const out = substituteVariables('<div>{{speaker.full_name}}</div>', {
      speaker: { full_name: '<script>alert(1)</script>' },
    });
    expect(out).toBe('<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
  });

  it('leaves unresolved variables in place for the template fallbacks', () => {
    const out = substituteVariables('{{brand.accent}} {{speaker.full_name}}', {
      speaker: { full_name: 'Jane' },
    });
    expect(out).toBe('{{brand.accent}} Jane');
  });

  it('substitutes empty strings (the hide-the-talk-line signal)', () => {
    const out = substituteVariables('“{{talk.title}}”', { talk: { title: '' } });
    expect(out).toBe('“”');
  });
});

describe('assertPublicHttpsUrl (SSRF guard)', () => {
  // Literal-IP cases are hermetic (no DNS lookup happens for them).
  it('rejects non-https schemes before any resolution', async () => {
    await expect(assertPublicHttpsUrl('http://203.0.113.5/a.png')).rejects.toThrow(/scheme not allowed/);
    await expect(assertPublicHttpsUrl('file:///etc/passwd')).rejects.toThrow(/scheme not allowed/);
  });

  it('rejects private, loopback, link-local, and metadata IPs', async () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.9', '192.168.1.1', '[::1]']) {
      await expect(assertPublicHttpsUrl(`https://${ip}/a.png`)).rejects.toThrow(/blocked IP/);
    }
  });

  it('allows a public literal IP', async () => {
    const url = await assertPublicHttpsUrl('https://203.0.113.5/a.png');
    expect(url.hostname).toBe('203.0.113.5');
  });
});

describe('stringToSlug', () => {
  it('lowercases, strips diacritics and specials, collapses dashes', () => {
    expect(stringToSlug('José Álvarez-Núñez')).toBe('jose-alvarez-nunez');
    expect(stringToSlug('  Jane   Q. Doe!! ')).toBe('jane-q-doe');
    expect(stringToSlug('---')).toBe('');
  });
});

describe('buildDestinationUrl', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.PORTAL_URL;
    delete process.env.APP_URL;
    delete process.env.PORTAL_HOST;
    delete process.env.REDIRECT_PUBLIC_BASE_URL;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const baseEvent = {
    event_id: 'evt123',
    event_slug: 'my-event',
    event_link: null as string | null,
    enable_native_registration: true as boolean | null,
  };

  it('uses the external event link when native registration is off', () => {
    const url = buildDestinationUrl({
      ...baseEvent,
      event_link: 'https://lu.ma/xyz',
      enable_native_registration: false,
    });
    expect(url).toBe('https://lu.ma/xyz');
  });

  it('builds the portal register URL from PORTAL_URL, preferring the slug', () => {
    process.env.PORTAL_URL = 'https://community.example.com/';
    const url = buildDestinationUrl(baseEvent);
    expect(url).toBe('https://community.example.com/events/my-event/register');
  });

  it('falls back to PORTAL_HOST and errors when nothing is configured', () => {
    process.env.PORTAL_HOST = 'Community.Example.com';
    expect(shortLinkDomain()).toBe('community.example.com');
    expect(buildDestinationUrl(baseEvent)).toBe(
      'https://community.example.com/events/my-event/register',
    );
    delete process.env.PORTAL_HOST;
    expect(() => buildDestinationUrl(baseEvent)).toThrow(/no portal base URL/);
  });
});

const context: PromoKitContext = {
  talk: {
    id: 't1',
    title: 'My Talk',
    synopsis: 'All about things.',
    status: 'confirmed',
    session_type: 'talk',
    duration_minutes: 30,
    edit_token: 'tok',
  },
  event: {
    id: 'e-uuid',
    event_id: 'evt123',
    event_slug: 'my-event',
    event_title: 'Community Day',
    event_start: '2026-09-16T15:00:00Z',
    event_timezone: 'UTC',
    event_city: null,
    event_link: null,
    enable_native_registration: true,
  },
  speaker: {
    profileId: 'sp1',
    fullName: 'Jane Doe',
    jobTitle: 'Engineer',
    company: 'Acme',
    bio: 'Bio here',
    avatarUrl: null,
  },
  otherSpeakers: [{ name: 'Sam Lee', talk_title: 'Other Talk' }],
};

describe('buildRecipeParams', () => {
  it('stringifies each scope and passes the tracking link verbatim', () => {
    const params = buildRecipeParams(context, 'https://x.example/go/evt123-jane-doe');
    expect(JSON.parse(params.speaker).full_name).toBe('Jane Doe');
    expect(JSON.parse(params.talk).synopsis).toBe('All about things.');
    expect(JSON.parse(params.event)).toEqual({
      title: 'Community Day',
      date_long: 'September 16',
      city_or_format: 'online',
    });
    expect(params.registration_url).toBe('https://x.example/go/evt123-jane-doe');
    expect(JSON.parse(params.other_speakers)).toEqual([{ name: 'Sam Lee', talk_title: 'Other Talk' }]);
  });
});

describe('date formatting', () => {
  it('formats long and short display dates in the event timezone', () => {
    expect(dateLong('2026-09-16T15:00:00Z', 'UTC')).toBe('September 16');
    expect(dateShort('2026-09-16T15:00:00Z', 'UTC')).toBe('SEPTEMBER 16');
    // Late-evening UTC rolls into the next day in Auckland.
    expect(dateShort('2026-09-16T23:00:00Z', 'Pacific/Auckland')).toBe('SEPTEMBER 17');
  });
});

describe('readPromoTextRun', () => {
  function fakeSupabase(run: Record<string, unknown> | null) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: run }) }),
        }),
      }),
    };
  }

  it('reports pending while the run is queued/running', async () => {
    expect(await readPromoTextRun(fakeSupabase({ status: 'queued' }), 'r1')).toEqual({ state: 'pending' });
    expect(await readPromoTextRun(fakeSupabase({ status: 'running' }), 'r1')).toEqual({ state: 'pending' });
  });

  it('validates and normalizes a complete run, parsing string output', async () => {
    const run = {
      status: 'complete',
      final_output: JSON.stringify({
        options: [
          { key: 'professional', label: 'Professional and polished', body: 'Post body' },
          { key: 'energetic', body: '   ' }, // dropped: empty body
        ],
        mention_note: ' Retype @mentions in LinkedIn. ',
      }),
    };
    const result = await readPromoTextRun(fakeSupabase(run), 'r1');
    expect(result.state).toBe('complete');
    if (result.state === 'complete') {
      expect(result.promoText.options).toHaveLength(1);
      expect(result.promoText.options[0].body).toBe('Post body');
      expect(result.promoText.mention_note).toBe('Retype @mentions in LinkedIn.');
    }
  });

  it('fails on missing rows, failed runs, and empty output', async () => {
    expect((await readPromoTextRun(fakeSupabase(null), 'r1')).state).toBe('failed');
    expect(
      (await readPromoTextRun(fakeSupabase({ status: 'failed', failure_reason: 'boom' }), 'r1')),
    ).toEqual({ state: 'failed', reason: 'boom' });
    expect(
      (await readPromoTextRun(fakeSupabase({ status: 'complete', final_output: { options: [] } }), 'r1')).state,
    ).toBe('failed');
  });
});

describe('buildPromoKitZip', () => {
  it('bundles cards, posts, tracking link, and README', async () => {
    const zipBuffer = await buildPromoKitZip({
      speakerName: 'Jane Doe',
      eventTitle: 'Community Day',
      trackingUrl: 'https://x.example/go/evt123-jane-doe',
      promoText: {
        options: [{ key: 'professional', label: 'Professional and polished', body: 'Post body' }],
        mention_note: 'Retype @mentions.',
      },
      cards: [
        { format: 'square', storage_path: 'p', width: 1200, height: 1200, png: Buffer.from('png-bytes') },
      ],
    });
    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'README.txt',
      'images/',
      'images/Jane-Doe-feed-post-1200x1200.png',
      'posts/',
      'posts/option-1-professional.txt',
      'tracking-link.txt',
    ]);
    expect(await zip.file('tracking-link.txt')!.async('string')).toBe(
      'https://x.example/go/evt123-jane-doe\n',
    );
    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('Jane Doe');
    expect(readme).toContain('Retype @mentions.');
  });

  it('omits posts and link when text failed', async () => {
    const zipBuffer = await buildPromoKitZip({
      speakerName: 'Jane',
      eventTitle: 'Event',
      trackingUrl: null,
      promoText: null,
      cards: [],
    });
    const zip = await JSZip.loadAsync(zipBuffer);
    expect(Object.keys(zip.files)).toEqual(['README.txt']);
  });
});
