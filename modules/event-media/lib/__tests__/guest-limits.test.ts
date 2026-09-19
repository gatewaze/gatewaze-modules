// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import {
  classifyMime,
  cleanGuestName,
  generateShortCode,
  paramAsShortCode,
  sanitiseGuestFilename,
  buildGuestStoragePath,
  validateMintFile,
} from '../guest-limits.js';

const LINK = { allow_video: true, max_photo_bytes: 50 * 1024 * 1024, max_video_bytes: 2 * 1024 * 1024 * 1024 };

describe('classifyMime', () => {
  it('accepts allowlisted photo + video mimes', () => {
    expect(classifyMime('image/jpeg', false)).toBe('photo');
    expect(classifyMime('image/heic', false)).toBe('photo');
    expect(classifyMime('video/mp4', true)).toBe('video');
    expect(classifyMime('video/quicktime', true)).toBe('video');
  });
  it('rejects video when videos are disabled', () => {
    expect(classifyMime('video/mp4', false)).toBeNull();
  });
  it('rejects everything off the allowlist', () => {
    expect(classifyMime('application/zip', true)).toBeNull();
    expect(classifyMime('image/svg+xml', true)).toBeNull(); // scriptable — deliberately excluded
    expect(classifyMime('', true)).toBeNull();
  });
});

describe('cleanGuestName', () => {
  it('trims, strips control chars, clips to 80', () => {
    expect(cleanGuestName('  Auntie Carol  ')).toBe('Auntie Carol');
    expect(cleanGuestName('Bob\x00\x1fSmith')).toBe('BobSmith');
    expect(cleanGuestName('x'.repeat(200))).toHaveLength(80);
  });
  it('returns null for unusable input', () => {
    expect(cleanGuestName('')).toBeNull();
    expect(cleanGuestName('   ')).toBeNull();
    expect(cleanGuestName(42)).toBeNull();
    expect(cleanGuestName(null)).toBeNull();
  });
});

describe('short codes', () => {
  it('generates 10 lowercase base36 chars', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateShortCode()).toMatch(/^[a-z0-9]{10}$/);
    }
  });
  it('paramAsShortCode accepts 6-16 base36 and rejects the rest', () => {
    expect(paramAsShortCode('abc123')).toBe('abc123');
    expect(paramAsShortCode('abcdef1234')).toBe('abcdef1234');
    expect(paramAsShortCode('ABC123')).toBeNull();
    expect(paramAsShortCode('abc-123')).toBeNull();
    expect(paramAsShortCode('abc')).toBeNull();
    expect(paramAsShortCode('a'.repeat(17))).toBeNull();
    expect(paramAsShortCode(undefined)).toBeNull();
  });
});

describe('filenames + storage paths', () => {
  it('slugifies and defuses traversal (host-media transform parity)', () => {
    expect(sanitiseGuestFilename('The Wedding Pic.PNG')).toBe('the-wedding-pic.png');
    expect(sanitiseGuestFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitiseGuestFilename('\x00weird')).toBe('weird');
    expect(sanitiseGuestFilename('')).toBe('file');
  });
  it('builds event/<eventId>/<mediaId>/<file> paths', () => {
    expect(buildGuestStoragePath('ev1', 'm1', 'IMG 1.jpg')).toBe('event/ev1/m1/img-1.jpg');
  });
});

describe('validateMintFile', () => {
  it('accepts a valid photo', () => {
    const v = validateMintFile({ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 1000, captured: true }, LINK);
    expect(v.ok).toBe(true);
    expect(v.kind).toBe('photo');
    expect(v.file.captured).toBe(true);
  });
  it('flags video_not_allowed when the link disables video', () => {
    const v = validateMintFile({ filename: 'a.mp4', mime_type: 'video/mp4', bytes: 1000 }, { ...LINK, allow_video: false });
    expect(v.ok).toBe(false);
    expect(v.error).toBe('video_not_allowed');
  });
  it('enforces the per-kind size caps', () => {
    const photo = validateMintFile({ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: LINK.max_photo_bytes + 1 }, LINK);
    expect(photo.ok).toBe(false);
    expect(photo.error).toBe('file_too_large');
    const video = validateMintFile({ filename: 'a.mp4', mime_type: 'video/mp4', bytes: LINK.max_video_bytes + 1 }, LINK);
    expect(video.ok).toBe(false);
    expect(video.error).toBe('file_too_large');
  });
  it('rejects non-integer and missing byte counts', () => {
    expect(validateMintFile({ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: -5 }, LINK).ok).toBe(false);
    expect(validateMintFile({ filename: 'a.jpg', mime_type: 'image/jpeg', bytes: 1.5 }, LINK).ok).toBe(false);
    expect(validateMintFile({ filename: 'a.jpg', mime_type: 'image/jpeg' }, LINK).ok).toBe(false);
  });
  it('rejects garbage input shapes', () => {
    expect(validateMintFile(null, LINK).ok).toBe(false);
    expect(validateMintFile('a.jpg', LINK).ok).toBe(false);
    expect(validateMintFile({}, LINK).ok).toBe(false);
  });
});
