import { describe, it, expect } from 'vitest';
import { uploadSpec, prunePending, maxBytesFor } from '../lib/studio-uploads.js';
import { sanitiseSelection } from '../api/studio-routes.js';
import { chosenPanels } from '../lib/studio-finalize.js';

describe('uploadSpec', () => {
  it('accepts the right types and sizes per kind and refuses the rest', () => {
    expect(uploadSpec('logo', 'image/svg+xml', 1000)).toEqual({ ok: true, spec: { kind: 'logo', mime: 'image/svg+xml', bytes: 1000, ext: 'svg' } });
    expect(uploadSpec('speaker', 'image/jpeg', 5_000_000).ok).toBe(true);
    expect(uploadSpec('background', 'image/webp', 100).ok).toBe(true);
    expect(uploadSpec('speaker', 'image/svg+xml', 100).ok).toBe(false);
    expect(uploadSpec('logo', 'image/png', maxBytesFor('logo') + 1).ok).toBe(false);
    expect(uploadSpec('master', 'video/mp4', 100).ok).toBe(false);
    expect(uploadSpec('logo', 'image/png', 0).ok).toBe(false);
  });
});

describe('prunePending', () => {
  it('drops entries older than two hours and anything malformed', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const list = [
      { path: 'a', kind: 'logo', mime: 'image/png', bytes: 1, by: null, at: '2026-10-20T11:30:00Z' },
      { path: 'b', kind: 'logo', mime: 'image/png', bytes: 1, by: null, at: '2026-10-20T09:00:00Z' },
      { nope: true },
    ];
    expect(prunePending(list, now).map((p) => p.path)).toEqual(['a']);
    expect(prunePending('x' as never)).toEqual([]);
  });
});

describe('selection: head height and panel keys', () => {
  const analysis = { duration: 600, cuts: [{ key: 'cut-1' }], panels: [{ key: 'panel-1' }, { key: 'panel-2' }, { key: 'panel-3' }] };
  it('keeps y and only known panel keys, two at most, in order', () => {
    const s = sanitiseSelection({ y: 0.3, panel_keys: ['panel-3', 'nope', 'panel-1', 'panel-2'] }, analysis);
    expect(s.y).toBe(0.3);
    expect(s.panel_keys).toEqual(['panel-3', 'panel-1']);
    expect(sanitiseSelection({}, analysis).panel_keys).toBeNull();
    expect(sanitiseSelection({ y: '' }, analysis).y).toBeNull();
  });
  it('chosenPanels honours the keys, falls back to the first two, and hides all when panels is off', () => {
    expect(chosenPanels(analysis.panels, { panel_keys: ['panel-3', 'panel-1'] }).map((p) => p.key)).toEqual(['panel-3', 'panel-1']);
    expect(chosenPanels(analysis.panels, {}).map((p) => p.key)).toEqual(['panel-1', 'panel-2']);
    expect(chosenPanels(analysis.panels, { panel_keys: [] })).toEqual([]);
    expect(chosenPanels(analysis.panels, { panels: false, panel_keys: ['panel-1'] })).toEqual([]);
  });
});
