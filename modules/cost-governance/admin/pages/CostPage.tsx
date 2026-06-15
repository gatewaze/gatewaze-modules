import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Tabs, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';

interface SummaryRow {
  brand_id: string;
  bucket_key: string;
  total_cost: number;
  total_calls: number;
  total_units_in: number;
  total_units_out: number;
}

interface BudgetRow {
  brand_id: string;
  provider: string;
  period: 'daily' | 'monthly';
  soft_cap_usd: number;
  hard_cap_usd: number | null;
  notes: string | null;
  updated_at: string;
}

interface UsageRow {
  id: number;
  occurred_at: string;
  brand_id: string;
  provider: string;
  product: string;
  feature: string;
  units_in: number;
  units_out: number;
  cost_usd: number;
  request_id: string | null;
  context: Record<string, unknown> | null;
}

type TabId = 'summary' | 'budgets' | 'recent';

const TABS: { id: TabId; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'recent',  label: 'Recent calls' },
];

const formatUsd = (n: number) => `$${n.toFixed(2)}`;

export default function CostPage() {
  const [tab, setTab] = useState<TabId>('summary');
  const [groupBy, setGroupBy] = useState<'provider' | 'feature' | 'product'>('provider');
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [recent, setRecent] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const [s, b, r] = await Promise.all([
        fetch(`${apiUrl}/api/cost-governance/usage-summary?window_days=30&group_by=${groupBy}`).then((res) => res.json()),
        fetch(`${apiUrl}/api/cost-governance/budgets`).then((res) => res.json()),
        fetch(`${apiUrl}/api/cost-governance/recent?limit=100`).then((res) => res.json()),
      ]);
      setSummary(s.rows ?? []);
      setBudgets(b.budgets ?? []);
      setRecent(r.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [groupBy]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const totals = useMemo(() => {
    const byBrand = new Map<string, number>();
    for (const row of summary) {
      byBrand.set(row.brand_id, (byBrand.get(row.brand_id) ?? 0) + Number(row.total_cost ?? 0));
    }
    return Array.from(byBrand.entries()).sort((a, b) => b[1] - a[1]);
  }, [summary]);

  if (loading && summary.length === 0) {
    return (
      <Page title="Cost Governance">
        <div className="p-6 text-sm text-[var(--gray-11)]">Loading…</div>
      </Page>
    );
  }

  return (
    <Page title="Cost Governance">
      <div className="p-6 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Cost Governance</h1>
          <p className="text-[var(--gray-11)] mt-1">
            External API spend over the last 30 days, plus per-brand budget caps.
          </p>
        </header>

        {error && (
          <div className="p-3 rounded bg-[var(--red-3)] text-[var(--red-11)] text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {totals.map(([brand, total]) => (
            <Card key={brand} variant="surface" className="p-4">
              <div className="text-xs uppercase tracking-wide text-[var(--gray-a11)]">
                {brand}
              </div>
              <div className="text-2xl font-bold mt-1">{formatUsd(total)}</div>
              <div className="text-xs text-[var(--gray-a11)]">past 30 days</div>
            </Card>
          ))}
          {totals.length === 0 && (
            <Card variant="surface" className="p-4 col-span-full">
              <div className="text-sm text-[var(--gray-a11)]">
                No spend recorded yet. Helper SDK adoption per spec §15.6.
              </div>
            </Card>
          )}
        </div>

        <Tabs value={tab} onChange={(id) => setTab(id as TabId)} tabs={TABS} />

        {tab === 'summary' && (
          <Card variant="surface" className="overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--gray-a4)] flex items-center gap-3">
              <span className="text-sm text-[var(--gray-11)]">Group by:</span>
              {(['provider', 'feature', 'product'] as const).map((g) => (
                <Button
                  key={g}
                  variant={groupBy === g ? 'solid' : 'ghost'}
                  onClick={() => setGroupBy(g)}
                >
                  {g}
                </Button>
              ))}
            </div>
            <Table>
              <THead>
                <Tr>
                  <Th>Brand</Th>
                  <Th>{groupBy}</Th>
                  <Th>Calls</Th>
                  <Th>Cost</Th>
                </Tr>
              </THead>
              <TBody>
                {summary.map((row) => (
                  <Tr key={`${row.brand_id}-${row.bucket_key}`}>
                    <Td>{row.brand_id}</Td>
                    <Td>{row.bucket_key}</Td>
                    <Td>{Number(row.total_calls).toLocaleString()}</Td>
                    <Td>{formatUsd(Number(row.total_cost ?? 0))}</Td>
                  </Tr>
                ))}
                {summary.length === 0 && (
                  <Tr>
                    <Td colSpan={4} className="text-center text-[var(--gray-a11)] py-6">
                      No usage in window.
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </Card>
        )}

        {tab === 'budgets' && (
          <Card variant="surface" className="overflow-hidden">
            <Table>
              <THead>
                <Tr>
                  <Th>Brand</Th>
                  <Th>Provider</Th>
                  <Th>Period</Th>
                  <Th>Soft cap</Th>
                  <Th>Hard cap</Th>
                  <Th>Notes</Th>
                </Tr>
              </THead>
              <TBody>
                {budgets.map((b) => (
                  <Tr key={`${b.brand_id}-${b.provider}-${b.period}`}>
                    <Td>{b.brand_id}</Td>
                    <Td><Badge color="info" variant="soft">{b.provider}</Badge></Td>
                    <Td>{b.period}</Td>
                    <Td>{formatUsd(Number(b.soft_cap_usd))}</Td>
                    <Td>{b.hard_cap_usd == null ? '—' : formatUsd(Number(b.hard_cap_usd))}</Td>
                    <Td className="text-sm text-[var(--gray-a11)]">{b.notes ?? ''}</Td>
                  </Tr>
                ))}
                {budgets.length === 0 && (
                  <Tr>
                    <Td colSpan={6} className="text-center text-[var(--gray-a11)] py-6">
                      No budgets configured.
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </Card>
        )}

        {tab === 'recent' && (
          <Card variant="surface" className="overflow-hidden">
            <Table>
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Brand</Th>
                  <Th>Provider</Th>
                  <Th>Feature</Th>
                  <Th>Cost</Th>
                </Tr>
              </THead>
              <TBody>
                {recent.map((r) => (
                  <Tr key={r.id}>
                    <Td className="text-xs text-[var(--gray-a11)]">
                      {new Date(r.occurred_at).toLocaleString()}
                    </Td>
                    <Td>{r.brand_id}</Td>
                    <Td><Badge variant="soft">{r.provider}</Badge></Td>
                    <Td className="text-sm">{r.feature}</Td>
                    <Td>{formatUsd(Number(r.cost_usd))}</Td>
                  </Tr>
                ))}
                {recent.length === 0 && (
                  <Tr>
                    <Td colSpan={5} className="text-center text-[var(--gray-a11)] py-6">
                      No recent calls.
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </Card>
        )}
      </div>
    </Page>
  );
}
