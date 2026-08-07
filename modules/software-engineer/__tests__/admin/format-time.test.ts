/**
 * Time formatting pure-logic tests. Fits the module's node vitest config
 * (`environment: 'node'`, no jsdom) — these functions never touch React.
 */
import { describe, it, expect } from 'vitest';
import { formatAbsolute, formatRelative } from '../../admin/lib/format-time';

describe('formatAbsolute', () => {
  it('returns null for missing input', () => {
    expect(formatAbsolute(null)).toBeNull();
    expect(formatAbsolute(undefined)).toBeNull();
  });
  it('returns null for an unparseable date', () => {
    expect(formatAbsolute('not-a-date')).toBeNull();
  });
  it('formats a valid ISO timestamp', () => {
    expect(formatAbsolute('2026-08-07T12:00:00Z')).toBe(new Date('2026-08-07T12:00:00Z').toLocaleString());
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');

  it('returns null for missing or unparseable input', () => {
    expect(formatRelative(null, now)).toBeNull();
    expect(formatRelative(undefined, now)).toBeNull();
    expect(formatRelative('not-a-date', now)).toBeNull();
  });
  it('reads as "just now" for a few seconds ago', () => {
    expect(formatRelative(new Date(now - 2000).toISOString(), now)).toBe('just now');
  });
  it('crosses the minute boundary', () => {
    expect(formatRelative(new Date(now - 45_000).toISOString(), now)).toBe('45s ago');
    expect(formatRelative(new Date(now - 90_000).toISOString(), now)).toBe('2m ago');
  });
  it('crosses the hour boundary', () => {
    expect(formatRelative(new Date(now - 45 * 60_000).toISOString(), now)).toBe('45m ago');
    expect(formatRelative(new Date(now - 90 * 60_000).toISOString(), now)).toBe('2h ago');
  });
  it('crosses the day boundary', () => {
    expect(formatRelative(new Date(now - 20 * 3_600_000).toISOString(), now)).toBe('20h ago');
    expect(formatRelative(new Date(now - 30 * 3_600_000).toISOString(), now)).toBe('1d ago');
  });
  it('falls back to the absolute date past 30 days', () => {
    const iso = new Date(now - 45 * 86_400_000).toISOString();
    expect(formatRelative(iso, now)).toBe(formatAbsolute(iso));
  });
});
