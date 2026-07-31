/**
 * Replication-slot alert thresholds and evaluation (§10.4). Pure — the
 * slot-monitor worker samples pg_replication_slots (via the SECURITY DEFINER
 * RPC), then calls evaluateSlotHealth() to decide what to alert on.
 */

export interface SlotThresholds {
  retainedWalBytes: number; // §10.4: > 10 GB default
  lagMinutes: number; // §10.4: > 30 min default
  inactiveMinutes: number; // §10.4: inactive > 15 min (business hours)
}

const GB = 1024 * 1024 * 1024;

export const DEFAULT_THRESHOLDS: SlotThresholds = {
  retainedWalBytes: 10 * GB,
  lagMinutes: 30,
  inactiveMinutes: 15,
};

export function thresholdsFromConfig(cfg: Record<string, unknown>): SlotThresholds {
  const num = (v: unknown, d: number): number => {
    const n = typeof v === 'string' ? Number(v) : (v as number);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    retainedWalBytes: num(cfg.retainedWalAlertGb, 10) * GB,
    lagMinutes: num(cfg.lagAlertMinutes, 30),
    inactiveMinutes: num(cfg.slotInactiveAlertMinutes, 15),
  };
}

/** One sampled row from pg_replication_slots (via warehouse_sync_slot_health). */
export interface SlotSample {
  slot_name: string;
  active: boolean;
  retained_bytes: number;
  flush_lag_bytes: number;
  /** Seconds since the slot was last active; null when currently active. */
  inactive_seconds: number | null;
  /** Estimated consumer lag in seconds if the RPC can derive it, else null. */
  lag_seconds: number | null;
}

export type AlertSeverity = 'warning' | 'critical';

export interface SlotAlert {
  slot_name: string;
  code: 'retained_wal' | 'replication_lag' | 'slot_inactive' | 'slot_missing';
  severity: AlertSeverity;
  message: string;
  value: number | null;
}

/**
 * Evaluate one slot against the thresholds. `businessHours` gates the
 * inactive-slot alert (§10.4: "inactive > 15 min during business hours"); out
 * of hours it downgrades to warning-only unless lag is extreme.
 */
export function evaluateSlot(s: SlotSample, t: SlotThresholds, businessHours: boolean): SlotAlert[] {
  const alerts: SlotAlert[] = [];

  if (s.retained_bytes > t.retainedWalBytes) {
    alerts.push({
      slot_name: s.slot_name,
      code: 'retained_wal',
      severity: 'critical',
      value: s.retained_bytes,
      message: `retained WAL ${(s.retained_bytes / GB).toFixed(2)} GB exceeds ${(t.retainedWalBytes / GB).toFixed(0)} GB — WAL-disk hazard (§10.4)`,
    });
  }

  const lagSec = s.lag_seconds;
  if (lagSec !== null && lagSec > t.lagMinutes * 60) {
    alerts.push({
      slot_name: s.slot_name,
      code: 'replication_lag',
      severity: businessHours || lagSec > 4 * 3600 ? 'critical' : 'warning',
      value: lagSec,
      message: `replication lag ${(lagSec / 60).toFixed(0)} min exceeds ${t.lagMinutes} min (§10.4)`,
    });
  }

  if (!s.active && s.inactive_seconds !== null && s.inactive_seconds > t.inactiveMinutes * 60) {
    alerts.push({
      slot_name: s.slot_name,
      code: 'slot_inactive',
      severity: businessHours ? 'critical' : 'warning',
      value: s.inactive_seconds,
      message: `slot inactive ${(s.inactive_seconds / 60).toFixed(0)} min — connector may be down (§10.4)`,
    });
  }

  return alerts;
}

/** UTC business-hours window used for alert gating (§12.4: 06:00–22:00 UTC). */
export function isBusinessHoursUtc(hourUtc: number): boolean {
  return hourUtc >= 6 && hourUtc < 22;
}
