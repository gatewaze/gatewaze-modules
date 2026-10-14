import { describe, it, expect } from 'vitest';
import {
  evaluateSlot,
  DEFAULT_THRESHOLDS,
  isBusinessHoursUtc,
  type SlotSample,
} from '../lib/thresholds';

const GB = 1024 * 1024 * 1024;

/** A healthy slot; each test overrides only what it is exercising. */
const healthy = (over: Partial<SlotSample> = {}): SlotSample => ({
  slot_name: 'snowflake_cdc',
  active: true,
  wal_status: 'reserved',
  retained_bytes: 1 * GB,
  flush_lag_bytes: 1024,
  inactive_seconds: null,
  lag_seconds: 10,
  ...over,
});

describe('evaluateSlot — slot invalidation (§10.4)', () => {
  it('raises nothing for a healthy reserved slot', () => {
    expect(evaluateSlot(healthy(), DEFAULT_THRESHOLDS, true)).toEqual([]);
  });

  it('raises a critical slot_invalidated when wal_status is lost', () => {
    const alerts = evaluateSlot(healthy({ wal_status: 'lost' }), DEFAULT_THRESHOLDS, true);
    const invalid = alerts.find((a) => a.code === 'slot_invalidated');
    expect(invalid).toBeDefined();
    expect(invalid?.severity).toBe('critical');
    expect(invalid?.message).toMatch(/cannot resume/i);
  });

  it('warns while still recoverable, when wal_status is unreserved', () => {
    const alerts = evaluateSlot(healthy({ wal_status: 'unreserved' }), DEFAULT_THRESHOLDS, true);
    const invalid = alerts.find((a) => a.code === 'slot_invalidated');
    expect(invalid).toBeDefined();
    expect(invalid?.severity).toBe('critical');
    expect(invalid?.message).toMatch(/restart the connector/i);
  });

  /**
   * Regression for the AAIF prod incident of 2026-09-02. Once a slot is lost its
   * restart_lsn is NULL, so retained_bytes reads as 0 and every size threshold
   * goes quiet at precisely the moment the hazard has already occurred. The
   * invalidation check must not depend on retained_bytes.
   */
  it('still alerts on a lost slot whose retained_bytes has collapsed to 0', () => {
    const alerts = evaluateSlot(
      healthy({ wal_status: 'lost', retained_bytes: 0, active: false, inactive_seconds: 60 }),
      DEFAULT_THRESHOLDS,
      true,
    );
    expect(alerts.some((a) => a.code === 'retained_wal')).toBe(false);
    expect(alerts.some((a) => a.code === 'slot_invalidated')).toBe(true);
  });

  it('treats a missing wal_status (pre-migration samples) as not invalidated', () => {
    for (const walStatus of [undefined, null]) {
      const alerts = evaluateSlot(
        healthy({ wal_status: walStatus as undefined | null }),
        DEFAULT_THRESHOLDS,
        true,
      );
      expect(alerts.some((a) => a.code === 'slot_invalidated')).toBe(false);
    }
  });

  it('is case-insensitive about wal_status', () => {
    const alerts = evaluateSlot(healthy({ wal_status: 'LOST' }), DEFAULT_THRESHOLDS, true);
    expect(alerts.some((a) => a.code === 'slot_invalidated')).toBe(true);
  });
});

describe('evaluateSlot — existing thresholds still hold', () => {
  it('raises retained_wal above the threshold', () => {
    const alerts = evaluateSlot(healthy({ retained_bytes: 11 * GB }), DEFAULT_THRESHOLDS, true);
    expect(alerts.some((a) => a.code === 'retained_wal' && a.severity === 'critical')).toBe(true);
  });

  it('raises replication_lag above the threshold', () => {
    const alerts = evaluateSlot(healthy({ lag_seconds: 31 * 60 }), DEFAULT_THRESHOLDS, true);
    expect(alerts.some((a) => a.code === 'replication_lag')).toBe(true);
  });

  it('raises slot_inactive only once past the inactive threshold', () => {
    const under = evaluateSlot(
      healthy({ active: false, inactive_seconds: 14 * 60 }),
      DEFAULT_THRESHOLDS,
      true,
    );
    expect(under.some((a) => a.code === 'slot_inactive')).toBe(false);

    const over = evaluateSlot(
      healthy({ active: false, inactive_seconds: 16 * 60 }),
      DEFAULT_THRESHOLDS,
      true,
    );
    expect(over.some((a) => a.code === 'slot_inactive')).toBe(true);
  });

  it('downgrades an inactive slot out of business hours', () => {
    const sample = healthy({ active: false, inactive_seconds: 16 * 60 });
    expect(evaluateSlot(sample, DEFAULT_THRESHOLDS, true).find((a) => a.code === 'slot_inactive')?.severity)
      .toBe('critical');
    expect(evaluateSlot(sample, DEFAULT_THRESHOLDS, false).find((a) => a.code === 'slot_inactive')?.severity)
      .toBe('warning');
  });
});

describe('isBusinessHoursUtc', () => {
  it('covers 06:00 to 22:00 UTC', () => {
    expect(isBusinessHoursUtc(5)).toBe(false);
    expect(isBusinessHoursUtc(6)).toBe(true);
    expect(isBusinessHoursUtc(21)).toBe(true);
    expect(isBusinessHoursUtc(22)).toBe(false);
  });
});
