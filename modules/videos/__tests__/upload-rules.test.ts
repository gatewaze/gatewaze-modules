/**
 * What an editor may upload (lib/upload-rules.ts).
 *
 * The filename sanitiser is the one with teeth: the storage key is built from
 * it, so a crafted filename must not escape its prefix into another path.
 */

import { describe, it, expect } from 'vitest';
import {
  rejectUpload,
  sanitiseFilename,
  buildStoragePath,
  bucketFor,
  allowedMimes,
  MAX_BYTES,
  VIDEO_MIMES,
} from '../lib/upload-rules.js';

const ok = { kind: 'master', mimeType: 'video/mp4', bytes: 1024, filename: 'talk.mp4' };

describe('rejectUpload', () => {
  it('accepts a plain mp4 master', () => {
    expect(rejectUpload(ok)).toBeNull();
  });

  it('refuses an unknown kind', () => {
    expect(rejectUpload({ ...ok, kind: 'masterpiece' })).toBe('unknown_kind');
    expect(rejectUpload({ ...ok, kind: '' })).toBe('unknown_kind');
  });

  it('refuses a mime type outside the allowlist', () => {
    expect(rejectUpload({ ...ok, mimeType: 'video/x-msvideo' })).toBe('mime_not_allowed');
    expect(rejectUpload({ ...ok, mimeType: 'application/zip' })).toBe('mime_not_allowed');
    // An allowlist, not a prefix check: host-media's startsWith('video/')
    // would have let this through.
    expect(rejectUpload({ ...ok, mimeType: 'video/anything-at-all' })).toBe('mime_not_allowed');
  });

  it('is case-insensitive about the mime type', () => {
    expect(rejectUpload({ ...ok, mimeType: 'VIDEO/MP4' })).toBeNull();
  });

  it('requires a size, because a cap cannot be checked without one', () => {
    expect(rejectUpload({ ...ok, bytes: 0 })).toBe('no_size');
    expect(rejectUpload({ ...ok, bytes: Number.NaN })).toBe('no_size');
    expect(rejectUpload({ ...ok, bytes: -1 })).toBe('no_size');
  });

  it('enforces a different cap per kind', () => {
    expect(rejectUpload({ ...ok, bytes: MAX_BYTES.master })).toBeNull();
    expect(rejectUpload({ ...ok, bytes: MAX_BYTES.master + 1 })).toBe('too_large');
    // A master-sized file uploaded as a short is caught, which is the point
    // of the short cap being much smaller.
    expect(rejectUpload({ ...ok, kind: 'short', bytes: MAX_BYTES.short + 1 })).toBe('too_large');
  });

  it('refuses an empty or absurd filename', () => {
    expect(rejectUpload({ ...ok, filename: '' })).toBe('bad_filename');
    expect(rejectUpload({ ...ok, filename: '   ' })).toBe('bad_filename');
    expect(rejectUpload({ ...ok, filename: 'a'.repeat(256) })).toBe('bad_filename');
  });

  it('accepts a caption and a thumbnail with their own types', () => {
    expect(rejectUpload({ kind: 'caption', mimeType: 'text/vtt', bytes: 2048, filename: 't.vtt' })).toBeNull();
    expect(rejectUpload({ kind: 'thumbnail', mimeType: 'image/png', bytes: 2048, filename: 't.png' })).toBeNull();
    // ...and refuses a video as a caption.
    expect(rejectUpload({ kind: 'caption', mimeType: 'video/mp4', bytes: 2048, filename: 't.mp4' }))
      .toBe('mime_not_allowed');
  });
});

describe('sanitiseFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitiseFilename('my-talk_01.mp4')).toBe('my-talk_01.mp4');
  });

  it('refuses to let a path escape its prefix', () => {
    // This is the one that matters: the storage key is built from the result.
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('../../../other-bucket/x.mp4')).toBe('x.mp4');
    expect(sanitiseFilename('C:\\Windows\\System32\\x.mp4')).toBe('x.mp4');
    expect(sanitiseFilename('a/b/c/d.mp4')).toBe('d.mp4');
  });

  it('strips a leading dot so nothing becomes a hidden file', () => {
    expect(sanitiseFilename('.hidden.mp4')).toBe('hidden.mp4');
    expect(sanitiseFilename('...mp4')).toBe('mp4');
  });

  it('removes control characters', () => {
    expect(sanitiseFilename('ta\u0000lk\u001f.mp4')).toBe('talk.mp4');
  });

  it('collapses anything exotic to hyphens without doubling them', () => {
    expect(sanitiseFilename('my   talk (final)!!.mp4')).toBe('my-talk-final-.mp4');
  });

  it('never returns an empty string', () => {
    expect(sanitiseFilename('')).toBe('upload');
    expect(sanitiseFilename('///')).toBe('upload');
    expect(sanitiseFilename('!!!')).toBe('upload');
  });

  it('caps the length', () => {
    expect(sanitiseFilename(`${'a'.repeat(400)}.mp4`).length).toBeLessThanOrEqual(180);
  });
});

describe('buildStoragePath', () => {
  const args = {
    subjectType: 'agenda_entry',
    subjectId: '89e5d6c8-968d-40de-94ef-71c5869be45f',
    assetId: 'aaaaaaaa-0000-4000-8000-000000000001',
    filename: 'talk.mp4',
  };

  it('puts the asset id in the path so two uploads never collide', () => {
    expect(buildStoragePath(args)).toBe(
      'agenda_entry/89e5d6c8-968d-40de-94ef-71c5869be45f/aaaaaaaa-0000-4000-8000-000000000001/talk.mp4',
    );
  });

  it('cannot be escaped through the filename', () => {
    const p = buildStoragePath({ ...args, filename: '../../../x.mp4' });
    expect(p.split('/')).toHaveLength(4);
    expect(p).not.toContain('..');
  });

  it('cannot be escaped through the subject type', () => {
    const p = buildStoragePath({ ...args, subjectType: '../../evil' });
    expect(p.startsWith('evil/')).toBe(true);
    expect(p).not.toContain('..');
  });
});

describe('bucketFor', () => {
  it('keeps masters and shorts out of the world-readable bucket', () => {
    // The `media` bucket's RLS SELECT is USING (bucket_id = 'media') with no
    // role and no path predicate, so anything in it is public.
    expect(bucketFor('master')).toBe('video-masters');
    expect(bucketFor('short')).toBe('video-masters');
    expect(bucketFor('caption')).toBe('video-masters');
  });

  it('allows a thumbnail to be public, which is the only one that should be', () => {
    expect(bucketFor('thumbnail')).toBe('media');
  });
});

describe('allowedMimes', () => {
  it('gives video kinds the video allowlist', () => {
    expect(allowedMimes('master')).toEqual(VIDEO_MIMES);
    expect(allowedMimes('short')).toEqual(VIDEO_MIMES);
  });

  it('does not let an image masquerade as a video', () => {
    expect(allowedMimes('thumbnail')).not.toContain('video/mp4');
  });
});
