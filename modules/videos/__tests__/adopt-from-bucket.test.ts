/**
 * The prefix rule for adopting objects from the bucket
 * (workers/adopt-from-bucket.ts). An adopted video is created public, so
 * the rule is what keeps editor uploads and Drive imports out of reach.
 */

import { describe, it, expect } from 'vitest';
import { safePrefix, DEFAULT_PREFIX } from '../workers/adopt-from-bucket.js';

describe('safePrefix', () => {
  it('accepts the import area and folders under it', () => {
    expect(safePrefix(undefined)).toBe(DEFAULT_PREFIX);
    expect(safePrefix('local-import/')).toBe('local-import/');
    expect(safePrefix('local-import/agntcon-eu/')).toBe('local-import/agntcon-eu/');
  });

  it('refuses anything outside the import area', () => {
    for (const bad of ['masters/', 'a/', 'agenda_entry/', 'local-import-private/', '/local-import/', '']) {
      expect(safePrefix(bad)).toBeNull();
    }
  });

  it('refuses traversal, missing trailing slash and doubled slashes', () => {
    expect(safePrefix('local-import/../x/')).toBeNull();
    expect(safePrefix('local-import')).toBeNull();
    expect(safePrefix('local-import//x/')).toBeNull();
  });
});
