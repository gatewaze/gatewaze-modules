/**
 * Shared bits for the property workspace tabs.
 */
import { authedFetch } from '../authed-fetch';

export const API = () => import.meta.env.VITE_API_URL ?? '';

export async function getJson<T>(path: string): Promise<T> {
  const r = await authedFetch(`${API()}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export type RangeKey = '24h' | '7d' | '30d' | '90d';
export const RANGES: Record<RangeKey, { label: string; hours: number; bucket: 'hour' | 'day' }> = {
  '24h': { label: '24 hours', hours: 24, bucket: 'hour' },
  '7d': { label: '7 days', hours: 7 * 24, bucket: 'day' },
  '30d': { label: '30 days', hours: 30 * 24, bucket: 'day' },
  '90d': { label: '90 days', hours: 90 * 24, bucket: 'day' },
};

export function rangeParams(rangeKey: RangeKey): URLSearchParams {
  const { hours } = RANGES[rangeKey];
  return new URLSearchParams({
    from: new Date(Date.now() - hours * 3600_000).toISOString(),
    to: new Date().toISOString(),
  });
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function countryLabel(code: string | null): string {
  if (!code || code === '(none)') return '—';
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase());
    const flag = code.length === 2
      ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
      : '';
    return `${flag} ${name ?? code}`.trim();
  } catch {
    return code;
  }
}

/** Radix-token panel classes shared by every tab. */
export const PANEL = 'rounded-xl border border-[var(--gray-6)] bg-[var(--gray-1)] p-4';
export const MUTED = 'text-[var(--gray-10)]';
export const STRONG = 'text-[var(--gray-12)]';
