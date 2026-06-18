/** Pure formatting / derivation helpers for the geo-engagement UI (testable). */

import type { LocalTimeRow, OptionGeoRow } from './geo-types.js';

export const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format a 0..1 rate as a percentage string, or '—' when null. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Linear interpolate a sequential blue→red intensity colour for a normalised
 * value in [0,1]. Returns an `rgb()` string. 0 → cool, 1 → hot. Used for both
 * map bubbles and heatmap cells so the visual language is consistent.
 */
export function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  // cool (#dbeafe, light blue) → hot (#b91c1c, deep red) through amber
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [219, 234, 254]],
    [0.5, [251, 191, 36]],
    [1.0, [185, 28, 28]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i][0] && clamped <= stops[i + 1][0]) {
      lo = stops[i]; hi = stops[i + 1]; break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (clamped - lo[0]) / span;
  const c = [0, 1, 2].map((k) => Math.round(lo[1][k] + (hi[1][k] - lo[1][k]) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Max of a numeric field across rows (for normalising bubble/heat scales). */
export function maxOf<T>(rows: T[], pick: (r: T) => number | null | undefined): number {
  let m = 0;
  for (const r of rows) {
    const v = pick(r);
    if (typeof v === 'number' && v > m) m = v;
  }
  return m;
}

/**
 * Best local hour-of-day from R2 rows, using the tz-size-normalised `rate`
 * (falls back to event_count when rate is absent) so a big region doesn't bias
 * the answer (spec §5/R2). Aggregates across days. Returns null if no data.
 */
export function bestLocalHour(rows: LocalTimeRow[]): { hour: number; score: number } | null {
  if (!rows.length) return null;
  const byHour = new Map<number, number>();
  for (const r of rows) {
    const score = r.rate ?? r.event_count;
    byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + score);
  }
  let best: { hour: number; score: number } | null = null;
  for (const [hour, score] of byHour) {
    if (!best || score > best.score) best = { hour, score };
  }
  return best;
}

/** Human-friendly 12h label for an hour-of-day integer. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/**
 * Resolve a poll option's display label. The RPC already derives this from the
 * block content, but if it falls back to a generic "Option N" the caller may
 * supply a block-level label map (spec §8.2 getTrackedLinkLabels) keyed by the
 * option's position. `rowLabel` wins unless it is empty/generic.
 */
export function resolveOptionLabel(
  rowLabel: string | null | undefined,
  linkIndex: number | null | undefined,
  blockLabels?: Record<number, string>,
): string {
  const generic = !rowLabel || /^option\s+\d+$/i.test(rowLabel);
  if (!generic) return rowLabel as string;
  if (blockLabels && linkIndex != null && blockLabels[linkIndex]) return blockLabels[linkIndex];
  return rowLabel || `Option ${(linkIndex ?? 0) + 1}`;
}

/**
 * Pivot R4 option rows into per-region option shares for the diverging bars,
 * and rank regions by how far their split diverges from the global split
 * ("where opinion splits hardest", spec §5/R4).
 */
export interface RegionSplit {
  region_code: string;
  region_name: string;
  total: number;
  options: Array<{ label: string; clicks: number; share: number }>;
  divergence: number; // L1 distance from the global option distribution
}

export function buildRegionSplits(rows: OptionGeoRow[]): RegionSplit[] {
  if (!rows.length) return [];
  // global distribution by option label
  const globalByOpt = new Map<string, number>();
  let globalTotal = 0;
  for (const r of rows) {
    globalByOpt.set(r.option_label, (globalByOpt.get(r.option_label) ?? 0) + r.clicks);
    globalTotal += r.clicks;
  }
  const globalShare = new Map<string, number>();
  for (const [k, v] of globalByOpt) globalShare.set(k, globalTotal ? v / globalTotal : 0);

  const byRegion = new Map<string, OptionGeoRow[]>();
  for (const r of rows) {
    const arr = byRegion.get(r.region_code) ?? [];
    arr.push(r);
    byRegion.set(r.region_code, arr);
  }

  const out: RegionSplit[] = [];
  for (const [code, rs] of byRegion) {
    const total = rs.reduce((a, b) => a + b.clicks, 0);
    const options = rs
      .map((r) => ({ label: r.option_label, clicks: r.clicks, share: total ? r.clicks / total : 0 }))
      .sort((a, b) => b.clicks - a.clicks);
    let divergence = 0;
    for (const o of options) divergence += Math.abs(o.share - (globalShare.get(o.label) ?? 0));
    out.push({ region_code: code, region_name: rs[0].region_name, total, options, divergence });
  }
  // most-divergent regions first
  return out.sort((a, b) => b.divergence - a.divergence);
}
