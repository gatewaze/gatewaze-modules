import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Tabs } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { useModuleSlots } from '@/hooks/useModuleSlots';
import { supabase } from '@/lib/supabase';
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await inboxService.list({ ...filters, search: search.trim() || undefined, limit: 50 });
      setRows(r.data);
      setNextCursor(r.page.next_cursor);
      setEstimatedTotal(r.page.estimated_total);
      setSelected(new Set());
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [filters, search]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await inboxService.list({
        ...filters, search: search.trim() || undefined, limit: 50, cursor: nextCursor,
      });
      setRows((prev) => [...prev, ...r.data]);
      setNextCursor(r.page.next_cursor);
      if (r.page.estimated_total != null) setEstimatedTotal(r.page.estimated_total);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, filters, search]);

  useEffect(() => { load(); }, [load]);

  // IntersectionObserver-driven infinite scroll: when the sentinel becomes
  // visible (within 200px of the viewport), fetch the next page.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMore(); },
      { rootMargin: '200px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

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

  // Real totals across the entire inbox, fetched independently of pagination.
  const [counts, setCounts] = useState({ pending_review: 0, auto_suppressed: 0, rejected: 0 });

  // "Reconsider rejected" signal per spec-unified-content-management §8:
  // count keyword rules added in the last 7 days. When > 0 AND there are
  // rejected items, surface a banner so the admin knows newly-added rules
  // may have changed which content should stay rejected. We don't compute
  // "exactly which 3 items would change" — that requires re-running the
  // keyword evaluation per row, which is the bidirectional re-eval system's
  // job. The banner is the operational nudge: click → filter → admin
  // reviews case-by-case.
  const [recentRulesCount, setRecentRulesCount] = useState(0);
  useEffect(() => {
    let mounted = true;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    supabase
      .from('content_keyword_rules')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo)
      .eq('is_active', true)
      .then(({ count }) => {
        if (mounted) setRecentRulesCount(count ?? 0);
      });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    let mounted = true;
    Promise.all([
      inboxService.list({ ...filters, publish_state: ['pending_review'], limit: 1 }).then((r) => r.page.estimated_total ?? 0),
      inboxService.list({ ...filters, publish_state: ['auto_suppressed'], limit: 1 }).then((r) => r.page.estimated_total ?? 0),
      inboxService.list({ ...filters, publish_state: ['rejected'], limit: 1 }).then((r) => r.page.estimated_total ?? 0),
    ]).then(([pending_review, auto_suppressed, rejected]) => {
      if (mounted) setCounts({ pending_review, auto_suppressed, rejected });
    }).catch(() => {/* leave at 0 */});
    return () => { mounted = false; };
    // Recompute when the user changes filters that affect the totals (e.g. type, source).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.content_type, filters.source_kind, filters.member_only]);

  // Inbox tabs: built-in "Triage" + any tabs registered via the
  // 'content-platform:inbox-tab' adminSlot (e.g. content-pipeline submissions).
  const extraTabs = useModuleSlots('content-platform:inbox-tab');
  const tabs = useMemo(() => [
    { id: 'triage', label: 'Triage', component: null as null | React.LazyExoticComponent<any> },
    ...extraTabs.map((s) => ({
      id: (s.registration.meta as any)?.tabId ?? s.moduleId,
      label: (s.registration.meta as any)?.label ?? s.moduleId,
      // adminSlots `component` is a () => import('...') thunk; wrap in React.lazy
      // so React can render it via Suspense.
      component: lazy(s.registration.component as () => Promise<{ default: React.ComponentType }>),
    })),
  ], [extraTabs]);
  const [activeTab, setActiveTab] = useState<string>('triage');
  const ActiveTabComp = tabs.find((t) => t.id === activeTab)?.component ?? null;

  return (
    <Page title="Content Inbox">
      <div className="p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold mb-1">Content Inbox</h1>
          <p className="text-sm text-[var(--gray-11)]">
            All content awaiting review across types — events, blog, podcasts, AI-discovered, and more.
          </p>
        </div>

        {/* Tab bar — same style as the Events dashboard (default Radix-Themes
            tabs in a bordered card wrapper). */}
        {tabs.length > 1 && (
          <div className="mb-4">
            <Tabs
              value={activeTab}
              onChange={setActiveTab}
              tabs={tabs.map((t) => ({ id: t.id, label: t.label }))}
            />
          </div>
        )}

        {/* Non-triage tabs render the slot's component and stop here */}
        {ActiveTabComp && activeTab !== 'triage' ? (
          <Suspense fallback={<div className="p-8 text-center text-sm text-[var(--gray-11)]">Loading…</div>}>
            <ActiveTabComp />
          </Suspense>
        ) : (<>

        {/* "Reconsider rejected" banner per spec §8. Shown when there are
            both rejected items AND keyword rules added/updated in the last
            7 days — the rules change might justify reviewing previously-
            rejected content. Click filters to rejected; admin reviews
            case-by-case. */}
        {counts.rejected > 0 && recentRulesCount > 0 && (
          <Card className="p-3 mb-4 border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-950/20">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-[var(--gray-12)]">
                <strong>{recentRulesCount}</strong> keyword rule{recentRulesCount === 1 ? '' : 's'} added in the last 7 days.{' '}
                <strong>{counts.rejected}</strong> rejected item{counts.rejected === 1 ? '' : 's'} may now match.
                Worth re-reviewing.
              </div>
              <Button
                size="2"
                variant="soft"
                onClick={() => setFilter('publish_state', ['rejected'])}
              >
                Review rejected
              </Button>
            </div>
          </Card>
        )}

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
            <option value="">Pending review (default)</option>
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
                    <th className="px-3 py-2">Matched</th>
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
              {/* Infinite-scroll sentinel + status footer */}
              <div ref={sentinelRef} className="px-3 py-3 text-center text-xs text-[var(--gray-11)]">
                {loadingMore
                  ? 'Loading more…'
                  : nextCursor
                    ? `Loaded ${rows.length} of ${estimatedTotal ?? '?'}…`
                    : rows.length === (estimatedTotal ?? rows.length)
                      ? `All ${rows.length} loaded`
                      : ''}
              </div>
            </div>
          )}
        </Card>
        </>)}
      </div>

      {openRow && (() => {
        const idx = rows.findIndex((r) => r.triage_item_id === openRow.triage_item_id);
        const prev = idx > 0 ? rows[idx - 1] : null;
        const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;
        const total = estimatedTotal ?? rows.length;
        // If we're on the last loaded row but more pages exist, the drawer's
        // Next button triggers a page-load and re-resolves to the next row
        // when the new rows arrive.
        const handleNext = next
          ? () => setOpenRow(next)
          : (nextCursor
              ? async () => { await loadMore(); }  // setOpenRow will resolve after rows update
              : undefined);
        return (
          <InboxDrawer
            row={openRow}
            onClose={() => setOpenRow(null)}
            onActed={() => {
              if (next) {
                setOpenRow(next);
                load();
              } else if (nextCursor) {
                loadMore().then(() => {/* user can hit Next once rows arrive */});
                setOpenRow(null);
              } else {
                setOpenRow(null);
                load();
              }
            }}
            onPrev={prev ? () => setOpenRow(prev) : undefined}
            onNext={handleNext}
            position={idx >= 0 ? { current: idx, total } : undefined}
          />
        );
      })()}
    </Page>
  );
}
