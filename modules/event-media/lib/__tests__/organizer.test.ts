import { describe, it, expect } from 'vitest';
import { mergeSubsetOrder, mediaKind, guestName, isGuestUpload, formatDuration, formatFileSize, takenKey, hasTakenAt, compareTaken } from '../organizer.js';

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

describe('sorting by when a photograph was taken', () => {
  const row = (metadata: Record<string, unknown> | null, created_at: string) =>
    ({ mime_type: 'image/jpeg', metadata, created_at });

  it('uses the EXIF capture time when there is one', () => {
    expect(takenKey(row({ taken_at: '2026-09-25T09:14:03' }, '2026-09-27T08:00:00Z')))
      .toBe('2026-09-25T09:14:03');
    // Written with a space rather than a T, as some cameras do.
    expect(takenKey(row({ taken_at: '2026-09-24 21:05:00' }, '2026-09-27T08:00:00Z')))
      .toBe('2026-09-24T21:05:00');
    expect(hasTakenAt(row({ taken_at: '2026-09-25T09:14:03' }, 'x'))).toBe(true);
  });

  it('falls back to the upload time, so those photos still sort sensibly', () => {
    // No EXIF at all, a stripped one, and nonsense: all fall back.
    for (const meta of [null, {}, { taken_at: 'yesterday' }, { taken_at: 42 }]) {
      const key = takenKey(row(meta, '2026-09-26T12:30:45Z'));
      expect(key).toMatch(/^2026-09-2[56]T\d{2}:\d{2}:45$/);
      expect(hasTakenAt(row(meta, 'x'))).toBe(false);
    }
    // Two photos with no capture time keep their upload order, whatever
    // zone the organiser's browser is in.
    const older = takenKey(row(null, '2026-09-26T12:00:00Z'));
    const newer = takenKey(row(null, '2026-09-26T13:00:00Z'));
    expect(older.localeCompare(newer)).toBeLessThan(0);
  });

  it('orders a photograph taken early but uploaded late by when it was taken', () => {
    // The Sunday camera-roll dump: taken in the morning, uploaded days
    // later. It belongs beside the morning's photographs.
    const morning = row({ taken_at: '2026-09-25T08:30:00' }, '2026-09-27T09:00:00Z');
    const evening = row({ taken_at: '2026-09-25T20:00:00' }, '2026-09-25T20:05:00Z');
    expect(takenKey(morning).localeCompare(takenKey(evening))).toBeLessThan(0);
  });

  it('says nothing rather than guessing when there is no date at all', () => {
    expect(takenKey(row(null, 'not a date'))).toBe('');
  });
});

describe('undated photographs lead the list', () => {
  const row = (metadata: Record<string, unknown> | null, created_at: string) =>
    ({ mime_type: 'image/jpeg', metadata, created_at });

  it('puts a photograph with no capture time above every dated one', () => {
    const undated = row(null, '2026-09-20T09:00:00Z');       // uploaded first
    const dated = row({ taken_at: '2026-09-25T20:00:00' }, '2026-09-25T20:05:00Z');
    expect(compareTaken(undated, dated)).toBeLessThan(0);
    expect(compareTaken(dated, undated)).toBeGreaterThan(0);
  });

  it('orders the undated ones among themselves by upload, newest first', () => {
    const older = row(null, '2026-09-26T12:00:00Z');
    const newer = row(null, '2026-09-26T13:00:00Z');
    expect(compareTaken(newer, older)).toBeLessThan(0);
  });

  it('orders the dated ones by capture time, newest first', () => {
    const morning = row({ taken_at: '2026-09-25T08:30:00' }, '2026-09-27T09:00:00Z');
    const evening = row({ taken_at: '2026-09-25T20:00:00' }, '2026-09-25T20:05:00Z');
    expect(compareTaken(evening, morning)).toBeLessThan(0);
  });

  it('sorts a whole list the way the Media tab does', () => {
    const list = [
      row({ taken_at: '2026-09-25T08:30:00' }, '2026-09-27T09:00:00Z'),
      row(null, '2026-09-24T10:00:00Z'),
      row({ taken_at: '2026-09-25T20:00:00' }, '2026-09-25T20:05:00Z'),
      row(null, '2026-09-26T10:00:00Z'),
    ];
    const keys = [...list].sort(compareTaken).map((r) => r.metadata?.taken_at ?? `up:${r.created_at}`);
    expect(keys).toEqual([
      'up:2026-09-26T10:00:00Z',
      'up:2026-09-24T10:00:00Z',
      '2026-09-25T20:00:00',
      '2026-09-25T08:30:00',
    ]);
    // Reversed, the undated ones fall to the bottom.
    const asc = [...list].sort((a, b) => -compareTaken(a, b)).map((r) => r.metadata?.taken_at ?? 'undated');
    expect(asc[asc.length - 1]).toBe('undated');
  });
});
