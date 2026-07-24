import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  createColumnHelper, getCoreRowModel, getExpandedRowModel, useReactTable,
  type ExpandedState, type Row,
} from '@tanstack/react-table';
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button } from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import {
  broadcastSummary, broadcastEngagement, deleteBroadcast,
  type Broadcast, type BroadcastEngagement, type BroadcastStatus,
} from '../lib/broadcastService';

interface BroadcastRow {
  id: string;
  name: string;
  subject: string | null;
  date: string;
  status: BroadcastStatus;
  sentCount: number;              // total emails sent across this broadcast's sends
  engagement?: BroadcastEngagement | null;
}

const STATUS_TONE: Record<BroadcastStatus, 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  draft: 'gray', scheduled: 'blue', sending: 'amber', sent: 'green',
  cancelling: 'amber', cancelled: 'gray', failed: 'red', paused: 'amber',
};

// --- formatting helpers (mirrors the newsletter editions table) -------------
function fmtNum(n: number): string { return n.toLocaleString(); }
function pct(n: number, d: number): string { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—'; }
function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const CellSpin = () => (
  <div className="flex justify-end">
    <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-[var(--gray-8)]" />
  </div>
);
const RightDash = () => <div className="flex justify-end text-sm text-[var(--gray-a8)]">—</div>;
const rightHeader = (label: string) => () => <div className="grow text-right">{label}</div>;

// Broadcasts don't compare to a previous send, so no trend arrow — just the
// rate + count (raw numbers), like a single newsletter edition would read.
const MetricCell = ({ pctText, count, dimPct }: { pctText: string; count: string; dimPct?: boolean }) => (
  <div className="flex items-center justify-end text-sm whitespace-nowrap">
    <span className={`font-bold ${dimPct ? 'text-[var(--gray-10)]' : 'text-[var(--gray-12)]'}`}>{pctText}</span>
    <span className="w-10 text-right text-[11px] text-[var(--gray-12)]">{count}</span>
  </div>
);

// --- expanded drilldown (mirrors the newsletter EngagementDetail, minus the
//     detection-sources panel, the git/blocks meta line, and vs-previous) -----
function EngagementDetail({ engagement }: { engagement?: BroadcastEngagement | null }) {
  const e = engagement;
  if (!e) return <div className="px-6 py-4 text-sm text-[var(--gray-a8)]">Loading engagement…</div>;
  if (e.sent === 0) return <div className="px-6 py-4 text-sm text-[var(--gray-a8)]">No send/engagement data recorded for this broadcast.</div>;

  const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex flex-col">
      <span className="text-xs text-[var(--gray-10)]">{label}</span>
      <span className="text-lg font-semibold text-[var(--gray-12)]">{value}</span>
      {sub && <span className="text-xs text-[var(--gray-10)]">{sub}</span>}
    </div>
  );
  const measured = e.human_source === 'signals-v1';
  const sourceLabel = measured
    ? 'signals-v1 (ours, per-event detection)'
    : 'estimate (calibrated from the editions we have scored)';

  return (
    <div className="bg-[var(--gray-a2)] px-6 py-4 border-t border-[var(--gray-a4)]">
      <div className="rounded-lg border border-[var(--gray-a4)] bg-[var(--color-panel-solid)] p-4">
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
          <Stat label="Sent" value={fmtNum(e.sent)} />
          <Stat label="Delivered" value={fmtNum(e.delivered)} sub={pct(e.delivered, e.sent) + ' of sent'} />
          <Stat label="Bounced" value={fmtNum(e.bounced)} sub={pct(e.bounced, e.sent)} />
          <Stat label="Opens (raw)" value={fmtNum(e.unique_opens)} sub={pct(e.unique_opens, e.delivered) + ' open rate'} />
          <Stat label="Clicks (raw)" value={fmtNum(e.unique_clicks)} sub={pct(e.unique_clicks, e.delivered) + ' CTR'} />
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--gray-a4)]">
          <div className="text-xs font-medium text-[var(--gray-11)] mb-3">Human engagement · {sourceLabel}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Human clicks" value={e.human_clicks == null ? '—' : (measured ? '' : '~') + fmtNum(e.human_clicks)} sub={e.human_clicks == null ? undefined : pct(e.human_clicks, e.delivered) + ' human CTR'} />
            <Stat label="Machine clicks" value={e.machine_clicks == null ? '—' : fmtNum(e.machine_clicks)} sub="scanners / bots" />
            <Stat label="Human opens (est.)" value={e.human_opens == null ? '—' : '~' + fmtNum(e.human_opens)} sub={e.human_opens == null ? undefined : pct(e.human_opens, e.delivered) + ' of delivered'} />
            <Stat label="Machine opens" value={e.machine_opens == null ? '—' : fmtNum(e.machine_opens)} sub="incl. Apple MPP" />
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--gray-a4)]">
          <div className="text-xs font-medium text-[var(--gray-11)] mb-3">List churn · why the sent count moves send-to-send</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Stat label="Unsubscribed" value={fmtNum(e.unsubscribed)} sub={pct(e.unsubscribed, e.sent) + ' · opt-out'} />
            <Stat label="Suppressed (bounces)" value={fmtNum(e.suppressed)} sub="removed after repeated bounces" />
            <Stat label="Total removed" value={fmtNum(e.unsubscribed + e.suppressed)} sub={pct(e.unsubscribed + e.suppressed, e.sent) + ' of sent'} />
          </div>
          <p className="mt-3 text-xs text-[var(--gray-a8)]">
            This send bounced {fmtNum(e.bounced)} ({pct(e.bounced, e.sent)}) — a delivery stat, not churn. Bounces are retried; a recipient is only removed after bouncing on several consecutive sends.
          </p>
        </div>
      </div>
    </div>
  );
}

const columnHelper = createColumnHelper<BroadcastRow>();

export function BroadcastsTable({ broadcasts, onDeleted }: { broadcasts: Broadcast[]; onDeleted?: () => void }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<BroadcastRow[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [pendingDelete, setPendingDelete] = useState<BroadcastRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const base: BroadcastRow[] = broadcasts.map((b) => {
      const { status, latest } = broadcastSummary(b);
      const date = latest?.completed_at || latest?.started_at || latest?.scheduled_at || b.created_at;
      const sentCount = (b.sends || []).reduce((n, s) => n + (s.sent_count || 0), 0);
      return { id: b.id, name: b.name, subject: b.subject, date, status, sentCount };
    });
    setRows(base);

    // Engagement in the background (heavy joins) — merge in as it arrives.
    const ids = base.map((r) => r.id);
    const CHUNK = 10;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      broadcastEngagement(chunk)
        .then((eng) => {
          const byId = new Map(eng.map((r) => [r.broadcast_id, r]));
          setRows((prev) => prev.map((r) => (byId.has(r.id) ? { ...r, engagement: byId.get(r.id) } : r)));
        })
        .catch((err) => console.error('broadcast engagement load failed:', err));
    }
  }, [broadcasts]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteBroadcast(pendingDelete.id);
      setRows((prev) => prev.filter((r) => r.id !== pendingDelete.id));
      toast.success('Broadcast deleted');
      setPendingDelete(null);
      onDeleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete broadcast');
    } finally {
      setDeleting(false);
    }
  };

  const columns = useMemo(() => [
    columnHelper.display({
      id: 'expander',
      size: 44,
      cell: ({ row }) => (
        <button
          onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
          className="p-1 text-[var(--gray-9)] hover:text-[var(--gray-12)]"
          title={row.getIsExpanded() ? 'Collapse' : 'Expand stats'}
        >
          {row.getIsExpanded() ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
        </button>
      ),
    }),
    columnHelper.accessor('date', {
      header: 'Date',
      size: 130,
      cell: (info) => <span className="text-sm text-[var(--gray-12)] whitespace-nowrap">{formatDate(info.getValue())}</span>,
    }),
    columnHelper.accessor('subject', {
      header: 'Subject',
      cell: (info) => {
        const row = info.row.original;
        const text = info.getValue() || row.name;
        return <span className="text-sm text-[var(--gray-12)] truncate max-w-md block">{text || <span className="italic text-[var(--gray-9)]">No subject</span>}</span>;
      },
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      size: 110,
      cell: (info) => {
        const v = info.getValue();
        return <Badge color={STATUS_TONE[v]}>{v.charAt(0).toUpperCase() + v.slice(1)}</Badge>;
      },
    }),
    columnHelper.accessor((r) => r.engagement?.sent ?? -1, {
      id: 'sent',
      header: rightHeader('Sent'),
      size: 90,
      cell: (info) => {
        const e = info.row.original.engagement;
        if (e === undefined) return <CellSpin />;
        if (!e || e.sent === 0) return <RightDash />;
        return <div className="text-sm text-right font-medium text-[var(--gray-12)]">{fmtNum(e.sent)}</div>;
      },
    }),
    columnHelper.accessor((r) => r.engagement?.human_opens ?? -1, {
      id: 'human_opens',
      header: rightHeader('Opens (human)'),
      size: 130,
      cell: (info) => {
        const e = info.row.original.engagement;
        if (e === undefined) return <CellSpin />;
        if (!e || e.sent === 0 || e.human_opens == null) return <RightDash />;
        return <MetricCell pctText={'~' + pct(e.human_opens, e.delivered)} count={fmtNum(e.human_opens)} dimPct />;
      },
    }),
    columnHelper.accessor((r) => r.engagement?.human_clicks ?? -1, {
      id: 'human_clicks',
      header: rightHeader('Clicks (human)'),
      size: 130,
      cell: (info) => {
        const e = info.row.original.engagement;
        if (e === undefined) return <CellSpin />;
        if (!e || e.sent === 0 || e.human_clicks == null) return <RightDash />;
        const measured = e.human_source === 'signals-v1';
        return <MetricCell pctText={(measured ? '' : '~') + pct(e.human_clicks, e.delivered)} count={fmtNum(e.human_clicks)} />;
      },
    }),
    columnHelper.display({
      id: 'actions',
      size: 44,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); setPendingDelete(row.original); }}
            className="p-1 text-[var(--gray-9)] hover:text-[var(--red-9)]"
            title="Delete broadcast"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      ),
    }),
  ], []);

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (r) => r.id,
    state: { expanded },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const sentAlready = !!pendingDelete
    && (pendingDelete.sentCount > 0
      || pendingDelete.status === 'sent'
      || pendingDelete.status === 'sending'
      || pendingDelete.status === 'cancelling'
      || pendingDelete.status === 'paused');

  return (
    <>
      <DataTable
        table={table}
        onRowDoubleClick={(r) => navigate(`/broadcasts/${r.id}`)}
        renderSubComponent={(row: Row<BroadcastRow>) => <EngagementDetail engagement={row.original.engagement} />}
      />

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => !deleting && setPendingDelete(null)} />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-[var(--color-surface)] border border-[var(--gray-a5)] shadow-xl p-5">
            <h2 className="text-base font-semibold text-[var(--gray-12)]">Delete broadcast?</h2>
            <p className="mt-2 text-sm text-[var(--gray-11)]">
              <span className="font-medium text-[var(--gray-12)]">{pendingDelete.subject || pendingDelete.name || 'This broadcast'}</span> will be permanently deleted.
            </p>
            {sentAlready ? (
              <div className="mt-3 rounded-md border border-[var(--red-a6)] bg-[var(--red-a2)] px-3 py-2 text-xs text-[var(--red-11)]">
                This broadcast has already been sent{pendingDelete.sentCount > 0 ? ` to ${pendingDelete.sentCount.toLocaleString()} recipient${pendingDelete.sentCount === 1 ? '' : 's'}` : ''}. Deleting it also removes its send history, replies, and engagement data. This cannot be undone.
              </div>
            ) : (
              <p className="mt-1 text-xs text-[var(--gray-9)]">This cannot be undone.</p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outlined" onClick={() => setPendingDelete(null)} disabled={deleting}>Cancel</Button>
              <Button variant="solid" color="red" onClick={confirmDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default BroadcastsTable;
