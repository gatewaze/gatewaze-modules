/**
 * Placement-report parsing.
 *
 * Deliberately free of I/O and of any client library, so the normalisation
 * rules can be tested on their own. GlockApps' response keys vary between
 * report styles, so each field is read from a small set of plausible names
 * rather than assuming one shape; a payload we cannot recognise has to come
 * back empty rather than throw, because this feeds a panel on a page whose
 * primary job is unrelated.
 */

export interface ProviderPlacement {
  provider: string;
  inbox: number;
  tabs: number;
  spam: number;
  missing: number;
}

export interface PlacementResult {
  complete: boolean;
  providers: ProviderPlacement[];
  raw: unknown;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

export function normalisePlacement(payload: any): PlacementResult {
  const rows: ProviderPlacement[] = [];
  const source =
    payload?.providers ?? payload?.results ?? payload?.report?.providers ?? payload?.data ?? [];

  if (Array.isArray(source)) {
    for (const row of source) {
      const provider = String(row?.provider ?? row?.name ?? row?.isp ?? '')
        .toLowerCase()
        .trim();
      // A row with no identifiable provider cannot be keyed or displayed.
      if (!provider) continue;
      rows.push({
        provider,
        inbox: toCount(row?.inbox ?? row?.inbox_count),
        tabs: toCount(row?.tabs ?? row?.promotions ?? row?.tab_count),
        spam: toCount(row?.spam ?? row?.spam_count),
        missing: toCount(row?.missing ?? row?.not_received),
      });
    }
  }

  if (rows.length > 0) {
    // A rolled-up row so the panel can lead with a single headline number.
    const overall = rows.reduce(
      (acc, row) => ({
        provider: 'overall',
        inbox: acc.inbox + row.inbox,
        tabs: acc.tabs + row.tabs,
        spam: acc.spam + row.spam,
        missing: acc.missing + row.missing,
      }),
      { provider: 'overall', inbox: 0, tabs: 0, spam: 0, missing: 0 },
    );
    rows.unshift(overall);
  }

  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase();
  // An explicit status wins. Otherwise "has rows and nothing outstanding" is
  // the best available signal, and being wrong here only costs another poll.
  const complete =
    status === 'complete' || status === 'completed' || status === 'finished'
      ? true
      : rows.length > 0 && toCount(payload?.pending) === 0 && status === '';

  return { complete, providers: rows, raw: payload };
}
