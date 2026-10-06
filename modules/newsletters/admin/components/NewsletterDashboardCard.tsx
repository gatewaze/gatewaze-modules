import {
  DocumentDuplicateIcon, PencilSquareIcon, ArrowRightIcon,
} from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui';
import { RowActions } from '@/components/shared/table/RowActions';

export interface DashboardEdition {
  id: string;
  title: string | null;
  edition_date: string;
  status: string | null;
  publish_state?: string | null;
  collection_id: string | null;
  preheader?: string | null;
  content_category?: string | null;
  metadata?: Record<string, unknown> | null;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  hasData: boolean;
}

export interface NewsletterCardData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  content_category: string | null;
  accent_color: string | null;
  from_email: string | null;
  setup_complete: boolean;
  edition_count: number;
  subscriber_count: number;
  avgOpenRate: number | null;   // 0..1 across recent sent editions
  avgClickRate: number | null;
  totalSent: number;
  sparkline: number[];          // open rates 0..1, oldest → newest
  latestEditions: DashboardEdition[];
}

const fmtNum = (n: number) => n.toLocaleString();
const pct = (v: number | null) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
function fmtShortDate(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// A tiny open-rate trend line. Single series, no axes — a texture, not a chart.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length < 2) return null;
  const w = 76, h = 22, pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const xy = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
      <circle cx={lx} cy={ly} r={2} fill={color} />
    </svg>
  );
}

function Metric({ label, value, spark, accent }: { label: string; value: string; spark?: number[]; accent: string }) {
  return (
    <div className="bg-[var(--color-panel-solid)] px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-10)]">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-xl font-semibold tabular-nums text-[var(--gray-12)]">{value}</span>
        {spark && spark.length >= 2 && <Sparkline values={spark} color={accent} />}
      </div>
    </div>
  );
}

function EditionStatus({ ed }: { ed: DashboardEdition }) {
  if (ed.hasData) return <Badge variant="soft" color="green" size="1">Sent</Badge>;
  if (ed.publish_state === 'published') return <Badge variant="soft" color="blue" size="1">Published</Badge>;
  if (ed.status === 'scheduled') return <Badge variant="soft" color="amber" size="1">Scheduled</Badge>;
  return <Badge variant="soft" color="gray" size="1">Draft</Badge>;
}

interface Props {
  data: NewsletterCardData;
  onOpen: () => void;
  onViewAllEditions: () => void;
  onEditEdition: (id: string) => void;
  onDuplicateEdition: (ed: DashboardEdition) => void;
}

export function NewsletterDashboardCard({ data, onOpen, onViewAllEditions, onEditEdition, onDuplicateEdition }: Props) {
  const accent = data.accent_color || 'var(--accent-9)';

  return (
    <div
      className="group/card relative flex flex-col rounded-xl border border-[var(--gray-a4)] bg-[var(--color-panel-solid)] overflow-hidden transition-shadow hover:shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.18)]"
    >
      {/* accent spine */}
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} aria-hidden="true" />

      {/* header */}
      <div className="pl-5 pr-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <h3 className="truncate text-lg font-semibold text-[var(--gray-12)] hover:text-[var(--accent-11)] transition-colors">
              {data.name}
            </h3>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              {data.content_category && <Badge variant="soft" color="blue" size="1">{data.content_category}</Badge>}
              {data.from_email && <span className="text-xs text-[var(--gray-10)] truncate">{data.from_email}</span>}
            </div>
          </button>
          {!data.setup_complete && <Badge variant="soft" color="orange" size="1">Setup needed</Badge>}
        </div>
        {data.description && (
          <p className="mt-2 text-sm text-[var(--gray-10)] line-clamp-1">{data.description}</p>
        )}
      </div>

      {/* metric strip — hairline dividers via a tinted gap */}
      <div className="mx-5 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg bg-[var(--gray-a4)] overflow-hidden ring-1 ring-[var(--gray-a4)]">
        <Metric label="Subscribers" value={fmtNum(data.subscriber_count)} accent={accent} />
        <Metric label="Editions" value={fmtNum(data.edition_count)} accent={accent} />
        <Metric label="Open rate" value={pct(data.avgOpenRate)} spark={data.sparkline} accent={accent} />
        <Metric label="Click rate" value={pct(data.avgClickRate)} accent={accent} />
      </div>

      {/* latest editions */}
      <div className="px-5 pt-4 pb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--gray-10)]">Latest editions</span>
          <button
            type="button"
            onClick={onViewAllEditions}
            className="inline-flex items-center gap-1 text-xs text-[var(--accent-11)] hover:underline"
          >
            View all {data.edition_count} <ArrowRightIcon className="size-3" />
          </button>
        </div>

        {data.latestEditions.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--gray-9)]">No editions yet.</p>
        ) : (
          <ul className="flex flex-col">
            {data.latestEditions.map((ed) => (
              <li key={ed.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onEditEdition(ed.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onEditEdition(ed.id); }}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 cursor-pointer hover:bg-[var(--gray-a3)] transition-colors"
                >
                  <span className="w-12 shrink-0 text-xs tabular-nums text-[var(--gray-10)]">{fmtShortDate(ed.edition_date)}</span>
                  <span className="flex-1 min-w-0 truncate text-sm text-[var(--gray-12)]">{ed.title || <span className="italic text-[var(--gray-9)]">Untitled</span>}</span>
                  <span className="shrink-0"><EditionStatus ed={ed} /></span>
                  <div className="hidden md:flex shrink-0 items-center gap-4 w-44 justify-end text-xs tabular-nums">
                    <span className="text-[var(--gray-11)]">{ed.hasData ? fmtNum(ed.sent) : '—'}<span className="ml-1 text-[10px] text-[var(--gray-9)]">sent</span></span>
                    <span className="text-[var(--gray-12)] font-medium">{ed.hasData ? pct(ed.opens / ed.delivered) : '—'}<span className="ml-1 text-[10px] font-normal text-[var(--gray-9)]">open</span></span>
                    <span className="text-[var(--gray-11)]">{ed.hasData ? pct(ed.clicks / ed.delivered) : '—'}<span className="ml-1 text-[10px] text-[var(--gray-9)]">click</span></span>
                  </div>
                  <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <RowActions
                      actions={[
                        { label: 'Edit', icon: <PencilSquareIcon className="size-4" />, onClick: () => onEditEdition(ed.id) },
                        { label: 'Duplicate', icon: <DocumentDuplicateIcon className="size-4" />, onClick: () => onDuplicateEdition(ed) },
                      ]}
                    />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default NewsletterDashboardCard;
