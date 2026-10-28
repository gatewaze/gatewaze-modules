import { describe, it, expect } from 'vitest';
import { fileKey, filedFrom, inBatches, isDeliverable, progressLine, toDeliver } from '../event-pages/_components/_lib/delivery';

const f = (name: string, size = 12_000_000, type = 'image/jpeg') => ({ name, size, type });

describe('what we take from a photographer\'s folder', () => {
  it('takes photographs, and videos where the link allows them', () => {
    expect(isDeliverable(f('DSC_4821.jpg'), { allowVideo: false })).toBe(true);
    expect(isDeliverable(f('speech.mp4', 2e9, 'video/mp4'), { allowVideo: true })).toBe(true);
    expect(isDeliverable(f('speech.mp4', 2e9, 'video/mp4'), { allowVideo: false })).toBe(false);
  });

  // A folder has more in it than photographs.
  it('passes over everything else quietly', () => {
    expect(isDeliverable(f('.DS_Store', 6148, ''), { allowVideo: true })).toBe(false);
    expect(isDeliverable(f('contact-sheet.pdf', 2e6, 'application/pdf'), { allowVideo: true })).toBe(false);
    expect(isDeliverable(f('catalogue.lrcat', 9e8, ''), { allowVideo: true })).toBe(false);
    expect(isDeliverable(f('empty.jpg', 0), { allowVideo: true })).toBe(false);
  });

  it('trusts the name when the browser gives no type', () => {
    expect(isDeliverable(f('DSC_4821.JPG', 12e6, ''), { allowVideo: false })).toBe(true);
  });
});

describe('picking up where the last sitting left off', () => {
  it('leaves out what has already been delivered', () => {
    const files = [f('a.jpg'), f('b.jpg'), f('c.jpg')];
    const already = new Set([fileKey(f('b.jpg'))]);
    expect(toDeliver(files, already).map((x) => x.name)).toEqual(['a.jpg', 'c.jpg']);
  });

  it('counts a file picked twice in one go once', () => {
    expect(toDeliver([f('a.jpg'), f('a.jpg')], new Set()).length).toBe(1);
  });

  // Same name, different photograph: the camera restarted its numbering.
  it('tells two files apart by size as well as name', () => {
    const already = new Set([fileKey(f('DSC_0001.jpg', 12_000_000))]);
    expect(toDeliver([f('DSC_0001.jpg', 9_400_000)], already).length).toBe(1);
  });
});

describe('saying how far through it is', () => {
  it('reads as a sentence', () => {
    expect(progressLine({ total: 8000, done: 1203, failed: 0, skipped: 0 })).toBe('1,203 of 8,000 sent');
    expect(progressLine({ total: 8000, done: 1203, failed: 14, skipped: 200 }))
      .toBe('1,203 of 8,000 sent · 14 could not be sent · 200 already here');
    expect(progressLine({ total: 0, done: 0, failed: 0, skipped: 900 }))
      .toBe('Everything here has been delivered already.');
    expect(progressLine({ total: 0, done: 0, failed: 0, skipped: 0 })).toBe('');
  });
});

describe('batching', () => {
  it('splits into batches the mint endpoint will take', () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBatches([], 20)).toEqual([]);
    // A nonsense size is one at a time rather than an endless loop.
    expect(inBatches([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('what the server filed', () => {
  it('remembers only the uploads the server filed', () => {
    const { filed, stop } = filedFrom(207, { items: [
      { media_id: 'a', status: 'created' },
      { media_id: 'b', status: 'already_created' },
      { media_id: 'c', status: 'failed', error: 'object_missing' },
    ] });
    expect([...filed].sort()).toEqual(['a', 'b']);
    expect(stop).toBeNull();
  });

  it('stops when the link\'s album has gone, and remembers nothing', () => {
    const { filed, stop } = filedFrom(409, { error: 'album_unavailable' });
    expect(filed.size).toBe(0);
    expect(stop).toMatch(/album/);
  });

  it('remembers nothing from an error or no answer', () => {
    expect(filedFrom(500, { items: [{ media_id: 'a', status: 'created' }] }).filed.size).toBe(0);
    expect(filedFrom(0, null).filed.size).toBe(0);
    expect(filedFrom(429, {}).stop).toBeNull();
  });
});
