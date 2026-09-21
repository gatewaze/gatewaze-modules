import { describe, it, expect } from 'vitest';
import { mergeSubsetOrder, mediaKind, guestName, isGuestUpload, formatDuration, formatFileSize } from '../organizer.js';

describe('mergeSubsetOrder', () => {
  it('reorders the subset inside the slots it already occupies', () => {
    // Filtered view shows b and d; the admin drags d in front of b.
    expect(mergeSubsetOrder(['a', 'b', 'c', 'd', 'e'], ['d', 'b'])).toEqual(['a', 'd', 'c', 'b', 'e']);
  });

  it('is the identity when the subset order is unchanged', () => {
    expect(mergeSubsetOrder(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('handles the unfiltered case as a plain reorder', () => {
    expect(mergeSubsetOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });
});

describe('media helpers', () => {
  it('classifies by mime type', () => {
    expect(mediaKind({ mime_type: 'image/heic' })).toBe('photo');
    expect(mediaKind({ mime_type: 'video/quicktime' })).toBe('video');
    expect(mediaKind({ mime_type: 'audio/mpeg' })).toBe('audio');
    expect(mediaKind({ mime_type: 'application/zip' })).toBe('other');
  });

  it('reads the guest name only for guest uploads', () => {
    expect(guestName({ metadata: { source: 'guest', guest_name: 'Aunt Jo' } })).toBe('Aunt Jo');
    expect(guestName({ metadata: { source: 'guest', guest_name: '' } })).toBeNull();
    expect(guestName({ metadata: { guest_name: 'Spoof' } })).toBeNull();
    expect(isGuestUpload({ metadata: { source: 'guest' } })).toBe(true);
    expect(isGuestUpload({ metadata: null })).toBe(false);
  });

  it('formats durations and sizes', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(0)).toBe('0 B');
  });
});
