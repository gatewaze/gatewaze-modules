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

import { uploaderKey } from '../organizer.js';

describe('uploaderKey', () => {
  const row = (metadata: Record<string, unknown>) => ({ metadata });

  it('groups by the invitation guest, not the name they typed', () => {
    const a = row({ source: 'guest', member_id: 'm-1', guest_name: 'Dan Baker' });
    const b = row({ source: 'guest', member_id: 'm-1', guest_name: 'dan' });
    expect(uploaderKey(a)).toBe(uploaderKey(b));
    // Two guests who share a name are still two people.
    const c = row({ source: 'guest', member_id: 'm-2', guest_name: 'Dan Baker' });
    expect(uploaderKey(c)).not.toBe(uploaderKey(a));
  });

  it('falls back to the name, however it was spelled', () => {
    const a = row({ source: 'guest', guest_name: 'Auntie Carol' });
    const b = row({ source: 'guest', guest_name: '  auntie carol ' });
    expect(uploaderKey(a)).toBe(uploaderKey(b));
    expect(uploaderKey(a)).toBe('name:auntie carol');
  });

  it('has nobody to name for an organiser upload or a nameless guest', () => {
    expect(uploaderKey(row({ source: 'admin', guest_name: 'Dan' }))).toBeNull();
    expect(uploaderKey(row({ source: 'guest' }))).toBeNull();
    expect(uploaderKey(row({ source: 'guest', guest_name: '   ' }))).toBeNull();
    expect(uploaderKey({ metadata: null as unknown as Record<string, unknown> })).toBeNull();
  });
});
