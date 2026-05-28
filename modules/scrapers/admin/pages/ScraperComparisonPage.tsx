import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { ScraperService, type VariantComparisonPair } from '@/utils/scraperService';

const WINDOW_OPTIONS = [1, 7, 14, 30] as const;
type Window = (typeof WINDOW_OPTIONS)[number];

function fmtSeconds(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function fmtPercent(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNumber(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function speedup(slow: number | null, fast: number | null): string {
  if (slow == null || fast == null || fast === 0) return '—';
  const ratio = slow / fast;
  if (!Number.isFinite(ratio)) return '—';
  return `${ratio.toFixed(1)}×`;
}

export default function ScraperComparisonPage() {
  const [pairs, setPairs] = useState<VariantComparisonPair[]>([]);
  const [windowDays, setWindowDays] = useState<Window>(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPairKey, setBusyPairKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await ScraperService.getVariantComparison(windowDays);
    if (result.error) {
      setError(typeof result.error === 'string' ? result.error : 'Failed to load comparison.');
    } else {
      setPairs(result.data ?? []);
    }
    setLoading(false);
  }, [windowDays]);

  useEffect(() => {
    load();
  }, [load]);

  const promote = useCallback(
    async (pair: VariantComparisonPair) => {
      const pairKey = `${pair.slow_id}-${pair.fast_id}`;
      setBusyPairKey(pairKey);
      try {
        const slowRes = await ScraperService.toggleScraper(pair.slow_id, false);
        if (!slowRes.success) {
          setError(`Failed to disable slow scraper: ${slowRes.error}`);
          return;
        }
        const fastRes = await ScraperService.toggleScraper(pair.fast_id, true);
        if (!fastRes.success) {
          setError(`Failed to enable Fast scraper: ${fastRes.error}`);
          // Roll back to avoid leaving everything off.
          await ScraperService.toggleScraper(pair.slow_id, true);
          return;
        }
        await load();
      } finally {
        setBusyPairKey(null);
      }
    },
    [load],
  );

  const demote = useCallback(
    async (pair: VariantComparisonPair) => {
      const pairKey = `${pair.slow_id}-${pair.fast_id}`;
      setBusyPairKey(pairKey);
      try {
        await ScraperService.toggleScraper(pair.fast_id, false);
        await ScraperService.toggleScraper(pair.slow_id, true);
        await load();
      } finally {
        setBusyPairKey(null);
      }
    },
    [load],
  );

  const totals = useMemo(() => {
    let avgSlow = 0;
    let avgFast = 0;
    let count = 0;
    for (const p of pairs) {
      if (p.slow_avg_duration_s != null && p.fast_avg_duration_s != null) {
        avgSlow += p.slow_avg_duration_s;
        avgFast += p.fast_avg_duration_s;
        count += 1;
      }
    }
    return count > 0
      ? { avgSlow: avgSlow / count, avgFast: avgFast / count, count }
      : { avgSlow: 0, avgFast: 0, count: 0 };
  }, [pairs]);

  return (
    <Page title="Scraper variant comparison">
      <div className="p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Scraper variant comparison
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Slow vs Fast Luma scrapers operating on the same calendar.
              Promote when the Fast variant beats the slow one consistently.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--gray-11)]">Window:</span>
            {WINDOW_OPTIONS.map((d) => (
              <Button
                key={d}
                variant={windowDays === d ? 'solid' : 'ghost'}
                onClick={() => setWindowDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
        </header>

        {error && (
          <div className="p-3 rounded bg-[var(--red-3)] text-[var(--red-11)] text-sm">
            {error}
          </div>
        )}

        {totals.count > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card variant="surface" className="p-4">
              <div className="text-xs uppercase tracking-wide text-[var(--gray-a11)]">
                Pairs with data
              </div>
              <div className="text-2xl font-bold mt-1">{totals.count}</div>
            </Card>
            <Card variant="surface" className="p-4">
              <div className="text-xs uppercase tracking-wide text-[var(--gray-a11)]">
                Mean slow duration
              </div>
              <div className="text-2xl font-bold mt-1">{fmtSeconds(totals.avgSlow)}</div>
            </Card>
            <Card variant="surface" className="p-4">
              <div className="text-xs uppercase tracking-wide text-[var(--gray-a11)]">
                Mean Fast duration
              </div>
              <div className="text-2xl font-bold mt-1 text-[var(--green-11)]">
                {fmtSeconds(totals.avgFast)}{' '}
                <span className="text-base font-normal text-[var(--gray-a11)]">
                  ({speedup(totals.avgSlow, totals.avgFast)})
                </span>
              </div>
            </Card>
          </div>
        )}

        <Card variant="surface" className="overflow-hidden">
          <Table>
            <THead>
              <Tr>
                <Th>Slow scraper</Th>
                <Th>Fast scraper</Th>
                <Th>Runs (slow / fast)</Th>
                <Th>Avg duration</Th>
                <Th>Speedup</Th>
                <Th>Avg items</Th>
                <Th>Success rate</Th>
                <Th>Promotion</Th>
              </Tr>
            </THead>
            <TBody>
              {pairs.map((p) => {
                const pairKey = `${p.slow_id}-${p.fast_id}`;
                const slowActive = p.slow_enabled && !p.fast_enabled;
                const fastActive = !p.slow_enabled && p.fast_enabled;
                return (
                  <Tr key={pairKey}>
                    <Td>
                      <div className="font-medium">{p.slow_name}</div>
                      <div className="text-xs text-[var(--gray-a11)]">
                        {p.slow_enabled ? <Badge color="success" variant="soft">enabled</Badge> : <Badge color="gray" variant="soft">disabled</Badge>}
                      </div>
                    </Td>
                    <Td>
                      <div className="font-medium">{p.fast_name}</div>
                      <div className="text-xs text-[var(--gray-a11)]">
                        {p.fast_enabled ? <Badge color="success" variant="soft">enabled</Badge> : <Badge color="gray" variant="soft">disabled</Badge>}
                      </div>
                    </Td>
                    <Td>{p.slow_runs} / {p.fast_runs}</Td>
                    <Td>
                      <div>{fmtSeconds(p.slow_avg_duration_s)}</div>
                      <div className="text-[var(--green-11)]">{fmtSeconds(p.fast_avg_duration_s)}</div>
                    </Td>
                    <Td className="font-semibold">
                      {speedup(p.slow_avg_duration_s, p.fast_avg_duration_s)}
                    </Td>
                    <Td>
                      <div>{fmtNumber(p.slow_avg_items)}</div>
                      <div>{fmtNumber(p.fast_avg_items)}</div>
                    </Td>
                    <Td>
                      <div>{fmtPercent(p.slow_success_rate)}</div>
                      <div>{fmtPercent(p.fast_success_rate)}</div>
                    </Td>
                    <Td>
                      {fastActive ? (
                        <Button
                          variant="ghost"
                          color="amber"
                          onClick={() => demote(p)}
                          disabled={busyPairKey === pairKey}
                        >
                          Revert to slow
                        </Button>
                      ) : slowActive ? (
                        <Button
                          variant="solid"
                          onClick={() => promote(p)}
                          disabled={busyPairKey === pairKey || p.fast_runs === 0}
                          title={p.fast_runs === 0 ? 'Fast variant has no runs yet — let it run on its own schedule first' : ''}
                        >
                          Promote Fast
                        </Button>
                      ) : (
                        <span className="text-xs text-[var(--gray-a11)]">both off / both on</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
              {!loading && pairs.length === 0 && (
                <Tr>
                  <Td colSpan={8} className="text-center text-[var(--gray-a11)] py-6">
                    No paired scrapers found. Create a *Fast variant of an existing Luma scraper to start comparing.
                  </Td>
                </Tr>
              )}
            </TBody>
          </Table>
        </Card>
      </div>
    </Page>
  );
}
