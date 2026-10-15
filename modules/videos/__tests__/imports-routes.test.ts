/**
 * The input handling of the import triggers (api/imports-routes.ts).
 *
 * Both routes only enqueue, so what matters is that a pasted value becomes
 * a safe Drive id or nothing, and that a double-click does not queue twice.
 */

import { describe, it, expect } from 'vitest';
import { driveFolderId, dedupeJobId } from '../api/imports-routes.js';

describe('driveFolderId', () => {
  it('accepts a bare id', () => {
    expect(driveFolderId('1aBcD_eFgH-ijklmnop')).toBe('1aBcD_eFgH-ijklmnop');
  });

  it('extracts the id from a folder URL, with or without a query string', () => {
    expect(driveFolderId('https://drive.google.com/drive/folders/1aBcD_eFgH-ijklmnop?usp=sharing')).toBe('1aBcD_eFgH-ijklmnop');
    expect(driveFolderId('https://drive.google.com/drive/u/0/folders/1aBcD_eFgH-ijklmnop')).toBe('1aBcD_eFgH-ijklmnop');
  });

  it('refuses anything that is not an id', () => {
    expect(driveFolderId('')).toBeNull();
    expect(driveFolderId('short')).toBeNull();
    expect(driveFolderId("1aBcD' or 1=1")).toBeNull();
    expect(driveFolderId('https://drive.google.com/file/d/1aBcD_eFgH-ijklmnop/view')).toBeNull();
    expect(driveFolderId({ folder: 'x' })).toBeNull();
  });
});

describe('dedupeJobId', () => {
  it('is stable within a ten-minute bucket and changes across it', () => {
    const t = 1_700_000_000_000;
    expect(dedupeJobId('videos-drive', 'abc', t)).toBe(dedupeJobId('videos-drive', 'abc', t + 60_000));
    expect(dedupeJobId('videos-drive', 'abc', t)).not.toBe(dedupeJobId('videos-drive', 'abc', t + 600_000));
    expect(dedupeJobId('videos-drive', 'abc', t)).not.toBe(dedupeJobId('videos-yt', 'abc', t));
  });
});
