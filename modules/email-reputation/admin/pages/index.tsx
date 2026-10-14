/**
 * Email Reputation — open rate by mailbox provider for every send.
 *
 * When one provider (usually Gmail) files a domain's mail as spam, its open
 * rate drops far below the others while delivery still looks fine. The chart
 * shows that per sending domain; the table and alerts give the numbers.
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { WorkspaceLayout } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { useThemeContext } from '@/app/contexts/theme/context';
import {
  CHART_PROVIDERS, MIN_PLOT_DELIVERED, PROVIDER_LABEL,
  cellsBySend, domainsByRecency, formatRate, sendKey,
  type Cell, type ChartProvider, type SendRow, type StatRow,
} from '../lib/series';

interface AlertRow {
  id: string;
  send_kind: string;
  send_id: string;
  provider: string;
  sending_domain: string | null;
  provider_open_rate: number;
  baseline_open_rate: number;
  delivered: number;
  created_at: string;
  acknowledged_at: string | null;
}

// Validated categorical palette (dataviz validator, light and dark): fixed
// slot order per provider, never by rank. Light-mode aqua and yellow sit below
// 3:1 on the surface, so every line also has a direct label and the table
// below carries the same numbers.
const SERIES_COLOR: Record<'light' | 'dark', Record<ChartProvider, string>> = {
  light: { google: '#2a78d6', microsoft: '#eb6834', yahoo: '#1baf7a', other: '#eda100' },
  dark: { google: '#3987e5', microsoft: '#d95926', yahoo: '#199e70', other: '#c98500' },
};

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export default function EmailReputationPage() {
  const { isDark } = useThemeContext();
  const colors = SERIES_COLOR[isDark ? 'dark' : 'light'];
  const [sends, setSends] = useState<SendRow[]>([]);
  const [stats, setStats] = useState<StatRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: s, error: sErr } = await supabase
      .from('email_reputation_sends')
      .select('send_kind, send_id, sending_domain, send_label, send_started_at')
      .order('send_started_at', { ascending: false })
      .limit(300);
    if (sErr) { toast.error(sErr.message); setLoading(false); return; }
    const sendRows = (s ?? []) as SendRow[];

    const ids = sendRows.map((r) => r.send_id);
    const statRows: StatRow[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from('email_reputation_send_stats')
        .select('send_kind, send_id, provider, delivered, opened')
        .in('send_id', ids.slice(i, i + 100));
      if (error) { toast.error(error.message); break; }
      statRows.push(...((data ?? []) as StatRow[]));
    }

    const { data: a } = await supabase
      .from('email_reputation_alerts')
      .select('id, send_kind, send_id, provider, sending_domain, provider_open_rate, baseline_open_rate, delivered, created_at, acknowledged_at')
      .order('created_at', { ascending: false })
      .limit(100);

    setSends(sendRows);
    setStats(statRows);
    setAlerts((a ?? []) as AlertRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const domains = useMemo(() => domainsByRecency(sends), [sends]);
  const activeDomain = domain ?? domains[0] ?? null;
  const cells = useMemo(() => cellsBySend(stats), [stats]);
  const alertKeys = useMemo(() => new Set(alerts.map((a) => `${sendKey(a)}:${a.provider}`)), [alerts]);
  const labelBySend = useMemo(() => new Map(sends.map((s) => [sendKey(s), s])), [sends]);

  const domainSends = useMemo(
    () => sends.filter((s) => (s.sending_domain ?? 'unknown') === activeDomain && cells.has(sendKey(s)))
      .sort((a, b) => Date.parse(a.send_started_at) - Date.parse(b.send_started_at)),
    [sends, activeDomain, cells],
  );

  const openAlerts = alerts.filter((a) => !a.acknowledged_at);

  const acknowledge = async (id: string) => {
    const { error } = await supabase.rpc('email_reputation_acknowledge_alert', { p_alert_id: id });
    if (error) { toast.error(error.message); return; }
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged_at: new Date().toISOString() } : a)));
  };

  return (
    <Page title="Email Reputation">
      <WorkspaceLayout title="Email Reputation">
        {loading ? (
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
        ) : sends.length === 0 ? (
          <div className="max-w-xl py-12 text-sm text-[var(--gray-11)] space-y-2">
            <p>No sends have been measured yet.</p>
            <p>The worker measures newsletter and broadcast sends every 30 minutes, starting with the most recent, and fills in history over the next few runs.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-[var(--gray-11)] max-w-3xl">
              Open rate per send at each mailbox provider. When one provider files a domain&apos;s mail as spam,
              its open rate falls far below the others while delivery still looks normal. Google includes
              company addresses hosted on Google Workspace.
            </p>

            {openAlerts.length > 0 && (
              <section className="border border-[var(--red-a6)] rounded-lg overflow-hidden">
                <div className="px-4 py-3 bg-[var(--red-a2)] border-b border-[var(--red-a5)]">
                  <h2 className="text-sm font-semibold text-[var(--gray-12)]">Open alerts ({openAlerts.length})</h2>
                </div>
                <ul className="divide-y divide-[var(--gray-a4)]">
                  {openAlerts.slice(0, 20).map((a) => {
                    const s = labelBySend.get(sendKey(a));
                    return (
                      <li key={a.id} className="px-4 py-3 flex items-center gap-4 text-sm">
                        <span aria-hidden className="text-[var(--red-11)]">&#9888;</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[var(--gray-12)]">
                            {PROVIDER_LABEL[a.provider] ?? a.provider} opened {formatRate(a.provider_open_rate)}, against {formatRate(a.baseline_open_rate)} at other providers
                          </div>
                          <div className="text-xs text-[var(--gray-10)] truncate">
                            {s ? `${dateLabel(s.send_started_at)} · ${s.send_label ?? 'Untitled send'}` : a.send_id} · {a.sending_domain ?? 'unknown domain'} · {a.delivered.toLocaleString()} delivered
                          </div>
                        </div>
                        <button type="button" onClick={() => void acknowledge(a.id)} className="px-3 py-1.5 text-xs rounded-md border border-[var(--gray-a6)] text-[var(--gray-12)] hover:bg-[var(--gray-a3)]">
                          Acknowledge
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Sending domain">
              {domains.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={d === activeDomain}
                  onClick={() => setDomain(d)}
                  className={`px-3 py-1.5 text-sm rounded-md border ${d === activeDomain ? 'border-[var(--accent-8)] bg-[var(--accent-a3)] text-[var(--gray-12)]' : 'border-[var(--gray-a6)] text-[var(--gray-11)] hover:bg-[var(--gray-a3)]'}`}
                >
                  {d}
                </button>
              ))}
            </div>

            {activeDomain && (
              <ProviderChart sends={domainSends} cells={cells} colors={colors} />
            )}

            {activeDomain && (
              <SendsTable sends={[...domainSends].reverse()} cells={cells} alertKeys={alertKeys} />
            )}
          </div>
        )}
      </WorkspaceLayout>
    </Page>
  );
}

// --- Chart ------------------------------------------------------------------

const W = 880;
const H = 280;
const PAD = { top: 16, right: 96, bottom: 32, left: 44 };

function ProviderChart({ sends, cells, colors }: { sends: SendRow[]; cells: Map<string, Record<ChartProvider, Cell>>; colors: Record<ChartProvider, string> }) {
  const [hover, setHover] = useState<number | null>(null);
  const providers = CHART_PROVIDERS.filter((p) => sends.some((s) => (cells.get(sendKey(s))?.[p].delivered ?? 0) >= MIN_PLOT_DELIVERED));

  if (sends.length === 0 || providers.length === 0) {
    return <p className="text-sm text-[var(--gray-10)]">Not enough delivered messages at any provider to chart yet.</p>;
  }

  const maxRate = Math.max(0.1, ...sends.flatMap((s) => providers.map((p) => cells.get(sendKey(s))?.[p].rate ?? 0)));
  const yMax = Math.min(1, Math.ceil(maxRate * 10) / 10);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (sends.length === 1 ? innerW / 2 : (i / (sends.length - 1)) * innerW);
  const y = (r: number) => PAD.top + innerH - (r / yMax) * innerH;
  const ticks = Array.from({ length: Math.round(yMax * 10) + 1 }, (_, i) => i / 10).filter((t, i, all) => all.length <= 6 || i % 2 === 0);

  const point = (s: SendRow, p: ChartProvider) => {
    const c = cells.get(sendKey(s))?.[p];
    return c && c.delivered >= MIN_PLOT_DELIVERED && c.rate != null ? c : null;
  };

  // Lines break where a send has too few messages at that provider.
  const paths = providers.map((p) => {
    let d = '';
    let pen = false;
    sends.forEach((s, i) => {
      const c = point(s, p);
      if (!c) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(c.rate!).toFixed(1)}`;
      pen = true;
    });
    return { p, d };
  });

  // Direct labels at each line's last plotted point, nudged apart vertically.
  const ends = providers.map((p) => {
    for (let i = sends.length - 1; i >= 0; i--) {
      const c = point(sends[i], p);
      if (c) return { p, yPos: y(c.rate!) };
    }
    return null;
  }).filter((e): e is { p: ChartProvider; yPos: number } => !!e).sort((a, b) => a.yPos - b.yPos);
  for (let i = 1; i < ends.length; i++) if (ends[i].yPos - ends[i - 1].yPos < 14) ends[i].yPos = ends[i - 1].yPos + 14;

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = sends.length === 1 ? 0 : Math.round(((px - PAD.left) / innerW) * (sends.length - 1));
    setHover(Math.max(0, Math.min(sends.length - 1, i)));
  };

  const hovered = hover != null ? sends[hover] : null;

  return (
    <section className="border border-[var(--gray-a5)] rounded-lg p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-2">
        <h2 className="text-sm font-semibold text-[var(--gray-12)]">Open rate per send, by provider</h2>
        <div className="flex flex-wrap gap-4 text-xs text-[var(--gray-11)]" aria-label="Legend">
          {providers.map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-4 h-0.5 rounded" style={{ background: colors[p] }} />
              {PROVIDER_LABEL[p]}
            </span>
          ))}
        </div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Open rate per send for each mailbox provider">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--gray-a4)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--gray-10)">{Math.round(t * 100)}%</text>
            </g>
          ))}
          {sends.length > 1 && [0, Math.floor((sends.length - 1) / 2), sends.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
            <text key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--gray-10)">{dateLabel(sends[i].send_started_at)}</text>
          ))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--gray-a7)" strokeWidth={1} />}
          {paths.map(({ p, d }) => (
            <path key={p} d={d} fill="none" stroke={colors[p]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {providers.map((p) => sends.map((s, i) => {
            const c = point(s, p);
            if (!c) return null;
            const r = hover === i ? 5 : 3;
            return <circle key={`${p}-${i}`} cx={x(i)} cy={y(c.rate!)} r={r} fill={colors[p]} stroke="var(--color-background)" strokeWidth={2} />;
          }))}
          {ends.map((e) => (
            <text key={e.p} x={W - PAD.right + 8} y={e.yPos} dominantBaseline="middle" fontSize={11} fill="var(--gray-11)">{PROVIDER_LABEL[e.p]}</text>
          ))}
          <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hovered && hover != null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-64 rounded-md border border-[var(--gray-a6)] bg-[var(--color-panel-solid)] p-3 text-xs shadow-lg"
            style={{ left: `min(calc(${(x(hover) / W) * 100}% + 12px), calc(100% - 16rem))` }}
          >
            <div className="font-medium text-[var(--gray-12)] truncate">{hovered.send_label ?? 'Untitled send'}</div>
            <div className="text-[var(--gray-10)] mb-2">{dateLabel(hovered.send_started_at)}</div>
            {providers.map((p) => {
              const c = cells.get(sendKey(hovered))?.[p];
              return (
                <div key={p} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="inline-flex items-center gap-1.5 text-[var(--gray-11)]">
                    <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ background: colors[p] }} />
                    {PROVIDER_LABEL[p]}
                  </span>
                  <span className="text-[var(--gray-12)] tabular-nums">{formatRate(c?.rate ?? null)} <span className="text-[var(--gray-10)]">of {(c?.delivered ?? 0).toLocaleString()}</span></span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-[var(--gray-10)]">Points with fewer than {MIN_PLOT_DELIVERED} delivered messages at a provider are not plotted. Apple is left out because Apple Mail opens messages automatically.</p>
    </section>
  );
}

// --- Table ------------------------------------------------------------------

function SendsTable({ sends, cells, alertKeys }: { sends: SendRow[]; cells: Map<string, Record<ChartProvider, Cell>>; alertKeys: Set<string> }) {
  return (
    <section className="border border-[var(--gray-a5)] rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[var(--gray-a2)] text-xs text-[var(--gray-11)]">
          <tr>
            <th className="text-left font-medium px-4 py-2">Date</th>
            <th className="text-left font-medium px-4 py-2">Send</th>
            {CHART_PROVIDERS.map((p) => <th key={p} className="text-right font-medium px-4 py-2">{PROVIDER_LABEL[p]}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--gray-a4)]">
          {sends.map((s) => {
            const row = cells.get(sendKey(s));
            return (
              <tr key={sendKey(s)}>
                <td className="px-4 py-2 whitespace-nowrap text-[var(--gray-11)]">{dateLabel(s.send_started_at)}</td>
                <td className="px-4 py-2 max-w-xs truncate text-[var(--gray-12)]" title={s.send_label ?? ''}>{s.send_label ?? 'Untitled send'}</td>
                {CHART_PROVIDERS.map((p) => {
                  const c = row?.[p];
                  const flagged = alertKeys.has(`${sendKey(s)}:${p}`);
                  return (
                    <td key={p} className={`px-4 py-2 text-right tabular-nums whitespace-nowrap ${flagged ? 'bg-[var(--red-a3)]' : ''}`}>
                      {c && c.delivered > 0 ? (
                        <>
                          {flagged && <span className="text-[var(--red-11)] mr-1" title="Alert raised for this provider">&#9888;</span>}
                          <span className="text-[var(--gray-12)]">{formatRate(c.rate)}</span>
                          <span className="text-xs text-[var(--gray-10)]"> of {c.delivered.toLocaleString()}</span>
                        </>
                      ) : <span className="text-[var(--gray-9)]">n/a</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
