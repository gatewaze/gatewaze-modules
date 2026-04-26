import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import {
  inboxService,
  type InboxRow as InboxRowData,
  type InboxListFilters,
} from '../utils/inboxService';
import { InboxRow } from '../components/InboxRow';
import { InboxDrawer } from '../components/InboxDrawer';

const inputClass =
  'px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

const ALL_STATES = ['pending_review', 'auto_suppressed', 'rejected', 'published', 'unpublished', 'draft'];
const SOURCE_KINDS = ['scraper', 'ai_discovery', 'admin_ui', 'api', 'mcp', 'user_submission', 'import'];

export default function InboxPage() {
  const [rows, setRows] = useState<InboxRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<InboxListFilters>({
    publish_state: ['pending_review', 'auto_suppressed'],
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRow, setOpenRow] = useState<InboxRowData | null>(null);
  const [bulkActing, setBulkActing] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [estimatedTotal, setEstimatedTotal] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await inboxService.list({ ...filters, search: search.trim() || undefined, limit: 50 });
      setRows(r.data);
      setEstimatedTotal(r.page.estimated_total);
      setSelected(new Set());
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [filters, search]);

  useEffect(() => { load(); }, [load]);

  const setFilter = <K extends keyof InboxListFilters>(key: K, value: InboxListFilters[K]) => {
    setFilters((f) => {
      const next = { ...f };
      if (value == null || (Array.isArray(value) && value.length === 0)) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const toggleRow = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllOnPage = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.triage_item_id)));
  };

  const selectedItems = useMemo(
    () => rows.filter((r) => selected.has(r.triage_item_id))
              .map((r) => ({ triage_item_id: r.triage_item_id, lifecycle_key: r.lifecycle_key })),
    [rows, selected]
  );

  const bulk = async (action: 'approve' | 'reject' | 'reopen', params: any = {}) => {
    if (selectedItems.length === 0) return;
    if (action === 'reject') {
      const reason = prompt('Rejection reason?');
      if (!reason) return;
      params = { reason };
    }
    if (!confirm(`${action} ${selectedItems.length} item(s)?`)) return;
    setBulkActing(true);
    setBulkResult(null);
    try {
      const r = await inboxService.bulk(action, selectedItems, params);
      setBulkResult(`${action}: ${r.processed} processed, ${r.failed} failed`);
      await load();
    } catch (err: any) {
      setBulkResult(`Error: ${err.message ?? String(err)}`);
    } finally {
      setBulkActing(false);
    }
  };

  const counts = useMemo(() => {
    const c = { pending_review: 0, auto_suppressed: 0, rejected: 0 };
    for (const r of rows) {
      if (r.publish_state && r.publish_state in c) (c as any)[r.publish_state]++;
    }
    return c;
  }, [rows]);

  return (
    <Page title="Content Inbox">
      <div className="p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Content Inbox</h1>
            <p className="text-sm text-[var(--gray-11)]">
              All content awaiting review across types — events, blog, podcasts, AI-discovered, and more.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-[var(--gray-11)]">Estimated total</div>
            <div className="text-2xl font-semibold">{estimatedTotal ?? '—'}</div>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Card className="p-3 cursor-pointer" onClick={() => setFilter('publish_state', ['pending_review'])}>
            <div className="text-xs text-[var(--gray-11)]">Pending review</div>
            <div className="text-2xl font-semibold text-amber-600">{counts.pending_review}</div>
          </Card>
          <Card className="p-3 cursor-pointer" onClick={() => setFilter('publish_state', ['auto_suppressed'])}>
            <div className="text-xs text-[var(--gray-11)]">Auto-suppressed</div>
            <div className="text-2xl font-semibold text-gray-600">{counts.auto_suppressed}</div>
          </Card>
          <Card className="p-3 cursor-pointer" onClick={() => setFilter('publish_state', ['rejected'])}>
            <div className="text-xs text-[var(--gray-11)]">Rejected</div>
            <div className="text-2xl font-semibold text-red-600">{counts.rejected}</div>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <input
            className={inputClass}
            placeholder="Search title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            style={{ minWidth: 220 }}
          />
          <select
            className={inputClass}
            value={(filters.content_type ?? [''])[0] ?? ''}
            onChange={(e) => setFilter('content_type', e.target.value ? [e.target.value] : undefined)}
          >
            <option value="">All types</option>
            <option value="event">event</option>
            <option value="content_item">content_item</option>
            <option value="blog">blog</option>
            <option value="newsletter">newsletter</option>
            <option value="podcast">podcast</option>
          </select>
          <select
            className={inputClass}
            value={(filters.source_kind ?? [''])[0] ?? ''}
            onChange={(e) => setFilter('source_kind', e.target.value ? [e.target.value] : undefined)}
          >
            <option value="">All sources</option>
            {SOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select
            className={inputClass}
            value={(filters.publish_state ?? [''])[0] ?? ''}
            onChange={(e) => setFilter('publish_state', e.target.value ? [e.target.value] : undefined)}
          >
            <option value="">Pending + suppressed (default)</option>
            {ALL_STATES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={!!filters.member_only}
              onChange={(e) => setFilter('member_only', e.target.checked || undefined)}
            />
            Member only
          </label>
          <Button size="1" variant="ghost" onClick={() => { setFilters({ publish_state: ['pending_review','auto_suppressed'] }); setSearch(''); }}>
            Reset
          </Button>
        </div>

        {/* Bulk actions bar */}
        {selected.size > 0 && (
          <Card className="p-3 mb-4 bg-[var(--accent-a3)] flex items-center justify-between">
            <div className="text-sm">
              <strong>{selected.size}</strong> selected
              {selected.size === rows.length && estimatedTotal && estimatedTotal > rows.length && (
                <span className="ml-2 text-xs text-[var(--gray-11)]">
                  (page only — estimated {estimatedTotal} match the filter)
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="1" onClick={() => bulk('approve')} disabled={bulkActing}>Approve</Button>
              <Button size="1" variant="soft" color="red" onClick={() => bulk('reject')} disabled={bulkActing}>Reject</Button>
              <Button size="1" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          </Card>
        )}

        {bulkResult && (
          <div className="p-2 mb-4 bg-[var(--accent-a3)] text-sm rounded">{bulkResult}</div>
        )}

        {/* Table */}
        <Card>
          {loading ? (
            <div className="p-8 text-center text-sm text-[var(--gray-11)]">Loading…</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--gray-11)]">
              Nothing to triage. New content will appear here as scrapers, AI discovery, and submissions arrive.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-[var(--gray-a4)]">
                  <tr className="text-left text-xs text-[var(--gray-11)]">
                    <th className="px-3 py-2 w-10">
                      <input
                        type="checkbox"
                        checked={selected.size === rows.length && rows.length > 0}
                        onChange={selectAllOnPage}
                      />
                    </th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <InboxRow
                      key={r.triage_item_id}
                      row={r}
                      selected={selected.has(r.triage_item_id)}
                      onToggleSelect={() => toggleRow(r.triage_item_id)}
                      onOpenDrawer={() => setOpenRow(r)}
                      onSourceFilter={(kind) => setFilter('source_kind', [kind])}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {openRow && (
        <InboxDrawer
          row={openRow}
          onClose={() => setOpenRow(null)}
          onActed={() => { setOpenRow(null); load(); }}
        />
      )}
    </Page>
  );
}
