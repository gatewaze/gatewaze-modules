import { describe, expect, it } from 'vitest';
import { walkContentMedia, type MediaRef } from '../walk-content-media.js';

function makeMap(refs: MediaRef[]): ReadonlyMap<string, MediaRef> {
  return new Map(refs.map((r) => [r.publicUrl, r]));
}

const HERO_IMG: MediaRef = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  publicUrl: 'https://cdn.example.com/hero.jpg',
  storagePath: 'sites/123/media/hero.jpg',
  filename: 'hero.jpg',
  mimeType: 'image/jpeg',
};

const VIDEO: MediaRef = {
  id: '11111111-2222-3333-4444-555555555555',
  publicUrl: 'https://cdn.example.com/intro.mp4',
  storagePath: 'sites/123/media/intro.mp4',
  filename: 'intro.mp4',
  mimeType: 'video/mp4',
};

describe('walkContentMedia', () => {
  it('rewrites a matched URL and emits a job', () => {
    const out = walkContentMedia({
      content: { hero: { src: HERO_IMG.publicUrl, alt: 'banner' } },
      mediaByUrl: makeMap([HERO_IMG]),
    });
    const expectedPrefix = HERO_IMG.id.slice(0, 12);
    expect(out.rewrites).toBe(1);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({
      mediaId: HERO_IMG.id,
      storagePath: HERO_IMG.storagePath,
      gitRelativePath: `public/media/${expectedPrefix}-hero.jpg`,
      mimeType: 'image/jpeg',
    });
    expect((out.rewrittenContent as { hero: { src: string } }).hero.src).toBe(`/media/${expectedPrefix}-hero.jpg`);
  });

  it('keeps non-matching strings untouched', () => {
    const out = walkContentMedia({
      content: { hero: { src: 'https://external.com/other.jpg', alt: 'x' } },
      mediaByUrl: makeMap([HERO_IMG]),
    });
    expect(out.rewrites).toBe(0);
    expect(out.jobs).toHaveLength(0);
    expect((out.rewrittenContent as { hero: { src: string } }).hero.src).toBe('https://external.com/other.jpg');
  });

  it('walks nested arrays and objects', () => {
    const out = walkContentMedia({
      content: {
        blocks: [
          { type: 'hero', img: HERO_IMG.publicUrl },
          { type: 'video', src: VIDEO.publicUrl },
          { type: 'text', body: 'no media here' },
        ],
      },
      mediaByUrl: makeMap([HERO_IMG, VIDEO]),
    });
    expect(out.rewrites).toBe(2);
    expect(out.jobs).toHaveLength(2);
  });

  it('deduplicates jobs when the same URL appears multiple times', () => {
    const out = walkContentMedia({
      content: {
        hero: { src: HERO_IMG.publicUrl },
        thumbnail: { src: HERO_IMG.publicUrl },
        otherBlock: { background: HERO_IMG.publicUrl },
      },
      mediaByUrl: makeMap([HERO_IMG]),
    });
    expect(out.rewrites).toBe(3);
    expect(out.jobs).toHaveLength(1);
  });

  it('honours custom outputDir', () => {
    const out = walkContentMedia({
      content: { hero: HERO_IMG.publicUrl },
      mediaByUrl: makeMap([HERO_IMG]),
      outputDir: 'static/assets',
    });
    expect(out.jobs[0]?.gitRelativePath).toMatch(/^static\/assets\//);
    // URL rewrite uses the URL form (leading slash, no leading "static/" because
    // it doesn't have a 'public/' prefix to strip).
    expect((out.rewrittenContent as { hero: string }).hero).toMatch(/^\/static\/assets\//);
  });

  it('produces filesystem-safe filenames', () => {
    const tricky: MediaRef = {
      id: 'tricky-id-1234-5678-9abc-def012345678',
      publicUrl: 'https://cdn.example.com/Some File (1).jpeg',
      storagePath: 'sites/123/media/some-file-1.jpeg',
      filename: 'Some File (1).jpeg',
    };
    const out = walkContentMedia({
      content: { x: tricky.publicUrl },
      mediaByUrl: makeMap([tricky]),
    });
    expect(out.jobs[0]?.gitRelativePath).toMatch(/^public\/media\/tricky-id-12-Some-File--1-\.jpeg$/);
  });

  it('returns the content tree even when no media is found', () => {
    const original = { hero: { title: 'Hello', count: 3, active: true } };
    const out = walkContentMedia({ content: original, mediaByUrl: new Map() });
    expect(out.rewrittenContent).toEqual(original);
    expect(out.jobs).toHaveLength(0);
  });

  it('handles null content', () => {
    const out = walkContentMedia({ content: null, mediaByUrl: new Map() });
    expect(out.rewrittenContent).toBeNull();
  });
});
