// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { parseBoothTheme } from '../booth-theme.js';

const url = (f) => `https://cdn.example/booth-theme/${f}`;
const LOOKS = { '1980s': new Set(['top-gun', 'synthwave']), '1970s': new Set(['seventies-disco']) };
const looksFor = (era) => LOOKS[era] ?? new Set();

const ROOM = {
  image: 'inside-1980s.webp', width: 941, height: 1672,
  window: { x: 0.16, y: 0.18, w: 0.67, h: 0.53 },
  coin: { x: 0.3, y: 0.76, w: 0.1, h: 0.11 },
  panel: { x: 0.14, y: 0.73, w: 0.72, h: 0.18 },
};

const theme = (over = {}) => ({
  version: 2,
  picker: {
    image: 'eras.webp', width: 941, height: 1672, focus_x: 0.85,
    tiles: [{ key: '1980s', x: 0.29, y: 0.19, w: 0.29, h: 0.19 }, { key: '1970s', x: 0.6, y: 0.19, w: 0.29, h: 0.19 }],
  },
  eras: {
    '1980s': { interior: ROOM, samples: { 'top-gun': 'sample-top-gun.webp', synthwave: 'sample-synthwave.webp' }, card: 'card-1980s.webp' },
    '1970s': { interior: { ...ROOM, image: 'inside-1970s.webp' } },
  },
  ...over,
});

describe('parseBoothTheme', () => {
  it('accepts a well-formed theme and resolves every image to a URL', () => {
    const t = parseBoothTheme(theme(), looksFor, url);
    expect(t.picker.image).toBe('https://cdn.example/booth-theme/eras.webp');
    expect(t.picker.tiles.map((x) => x.key)).toEqual(['1980s', '1970s']);
    expect(t.eras['1980s'].interior.image).toBe('https://cdn.example/booth-theme/inside-1980s.webp');
    expect(t.eras['1980s'].samples['top-gun']).toBe('https://cdn.example/booth-theme/sample-top-gun.webp');
    expect(t.eras['1980s'].card).toBe('https://cdn.example/booth-theme/card-1980s.webp');
    expect(t.eras['1970s'].board).toBeNull();
  });

  // Image names become URLs in every guest's browser.
  it('refuses image names that are paths or URLs', () => {
    for (const image of ['../secret.png', 'https://evil.example/x.png', 'a/b.webp', 'x.svg', '']) {
      const t = parseBoothTheme(theme({ eras: { '1980s': { interior: { ...ROOM, image } } } }), looksFor, url);
      expect(t).toBeNull();
    }
    const t = parseBoothTheme(theme({ eras: { '1980s': { interior: ROOM, samples: { 'top-gun': '../x.webp' } } } }), looksFor, url);
    expect(t.eras['1980s'].samples).toEqual({});
  });

  it('drops samples and painted tiles for looks the era does not offer', () => {
    const t = parseBoothTheme(theme({
      eras: {
        '1980s': {
          interior: ROOM,
          samples: { 'top-gun': 'a.webp', 'fifties-atomic': 'b.webp' },
          board: { image: 'board.webp', width: 941, height: 1672, tiles: [
            { key: 'top-gun', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
            { key: 'fifties-atomic', x: 0.5, y: 0.1, w: 0.2, h: 0.2 },
          ] },
        },
      },
    }), looksFor, url);
    expect(Object.keys(t.eras['1980s'].samples)).toEqual(['top-gun']);
    expect(t.eras['1980s'].board.tiles.map((x) => x.key)).toEqual(['top-gun']);
  });

  it('drops a painted picker tile for an era the theme has no booth for', () => {
    const t = parseBoothTheme(theme({ eras: { '1980s': { interior: ROOM } } }), looksFor, url);
    expect(t.picker.tiles.map((x) => x.key)).toEqual(['1980s']);
  });

  it('drops an era without a valid interior, and is no theme with none left', () => {
    const bad = { ...ROOM, window: { x: 0.5, y: 0.5, w: 0.7, h: 0.2 } };
    const t = parseBoothTheme(theme({ eras: { '1980s': { interior: ROOM }, '1970s': { interior: bad } } }), looksFor, url);
    expect(Object.keys(t.eras)).toEqual(['1980s']);
    expect(parseBoothTheme(theme({ eras: { '1970s': { interior: bad } } }), looksFor, url)).toBeNull();
  });

  it('refuses another version and non-objects', () => {
    expect(parseBoothTheme(theme({ version: 1 }), looksFor, url)).toBeNull();
    for (const raw of [null, 'theme', 42, []]) expect(parseBoothTheme(raw, looksFor, url)).toBeNull();
  });

  it('refuses absurd image sizes', () => {
    const t = parseBoothTheme(theme({ eras: { '1980s': { interior: { ...ROOM, width: 1e9 } } } }), looksFor, url);
    expect(t).toBeNull();
  });

  it('works without a picker or a board', () => {
    const { picker, ...rest } = theme();
    const t = parseBoothTheme(rest, looksFor, url);
    expect(t.picker).toBeNull();
    expect(t.eras['1980s'].board).toBeNull();
  });
});
