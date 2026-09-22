// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { addPicture, markPosted, markUnposted, removePicture, sanitiseHistory, HISTORY_CAP } from '../event-pages/_components/_lib/booth-history.js';

const pic = (id, over = {}) => ({
  id, image: `data:image/jpeg;base64,${id}`, label: '1970s', styled: true, note: null, createdAt: 1, posted: false, mediaId: null, ...over,
});

describe('addPicture', () => {
  it('puts the newest first', () => {
    expect(addPicture([pic('a')], pic('b')).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('never holds the same picture twice', () => {
    const list = addPicture([pic('a'), pic('b')], pic('a2', { image: pic('a').image }));
    expect(list.map((p) => p.id)).toEqual(['a2', 'b']);
  });

  it('drops the oldest past the cap', () => {
    let list = [];
    for (let i = 0; i < HISTORY_CAP + 3; i++) list = addPicture(list, pic(`p${i}`));
    expect(list).toHaveLength(HISTORY_CAP);
    expect(list[0].id).toBe(`p${HISTORY_CAP + 2}`);
  });
});

describe('markPosted', () => {
  it('marks only the one picture, and remembers its upload', () => {
    const list = markPosted([pic('a'), pic('b')], 'b', 'm-1');
    expect(list.map((p) => p.posted)).toEqual([false, true]);
    expect(list[1].mediaId).toBe('m-1');
    expect(list[0].mediaId).toBeNull();
  });
});

describe('markUnposted', () => {
  // Off the screen, but still theirs: the upload id is kept for Delete.
  it('takes it off the screen and keeps its upload id', () => {
    const list = markUnposted(markPosted([pic('a')], 'a', 'm-1'), 'a');
    expect(list[0].posted).toBe(false);
    expect(list[0].mediaId).toBe('m-1');
  });
});

describe('removePicture', () => {
  it('removes just that picture', () => {
    expect(removePicture([pic('a'), pic('b')], 'a').map((p) => p.id)).toEqual(['b']);
  });
});

describe('sanitiseHistory', () => {
  it('keeps well-formed pictures', () => {
    expect(sanitiseHistory([pic('a')])).toEqual([pic('a')]);
  });

  // Storage is the browser's, not ours: nothing but an image data URL
  // may come back out of it into an <img>.
  it('drops anything that is not an image data URL', () => {
    const bad = ['javascript:alert(1)', 'https://evil.example/x.jpg', 'data:text/html;base64,PGh0bWw+', ''];
    expect(sanitiseHistory(bad.map((image, i) => pic(`x${i}`, { image })))).toEqual([]);
  });

  it('survives garbage', () => {
    for (const raw of [null, undefined, 'x', 42, {}, [null, 7, 'x', { id: 1 }]]) {
      expect(sanitiseHistory(raw)).toEqual([]);
    }
  });

  it('defaults the optional fields', () => {
    const [p] = sanitiseHistory([{ id: 'a', image: 'data:image/png;base64,AA' }]);
    expect(p).toEqual({ id: 'a', image: 'data:image/png;base64,AA', label: null, styled: false, note: null, createdAt: 0, posted: false, mediaId: null });
  });

  // The id goes back to the server in a delete request.
  it('keeps only a UUID as the upload id', () => {
    const good = '11111111-2222-4333-8444-555555555555';
    expect(sanitiseHistory([pic('a', { mediaId: good })])[0].mediaId).toBe(good);
    expect(sanitiseHistory([pic('a', { mediaId: '../x' })])[0].mediaId).toBeNull();
  });
});
