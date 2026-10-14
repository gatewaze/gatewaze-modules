/**
 * Pure helpers for the admin page: shaping per-send stats into chart series and
 * table cells. Kept apart from the page so they can be tested without React.
 */

export const CHART_PROVIDERS = ['google', 'microsoft', 'yahoo', 'other'] as const;
export type ChartProvider = (typeof CHART_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  yahoo: 'Yahoo',
  apple: 'Apple',
  other: 'Other',
  unknown: 'Not looked up yet',
};

/** Points with fewer delivered messages than this are too noisy to plot. */
export const MIN_PLOT_DELIVERED = 200;

export interface SendRow {
  send_kind: string;
  send_id: string;
  sending_domain: string | null;
  send_label: string | null;
  send_started_at: string;
}

export interface StatRow {
  send_kind: string;
  send_id: string;
  provider: string;
  delivered: number;
  opened: number;
}

export interface Cell {
  delivered: number;
  opened: number;
  rate: number | null;
}

export const sendKey = (s: { send_kind: string; send_id: string }) => `${s.send_kind}:${s.send_id}`;

/** Per send, per provider counts. Providers outside the chart set fold into "other". */
export function cellsBySend(stats: ReadonlyArray<StatRow>): Map<string, Record<ChartProvider, Cell>> {
  const out = new Map<string, Record<ChartProvider, Cell>>();
  for (const s of stats) {
    if (s.provider === 'unknown' || s.provider === 'apple') continue;
    const p: ChartProvider = (CHART_PROVIDERS as readonly string[]).includes(s.provider) ? (s.provider as ChartProvider) : 'other';
    const key = sendKey(s);
    let row = out.get(key);
    if (!row) {
      row = { google: empty(), microsoft: empty(), yahoo: empty(), other: empty() };
      out.set(key, row);
    }
    row[p].delivered += s.delivered;
    row[p].opened += s.opened;
  }
  for (const row of out.values()) {
    for (const p of CHART_PROVIDERS) row[p].rate = row[p].delivered > 0 ? row[p].opened / row[p].delivered : null;
  }
  return out;
}

function empty(): Cell {
  return { delivered: 0, opened: 0, rate: null };
}

/** Sending domains, most recently used first. */
export function domainsByRecency(sends: ReadonlyArray<SendRow>): string[] {
  const latest = new Map<string, number>();
  for (const s of sends) {
    const d = s.sending_domain ?? 'unknown';
    const t = Date.parse(s.send_started_at);
    if (!latest.has(d) || t > latest.get(d)!) latest.set(d, t);
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

export function formatRate(rate: number | null): string {
  return rate == null ? 'n/a' : `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
}
