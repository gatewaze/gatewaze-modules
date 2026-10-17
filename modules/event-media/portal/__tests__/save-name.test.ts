import { describe, it, expect } from 'vitest';
import { saveNameOf } from '../event-pages/_components/_lib/save-name';

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
