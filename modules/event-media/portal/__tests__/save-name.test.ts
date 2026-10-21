import { describe, it, expect } from 'vitest';
import { MAX_SAVE_BYTES, fullSizeUrl, isHttpUrl, prefersShareSheet, saveNameOf, saveTypeOf } from '../event-pages/_components/_lib/save-name';

const CDN = 'https://gatewaze.b-cdn.net/storage/v1/object/public/media/event/abc/def';

describe('saveNameOf', () => {
  it('keeps the stored name, which is worth more than a uuid', () => {
    // A photographer's delivery is named by the clock it was taken at.
    expect(saveNameOf(`${CDN}/204742-alt03092-2.jpg`)).toBe('204742-alt03092-2.jpg');
  });

  it('drops a query or a fragment', () => {
    expect(saveNameOf(`${CDN}/photo.jpg?width=800&quality=80`)).toBe('photo.jpg');
    expect(saveNameOf(`${CDN}/photo.jpg#top`)).toBe('photo.jpg');
  });

  it('keeps the extensions worth keeping and normalises the rest to jpg', () => {
    expect(saveNameOf(`${CDN}/a.PNG`)).toBe('a.png');
    expect(saveNameOf(`${CDN}/a.webp`)).toBe('a.webp');
    expect(saveNameOf(`${CDN}/clip.mp4`)).toBe('clip.mp4');
    // Not a picture extension, and not one to hand the OS. It is
    // replaced rather than stacked onto, so the name stays readable and
    // the only extension on it is one from the list above.
    expect(saveNameOf(`${CDN}/a.html`)).toBe('a.jpg');
    expect(saveNameOf(`${CDN}/a.svg`)).toBe('a.jpg');
    expect(saveNameOf(`${CDN}/noext`)).toBe('noext.jpg');
  });

  it('falls back to the media id when the url has no name in it', () => {
    expect(saveNameOf('https://cdn/', { id: 'abc-123' })).toBe('photo-abc-123.jpg');
    expect(saveNameOf('', {})).toBe('photo.jpg');
  });

  // The name reaches `a.download` and a File handed to the OS share
  // sheet. Nothing that looks like a path should survive this.
  it('lets nothing through that could behave like a path', () => {
    for (const nasty of [
      `${CDN}/..%2f..%2fetc%2fpasswd`,
      `${CDN}/%2e%2e%2f%2e%2e%2fsecret.jpg`,
      'https://cdn/....//..//x.jpg',
      `${CDN}/${encodeURIComponent('../../../../root/.ssh/id_rsa')}`,
    ]) {
      const name = saveNameOf(nasty, { id: 'x' });
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name.startsWith('.')).toBe(false);
      expect(name).not.toMatch(/(^|[^A-Za-z0-9])\.\.($|[^A-Za-z0-9])/);
    }
  });

  it('strips anything outside a known-safe alphabet', () => {
    expect(saveNameOf(`${CDN}/${encodeURIComponent('a b&c;d.jpg')}`)).toBe('a-b-c-d.jpg');
    expect(saveNameOf(`${CDN}/${encodeURIComponent('"><img src=x>.jpg')}`)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('does not run away with a very long name', () => {
    const long = 'a'.repeat(400);
    const name = saveNameOf(`${CDN}/${long}.jpg`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('survives a url it cannot decode', () => {
    // A lone % is not valid percent-encoding; decodeURIComponent throws.
    const name = saveNameOf(`${CDN}/bad%name.jpg`, { id: 'y' });
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name.endsWith('.jpg')).toBe(true);
  });
});

describe('saveTypeOf', () => {
  // The type comes off a CDN response header and lands on a File handed
  // to the OS share sheet. Uploads are allowlisted at the door, but
  // enhanced copies and booth selfies are written by server code that
  // the mint/complete check does not cover.
  it('passes the types an upload is allowed to be', () => {
    expect(saveTypeOf('image/jpeg')).toBe('image/jpeg');
    expect(saveTypeOf('video/quicktime')).toBe('video/quicktime');
    expect(saveTypeOf('IMAGE/PNG')).toBe('image/png');
    expect(saveTypeOf('image/jpeg; charset=binary')).toBe('image/jpeg');
  });

  // Null, not a guess: a File with no type is inert, where one labelled
  // image/jpeg that is really something else invites whatever opens it
  // to act on the label.
  it('refuses anything else rather than relabelling it', () => {
    for (const bad of ['text/html', 'image/svg+xml', 'application/pdf', '', null, undefined, 'image']) {
      expect(saveTypeOf(bad as string)).toBeNull();
    }
  });
});

describe('isHttpUrl', () => {
  it('allows only what the browser should be pointed at', () => {
    expect(isHttpUrl('https://cdn/a.jpg')).toBe(true);
    expect(isHttpUrl('http://cdn/a.jpg')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'blob:https://x/y', 'file:///etc/passwd', '//cdn/a.jpg', '']) {
      expect(isHttpUrl(bad)).toBe(false);
    }
  });
});

describe('the size a save will hold in memory', () => {
  // A guest upload link allows a 2GB video by default (migration 003),
  // and blob() holds the whole thing at once.
  it('caps well below what a phone would survive', () => {
    expect(MAX_SAVE_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(MAX_SAVE_BYTES).toBeGreaterThan(8 * 1024 * 1024);
  });
});

describe('saveNameOf, name and type together', () => {
  it('takes its extension from the type it will be labelled with', () => {
    // The url says .jpg, the object is really a video. The name follows
    // the type, so the two cannot disagree in a camera roll.
    expect(saveNameOf('https://cdn/clip.jpg', { type: 'video/mp4' })).toBe('clip.mp4');
    expect(saveNameOf('https://cdn/a.png', { type: 'image/jpeg' })).toBe('a.jpg');
    // An unallowlisted type is not trusted to name it either.
    expect(saveNameOf('https://cdn/a.png', { type: 'text/html' })).toBe('a.png');
  });

  it('leaves one dot in the name, before the extension it chose', () => {
    expect(saveNameOf('https://cdn/a.html.png')).toBe('a-html.png');
    expect(saveNameOf('https://cdn/x..jpg')).toBe('x.jpg');
    expect(saveNameOf('https://cdn/report.final.jpg')).toBe('report-final.jpg');
  });

  it('sidesteps the names Windows refuses', () => {
    expect(saveNameOf('https://cdn/con.jpg')).toBe('con-photo.jpg');
    expect(saveNameOf('https://cdn/NUL.png')).toBe('NUL-photo.png');
    // Not reserved, merely similar.
    expect(saveNameOf('https://cdn/console.jpg')).toBe('console.jpg');
  });
});

describe('fullSizeUrl', () => {
  const ZONE = 'https://gatewaze.b-cdn.net';
  const ORIGIN = 'https://rnwwxexhxduxupfxxipo.supabase.co';
  const REL = '/storage/v1/object/public/media/event/abc/def/204742-alt03092-2.jpg';

  // Bunny Optimizer recompresses: 3,031,246 bytes in the bucket came
  // back as 1,478,272 through the zone at identical pixel dimensions.
  it('swaps the CDN prefix for the bucket', () => {
    expect(fullSizeUrl(ZONE + REL, ZONE, ORIGIN)).toBe(ORIGIN + REL);
  });

  it('drops the Optimizer resize with it', () => {
    expect(fullSizeUrl(`${ZONE}${REL}?width=1200&quality=80`, ZONE, ORIGIN)).toBe(ORIGIN + REL);
  });

  it('copes with a trailing slash on either origin', () => {
    expect(fullSizeUrl(ZONE + REL, ZONE + '/', ORIGIN + '/')).toBe(ORIGIN + REL);
  });

  // Nothing to swap is not a licence to guess: a url that is already on
  // the origin, or on some third host, is left exactly as it is.
  it('leaves alone anything not served by the zone', () => {
    expect(fullSizeUrl(ORIGIN + REL, ZONE, ORIGIN)).toBe(ORIGIN + REL);
    expect(fullSizeUrl('https://elsewhere.example' + REL, ZONE, ORIGIN)).toBe('https://elsewhere.example' + REL);
    // A host that merely starts with the same letters is not the zone.
    const lookalike = 'https://gatewaze.b-cdn.net.evil.example' + REL;
    expect(fullSizeUrl(lookalike, ZONE, ORIGIN)).toBe(lookalike);
  });

  it('does nothing when the api did not say where the bucket is', () => {
    expect(fullSizeUrl(ZONE + REL, null, ORIGIN)).toBe(ZONE + REL);
    expect(fullSizeUrl(ZONE + REL, ZONE, null)).toBe(ZONE + REL);
    expect(fullSizeUrl(ZONE + REL, undefined, undefined)).toBe(ZONE + REL);
  });

  it('refuses to point anywhere that is not http', () => {
    expect(fullSizeUrl('javascript:alert(1)', ZONE, ORIGIN)).toBe('javascript:alert(1)');
    // And will not be talked into a non-http destination either.
    expect(fullSizeUrl(ZONE + REL, ZONE, 'javascript:alert(1)')).toBe(ZONE + REL);
    expect(fullSizeUrl(ZONE + REL, ZONE, '//evil.example')).toBe(ZONE + REL);
  });
});

describe('prefersShareSheet', () => {
  // macOS Safari answers true to canShare({files}) and then opens the
  // Mac share sheet, so a download button produced a menu of apps
  // instead of a file in Downloads (reported 2026-10-17). The pointer is
  // what separates a phone from a desktop.
  it('is for a phone, not a desktop that happens to support sharing', () => {
    expect(prefersShareSheet(true, true)).toBe(true);    // phone
    expect(prefersShareSheet(true, false)).toBe(false);  // macOS Safari
    expect(prefersShareSheet(false, true)).toBe(false);  // touch, no file sharing
    expect(prefersShareSheet(false, false)).toBe(false); // desktop Chrome
  });

  it('treats a missing answer as no', () => {
    expect(prefersShareSheet(undefined as unknown as boolean, true)).toBe(false);
    expect(prefersShareSheet(true, undefined as unknown as boolean)).toBe(false);
  });
});
