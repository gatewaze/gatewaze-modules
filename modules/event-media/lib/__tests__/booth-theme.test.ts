// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { parseBoothTheme } from '../booth-theme.js';

const EFFECTS = new Set(['decade-1980s', 'decade-1990s']);
const url = (f) => `https://cdn.example/booth-theme/${f}`;

const ROOM = {
  image: 'inside-1990s.webp', width: 941, height: 1672,
  window: { x: 0.16, y: 0.18, w: 0.67, h: 0.53 },
  coin: { x: 0.3, y: 0.76, w: 0.1, h: 0.11 },
  panel: { x: 0.14, y: 0.73, w: 0.72, h: 0.18 },
};

const theme = (over = {}) => ({
  version: 1,
  default_interior: '1990s',
  interiors: { '1990s': ROOM, '1980s': { ...ROOM, image: 'inside-1980s.webp' } },
  outside: {
    image: 'outside.webp', width: 941, height: 1672, focus_x: 0.85,
    tiles: [
      { effect: 'decade-1980s', interior: '1980s', x: 0.29, y: 0.19, w: 0.29, h: 0.19 },
      { effect: 'decade-1990s', x: 0.29, y: 0.6, w: 0.29, h: 0.19 },
    ],
  },
  ...over,
});

describe('parseBoothTheme', () => {
  it('accepts a well-formed theme and resolves every image to a URL', () => {
    const t = parseBoothTheme(theme(), EFFECTS, url);
    expect(t.outside.image).toBe('https://cdn.example/booth-theme/outside.webp');
    expect(t.interiors['1980s'].image).toBe('https://cdn.example/booth-theme/inside-1980s.webp');
    expect(t.outside.tiles).toHaveLength(2);
    expect(t.outside.tiles[0].interior).toBe('1980s');
    expect(t.default_interior).toBe('1990s');
  });

  // Image names become URLs in every guest's browser.
  it('refuses image names that are paths or URLs', () => {
    for (const image of ['../secret.png', 'https://evil.example/x.png', 'a/b.webp', 'x.svg', '']) {
      expect(parseBoothTheme(theme({ outside: { ...theme().outside, image } }), EFFECTS, url)).toBeNull();
    }
  });

  it('drops a tile naming a look this link does not offer', () => {
    const t = parseBoothTheme(theme(), new Set(['decade-1990s']), url);
    expect(t.outside.tiles.map((x) => x.effect)).toEqual(['decade-1990s']);
  });

  it('is no theme at all when no tile survives', () => {
    expect(parseBoothTheme(theme(), new Set(), url)).toBeNull();
  });

  it('drops an interior with a missing or out-of-range rect', () => {
    const t = parseBoothTheme(theme({
      interiors: { '1990s': ROOM, bad: { ...ROOM, window: { x: 0.5, y: 0.5, w: 0.7, h: 0.2 } } },
    }), EFFECTS, url);
    expect(Object.keys(t.interiors)).toEqual(['1990s']);
  });

  it('forgets a tile interior that does not exist rather than keeping a dangling name', () => {
    const t = parseBoothTheme(theme({
      interiors: { '1990s': ROOM },
    }), EFFECTS, url);
    expect(t.outside.tiles[0].interior).toBeUndefined();
  });

  it('requires the default interior to exist', () => {
    expect(parseBoothTheme(theme({ default_interior: 'nope' }), EFFECTS, url)).toBeNull();
  });

  it('refuses an unknown version and non-objects', () => {
    expect(parseBoothTheme(theme({ version: 2 }), EFFECTS, url)).toBeNull();
    for (const raw of [null, 'theme', 42, []]) expect(parseBoothTheme(raw, EFFECTS, url)).toBeNull();
  });

  it('refuses absurd image sizes', () => {
    expect(parseBoothTheme(theme({ outside: { ...theme().outside, width: 1e9 } }), EFFECTS, url)).toBeNull();
  });

  it('defaults focus to the centre', () => {
    const { focus_x, ...rest } = theme().outside;
    const t = parseBoothTheme(theme({ outside: rest }), EFFECTS, url);
    expect(t.outside.focus_x).toBe(0.5);
  });
});
