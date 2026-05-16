/**
 * Admin: AI usage / cost dashboard.
 *
 * Top-line: this-month spend. Breakdowns: by provider, by user, by
 * use-case. Drillable: clicking a row filters the events table below.
 *
 * Reads from /api/modules/ai/admin/usage/{summary,events}.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowPathIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  getUsageSummary,
  listUsageEvents,
  microUsdToDollars,
  type AiUsageEvent,
  type AiUsageSummary,
} from '../utils/aiService';

interface Filter {
  fromIso: string;
  toIso: string;
  userId?: string;
  useCase?: string;
}

function startOfMonthIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

export default function AiUsageDashboard() {
  const [filter, setFilter] = useState<Filter>(() => ({ fromIso: startOfMonthIso(), toIso: nowIso() }));
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [events, setEvents] = useState<AiUsageEvent[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);

  useEffect(() => {
    void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.fromIso, filter.toIso, filter.userId, filter.useCase]);

  async function hydrate() {
    setLoadingSummary(true);
    setLoadingEvents(true);
    try {
      const [s, e] = await Promise.all([
        getUsageSummary({ from: filter.fromIso, to: filter.toIso }),
        listUsageEvents({
          from: filter.fromIso,
          to: filter.toIso,
          userId: filter.userId,
          useCase: filter.useCase,
          limit: 200,
        }),
      ]);
      setSummary(s);
      setEvents(e.events);
    } catch (err) {
      console.error('[ai-usage] hydrate failed', err);
      toast.error('Failed to load usage');
    } finally {
      setLoadingSummary(false);
      setLoadingEvents(false);
    }
  }

  const csvHref = useMemo(() => {
    if (events.length === 0) return null;
    const header = [
      'occurred_at',
      'user_id',
      'use_case',
      'provider',
      'model',
      'kind',
      'input_tokens',
      'output_tokens',
      'cost_usd',
      'status',
    ].join(',');
    const rows = events.map((e) =>
      [
        e.occurred_at,
        e.user_id ?? 'system',
        e.use_case,
        e.provider,
        e.model,
        e.kind,
        e.input_tokens,
        e.output_tokens,
        (Number(e.cost_micro_usd) / 1_000_000).toFixed(6),
        e.status,
      ].join(','),
    );
    const csv = [header, ...rows].join('\n');
    return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  }, [events]);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">AI usage</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Token + image + tool spend across all Gatewaze AI surfaces.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={`${filter.fromIso}|${filter.toIso}`}
            onChange={(e) => {
              const [f, t] = e.target.value.split('|');
              setFilter((prev) => ({ ...prev, fromIso: f ?? prev.fromIso, toIso: t ?? prev.toIso }));
            }}
            className="form-input text-sm"
          >
            <option value={`${startOfMonthIso()}|${nowIso()}`}>This month</option>
            <option value={`${last30Iso()}|${nowIso()}`}>Last 30 days</option>
            <option value={`${last7Iso()}|${nowIso()}`}>Last 7 days</option>
            <option value={`${todayIso()}|${nowIso()}`}>Today</option>
          </select>
          <button
            type="button"
            className="inline-flex items-center px-2 py-1 rounded border text-sm hover:bg-neutral-50"
            onClick={() => void hydrate()}
            title="Refresh"
          >
            <ArrowPathIcon className="size-4 mr-1" />
            Refresh
          </button>
          {csvHref && (
            <a
              href={csvHref}
              download={`ai-usage-${filter.fromIso.slice(0, 10)}.csv`}
              className="inline-flex items-center px-2 py-1 rounded border text-sm hover:bg-neutral-50"
            >
              <ArrowDownTrayIcon className="size-4 mr-1" />
              CSV
            </a>
          )}
        </div>
      </header>

      {/* ── Top-line total ───────────────────────────────────────────── */}
      <section className="rounded-md border bg-white p-4">
        {loadingSummary ? (
          <LoadingSpinner />
        ) : summary ? (
          <div className="flex items-baseline gap-4">
            <div>
              <div className="text-xs text-neutral-500">Total spend</div>
              <div className="text-3xl font-semibold">{microUsdToDollars(summary.total_cost_micro_usd)}</div>
            </div>
            <div className="text-xs text-neutral-500 ml-auto">
              {summary.from.slice(0, 10)} → {summary.to.slice(0, 10)}
            </div>
          </div>
        ) : (
          <div>—</div>
        )}
      </section>

      {/* ── Breakdowns ───────────────────────────────────────────────── */}
      {summary && !loadingSummary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Breakdown
            title="By provider"
            rows={summary.by_provider}
            onSelect={() => {/* future: filter events */}}
          />
          <Breakdown
            title="By use-case"
            rows={summary.by_use_case}
            onSelect={(k) => setFilter((prev) => ({ ...prev, useCase: k === prev.useCase ? undefined : k }))}
            activeKey={filter.useCase}
          />
          <Breakdown
            title="By user"
            rows={summary.by_user}
            onSelect={(k) =>
              setFilter((prev) => ({ ...prev, userId: k === '__system__' || k === prev.userId ? undefined : k }))
            }
            activeKey={filter.userId}
          />
        </div>
      )}

      {/* ── Events table ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-neutral-700">
            Recent events {filter.userId && `(user ${filter.userId.slice(0, 8)})`}
            {filter.useCase && `(use_case ${filter.useCase})`}
          </h2>
          {(filter.userId || filter.useCase) && (
            <button
              type="button"
              onClick={() => setFilter((prev) => ({ ...prev, userId: undefined, useCase: undefined }))}
              className="text-xs text-neutral-500 hover:text-neutral-900"
            >
              Clear filter
            </button>
          )}
        </div>
        {loadingEvents ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          <div className="rounded-md border border-dashed p-10 text-center text-sm text-neutral-500">
            No events in range.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50">
                <tr className="text-left">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Use-case</th>
                  <th className="px-3 py-2">Provider/Model</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2 text-right">In</th>
                  <th className="px-3 py-2 text-right">Out</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t hover:bg-neutral-50">
                    <td className="px-3 py-1.5 text-neutral-500 font-mono text-xs">
                      {new Date(e.occurred_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {e.user_id ? <code>{e.user_id.slice(0, 8)}</code> : <em className="text-neutral-400">system</em>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{e.use_case}</td>
                    <td className="px-3 py-1.5 text-xs">
                      <span className="font-mono">{e.provider}/{e.model}</span>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{e.kind}</td>
                    <td className="px-3 py-1.5 text-right text-xs">{e.input_tokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right text-xs">{e.output_tokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right text-xs">
                      {microUsdToDollars(e.cost_micro_usd)}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      <span className={statusClass(e.status)}>{e.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  onSelect,
  activeKey,
}: {
  title: string;
  rows: Array<{ key: string; cost_micro_usd: number; event_count: number }>;
  onSelect?: (key: string) => void;
  activeKey?: string;
}) {
  const total = rows.reduce((s, r) => s + Number(r.cost_micro_usd), 0);
  const sorted = [...rows].sort((a, b) => Number(b.cost_micro_usd) - Number(a.cost_micro_usd));
  return (
    <div className="rounded-md border bg-white">
      <h3 className="text-xs font-medium px-3 py-2 border-b bg-neutral-50">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {sorted.slice(0, 8).map((r) => {
            const pct = total > 0 ? (Number(r.cost_micro_usd) / total) * 100 : 0;
            const isActive = activeKey === r.key;
            return (
              <tr
                key={r.key}
                onClick={() => onSelect?.(r.key)}
                className={`border-t cursor-pointer hover:bg-neutral-50 ${isActive ? 'bg-blue-50' : ''}`}
              >
                <td className="px-3 py-1.5 text-xs truncate max-w-[140px]" title={r.key}>
                  {r.key === '__system__' ? <em className="text-neutral-400">system</em> : r.key}
                </td>
                <td className="px-3 py-1.5 text-right text-xs">{microUsdToDollars(r.cost_micro_usd)}</td>
                <td className="px-3 py-1.5 text-right text-xs text-neutral-400 w-12">
                  {pct.toFixed(0)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'text-green-700';
    case 'error':
      return 'text-red-700';
    case 'rate_limited':
    case 'timeout':
      return 'text-amber-700';
    case 'budget_blocked':
      return 'text-red-600 font-medium';
    case 'cancelled':
      return 'text-neutral-500';
    default:
      return 'text-neutral-700';
  }
}

function last30Iso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function last7Iso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function todayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
