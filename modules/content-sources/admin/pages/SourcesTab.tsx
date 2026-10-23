import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  EllipsisHorizontalIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, Modal, Skeleton, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { AddSourceDrawer } from '../components/AddSourceDrawer';
import {
  distinctFoundations,
  listSources,
  patchSource,
  resolveSite,
  runAll,
  runSource,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  type DiscoverySource,
  type FeedCandidate,
  type SourceKind,
  type SourceStatus,
} from '../utils/discoveryService';

const STALE_DAYS = 90;
const FAILURE_THRESHOLD = 3;
const COLUMN_COUNT = 10;

const inputClass =
  'px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

// ── helpers ────────────────────────────────────────────────────────────────

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs) {
      const v = Math.round(diffSec / secs);
      return rtf ? rtf.format(v, unit) : `${Math.abs(v)} ${unit}${Math.abs(v) === 1 ? '' : 's'} ${v < 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'just now';
}

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 86400000;
}

function truncateUrl(url: string, max = 48): string {
  const bare = url.replace(/^https?:\/\//, '');
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

function statusColor(s: SourceStatus): 'success' | 'warning' | 'neutral' | 'error' {
  switch (s) {
    case 'active': return 'success';
    case 'pending': return 'warning';
    case 'paused': return 'neutral';
    case 'dead': return 'error';
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── row action menu ────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: 'danger';
  disabled?: boolean;
}

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <Button
        variant="ghost"
        size="1"
        isIcon
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EllipsisHorizontalIcon className="size-4" aria-hidden="true" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-md border border-[var(--gray-a6)] bg-[var(--color-panel-solid)] shadow-lg py-1"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--gray-a3)] disabled:opacity-50 disabled:cursor-not-allowed ${item.tone === 'danger' ? 'text-[var(--red-11)]' : 'text-[var(--gray-12)]'}`}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── the tab ────────────────────────────────────────────────────────────────

export default function SourcesTab() {
  const [rows, setRows] = useState<DiscoverySource[]>([]);
  const [allFoundations, setAllFoundations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<SourceStatus | ''>('');
  const [foundationFilter, setFoundationFilter] = useState('');
  const [search, setSearch] = useState('');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<DiscoverySource | null>(null);

  const [deadTarget, setDeadTarget] = useState<DiscoverySource | null>(null);
  const [deadReason, setDeadReason] = useState('');

  const [probeTarget, setProbeTarget] = useState<DiscoverySource | null>(null);
  const [probeResult, setProbeResult] = useState<{ candidates: FeedCandidate[]; errors: string[] } | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listSources({ status: statusFilter, foundation: foundationFilter, q: search });
      setRows(data);
      // The foundation select lists every foundation, not only the filtered set.
      if (!statusFilter && !foundationFilter && !search.trim()) {
        setAllFoundations(distinctFoundations(data));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, foundationFilter, search]);

  // Debounce the free-text search a little; the other filters apply at once.
  useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  // Filters start empty, so the first load is unfiltered and fills allFoundations;
  // merging the current rows covers anything added since.
  const foundations = useMemo(() => {
    const merged = new Set([...allFoundations, ...distinctFoundations(rows)]);
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  }, [allFoundations, rows]);

  const now = Date.now();

  function replaceRow(updated: DiscoverySource) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === updated.id);
      if (i === -1) return [...rs, updated];
      const next = rs.slice();
      next[i] = updated;
      return next;
    });
  }

  async function mutate(s: DiscoverySource, body: Parameters<typeof patchSource>[1], okMsg: string) {
    setBusyId(s.id);
    try {
      const updated = await patchSource(s.id, body);
      replaceRow(updated);
      toast.success(okMsg);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onRunSource(s: DiscoverySource) {
    setBusyId(s.id);
    try {
      const r = await runSource(s.id);
      toast.success(`Run queued for ${s.project} (job #${r.job_id})`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onRunAll() {
    setRunningAll(true);
    try {
      const r = await runAll();
      toast.success(`Run queued for every active source (job #${r.job_id})`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunningAll(false);
    }
  }

  async function confirmDead() {
    if (!deadTarget) return;
    const reason = deadReason.trim();
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `[${stamp}] marked dead${reason ? `: ${reason}` : ''}`;
    const note = deadTarget.note ? `${deadTarget.note}\n${line}` : line;
    const target = deadTarget;
    setDeadTarget(null);
    setDeadReason('');
    await mutate(target, { status: 'dead', note }, `${target.project} marked dead`);
  }

  async function openProbe(s: DiscoverySource) {
    setProbeTarget(s);
    setProbeResult(null);
    setProbeError(null);
    setProbing(true);
    try {
      const r = await resolveSite(s.site_url);
      setProbeResult({ candidates: r.candidates, errors: r.errors ?? [] });
    } catch (e) {
      setProbeError(errorMessage(e));
    } finally {
      setProbing(false);
    }
  }

  async function adoptCandidate(c: FeedCandidate) {
    if (!probeTarget) return;
    const kind: SourceKind = (SOURCE_KINDS as readonly string[]).includes(c.kind) ? (c.kind as SourceKind) : 'feed';
    const target = probeTarget;
    setProbeTarget(null);
    await mutate(target, { feed_url: c.feed_url, kind }, `${target.project} now reads ${truncateUrl(c.feed_url)}`);
  }

  function openAdd() {
    setEditing(null);
    setDrawerOpen(true);
  }

  function openEdit(s: DiscoverySource) {
    setEditing(s);
    setDrawerOpen(true);
  }

  function onSaved(s: DiscoverySource) {
    replaceRow(s);
    toast.success(editing ? `${s.project} updated` : `${s.project} added (${s.status})`);
    void load();
  }

  const hasFilters = Boolean(statusFilter || foundationFilter || search.trim());

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Discovery sources</h2>
          <p className="text-sm text-[var(--gray-11)]">
            Feeds and sites the scraper sweeps. New posts land in the Content Inbox as pending review.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onRunAll} disabled={runningAll}>
            <ArrowPathIcon className={`size-4 ${runningAll ? 'animate-spin' : ''}`} aria-hidden="true" />
            {runningAll ? 'Queuing…' : 'Run all now'}
          </Button>
          <Button onClick={openAdd}>
            <PlusIcon className="size-4" aria-hidden="true" />
            Add source
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="discovery-filter-status">Status</label>
        <select
          id="discovery-filter-status"
          className={inputClass}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SourceStatus | '')}
        >
          <option value="">All statuses</option>
          {SOURCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <label className="sr-only" htmlFor="discovery-filter-foundation">Foundation</label>
        <select
          id="discovery-filter-foundation"
          className={inputClass}
          value={foundationFilter}
          onChange={(e) => setFoundationFilter(e.target.value)}
        >
          <option value="">All foundations</option>
          {foundations.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>

        <label className="sr-only" htmlFor="discovery-filter-search">Search</label>
        <input
          id="discovery-filter-search"
          type="search"
          className={`${inputClass} min-w-[16rem]`}
          placeholder="Search project, foundation, URL, note"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {hasFilters && (
          <Button variant="ghost" size="1" onClick={() => { setStatusFilter(''); setFoundationFilter(''); setSearch(''); }}>
            Clear filters
          </Button>
        )}

        {!loading && (
          <span className="ml-auto text-xs text-[var(--gray-10)]">
            {rows.length} source{rows.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 p-3 rounded-md border border-[var(--red-a6)] bg-[var(--red-a3)] text-sm text-[var(--red-11)]">
          <span>Could not load sources: {error}</span>
          <Button variant="outline" size="1" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      <Card variant="surface" className="p-0 overflow-hidden">
        <Table>
          <THead>
            <Tr>
              <Th>Project</Th>
              <Th>Foundation</Th>
              <Th>Kind</Th>
              <Th>Feed URL</Th>
              <Th>Status</Th>
              <Th>Last entry</Th>
              <Th>Health</Th>
              <Th>Egress</Th>
              <Th>Canary</Th>
              <Th><span className="sr-only">Actions</span></Th>
            </Tr>
          </THead>
          <TBody>
            {loading && rows.length === 0 && Array.from({ length: 5 }).map((_, i) => (
              <Tr key={`skeleton-${i}`}>
                {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
                  <Td key={j}><Skeleton><span className="inline-block h-4 w-20" /></Skeleton></Td>
                ))}
              </Tr>
            ))}

            {!loading && rows.length === 0 && !error && (
              <Tr>
                <Td colSpan={COLUMN_COUNT} className="text-center py-10 text-[var(--gray-10)]">
                  {hasFilters ? (
                    <>No sources match these filters.</>
                  ) : (
                    <>
                      <div className="text-sm text-[var(--gray-11)]">No sources yet. Add a site URL and we will find its feed.</div>
                      <div className="mt-3">
                        <Button onClick={openAdd}>
                          <PlusIcon className="size-4" aria-hidden="true" />
                          Add source
                        </Button>
                      </div>
                    </>
                  )}
                </Td>
              </Tr>
            )}

            {rows.map((s) => {
              const busy = busyId === s.id;
              const stale = s.status === 'active' && (daysSince(s.last_entry_at, now) ?? 0) > STALE_DAYS;
              const failing = s.consecutive_failures >= FAILURE_THRESHOLD;
              const isPending = s.status === 'pending';

              const menu: MenuItem[] = [
                ...(isPending ? [{ label: 'Approve', onSelect: () => void mutate(s, { status: 'active' }, `${s.project} approved`) }] : []),
                ...(s.status === 'active' ? [{ label: 'Pause', onSelect: () => void mutate(s, { status: 'paused' }, `${s.project} paused`) }] : []),
                ...(s.status === 'paused' || s.status === 'dead'
                  ? [{ label: 'Resume', onSelect: () => void mutate(s, { status: 'active' }, `${s.project} resumed`) }]
                  : []),
                ...(s.status !== 'dead'
                  ? [{ label: 'Mark dead…', tone: 'danger' as const, onSelect: () => { setDeadTarget(s); setDeadReason(''); } }]
                  : []),
                {
                  label: s.egress === 'direct' ? 'Use residential egress' : 'Use direct egress (locks)',
                  onSelect: () => void mutate(
                    s,
                    { egress: s.egress === 'direct' ? 'residential' : 'direct' },
                    `${s.project} egress set to ${s.egress === 'direct' ? 'residential' : 'direct'}`,
                  ),
                },
                {
                  label: s.egress_locked ? 'Unlock egress' : 'Lock egress',
                  onSelect: () => void mutate(s, { egress_locked: !s.egress_locked }, `${s.project} egress ${s.egress_locked ? 'unlocked' : 'locked'}`),
                },
                {
                  label: s.is_canary ? 'Clear canary' : 'Mark as canary',
                  onSelect: () => void mutate(s, { is_canary: !s.is_canary }, `${s.project} ${s.is_canary ? 'is no longer' : 'is now'} a canary`),
                },
                { label: 'Probe feed…', onSelect: () => void openProbe(s) },
                { label: 'Run now', disabled: s.status === 'dead', onSelect: () => void onRunSource(s) },
                { label: 'Edit…', onSelect: () => openEdit(s) },
              ];

              return (
                <Tr key={s.id} className={`${isPending ? 'bg-[var(--amber-a2)]' : ''} ${busy ? 'opacity-60' : ''}`}>
                  <Td>
                    <div className="font-medium">{s.project}</div>
                    <a
                      href={s.site_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[var(--gray-10)] hover:underline"
                      title={s.site_url}
                    >
                      {truncateUrl(s.site_url, 40)}
                    </a>
                    {s.note && <div className="text-xs text-[var(--gray-10)] mt-0.5 line-clamp-1" title={s.note}>{s.note}</div>}
                  </Td>
                  <Td>{s.foundation}</Td>
                  <Td><Badge variant="soft" color="neutral">{s.kind}</Badge></Td>
                  <Td>
                    {s.feed_url ? (
                      <a
                        href={s.feed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-mono hover:underline"
                        title={s.feed_url}
                      >
                        {truncateUrl(s.feed_url)}
                        <ArrowTopRightOnSquareIcon className="size-3 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="text-xs text-[var(--gray-9)]">no feed</span>
                    )}
                    {s.kind === 'sitemap' && s.path_prefix && (
                      <div className="text-xs text-[var(--gray-10)]" title={s.path_prefix}>under {truncateUrl(s.path_prefix, 36)}</div>
                    )}
                  </Td>
                  <Td><Badge variant="soft" color={statusColor(s.status)}>{s.status}</Badge></Td>
                  <Td>
                    <span title={absoluteTime(s.last_entry_at)}>{relativeTime(s.last_entry_at, now)}</span>
                    {s.last_run_at && (
                      <div className="text-xs text-[var(--gray-10)]" title={absoluteTime(s.last_run_at)}>
                        run {relativeTime(s.last_run_at, now)}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`text-xs ${s.consecutive_failures > 0 ? 'text-[var(--gray-12)]' : 'text-[var(--gray-10)]'}`}
                        title={s.last_error ?? undefined}
                      >
                        {s.consecutive_failures} fail{s.consecutive_failures === 1 ? '' : 's'}
                      </span>
                      {failing && <Badge variant="soft" color="error" title={s.last_error ?? undefined}>needs a look</Badge>}
                      {stale && <Badge variant="soft" color="warning">stale</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1 text-xs">
                      <span>{s.egress}</span>
                      {s.egress_locked && (
                        <LockClosedIcon className="size-3.5 text-[var(--gray-11)]" aria-label="egress locked by an operator" role="img" />
                      )}
                      {s.egress_auto && <Badge variant="soft" color="neutral" title="the scraper flipped this">auto</Badge>}
                    </div>
                  </Td>
                  <Td>
                    {s.is_canary ? <Badge variant="soft" color="info">canary</Badge> : <span className="text-[var(--gray-8)]">—</span>}
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      {isPending && (
                        <Button size="1" disabled={busy} onClick={() => void mutate(s, { status: 'active' }, `${s.project} approved`)}>
                          Approve
                        </Button>
                      )}
                      <Button variant="ghost" size="1" isIcon aria-label={`Edit ${s.project}`} disabled={busy} onClick={() => openEdit(s)}>
                        <PencilSquareIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <RowMenu label={`More actions for ${s.project}`} items={menu} />
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <AddSourceDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={onSaved}
        foundations={foundations}
        source={editing}
      />

      {/* Mark dead: a reason is appended to the note so the next operator knows why. */}
      <Modal
        isOpen={deadTarget !== null}
        onClose={() => setDeadTarget(null)}
        title={deadTarget ? `Mark ${deadTarget.project} dead` : 'Mark dead'}
        size="sm"
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeadTarget(null)}>Cancel</Button>
            <Button color="red" onClick={() => void confirmDead()}>Mark dead</Button>
          </div>
        )}
      >
        <p className="text-sm text-[var(--gray-11)] mb-3">
          The scraper stops sweeping this source. You can resume it later. Say why, so the reason is kept with the row.
        </p>
        <label htmlFor="discovery-dead-reason" className="block text-xs font-medium text-[var(--gray-11)] mb-1">Reason</label>
        <textarea
          id="discovery-dead-reason"
          rows={3}
          autoFocus
          className={`${inputClass} w-full`}
          placeholder="e.g. blog moved to a new domain, project archived"
          value={deadReason}
          onChange={(e) => setDeadReason(e.target.value)}
        />
      </Modal>

      {/* Probe: run the resolver against the site and show what it finds now. */}
      <Modal
        isOpen={probeTarget !== null}
        onClose={() => setProbeTarget(null)}
        title={probeTarget ? `Probe ${probeTarget.project}` : 'Probe'}
        size="lg"
        footer={(
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setProbeTarget(null)}>Close</Button>
          </div>
        )}
      >
        {probeTarget && (
          <div className="text-xs text-[var(--gray-11)] mb-3 break-all">
            Site: <span className="font-mono">{probeTarget.site_url}</span>
            {probeTarget.feed_url && (
              <>
                <br />Current feed: <span className="font-mono">{probeTarget.feed_url}</span>
              </>
            )}
          </div>
        )}
        {probing && <div className="text-sm text-[var(--gray-11)]" aria-live="polite">Checking the site and the usual feed paths…</div>}
        {probeError && (
          <div role="alert" className="p-3 rounded-md border border-[var(--red-a6)] bg-[var(--red-a3)] text-sm text-[var(--red-11)]">{probeError}</div>
        )}
        {probeResult && (
          <div className="space-y-2">
            {probeResult.candidates.length === 0 && (
              <div className="text-sm text-[var(--gray-11)]">No feed found. The site may need a sitemap or a per-site extractor.</div>
            )}
            {probeResult.candidates.map((c) => {
              const isCurrent = probeTarget?.feed_url === c.feed_url;
              return (
                <div key={c.feed_url} className="flex items-start justify-between gap-3 p-3 rounded-md border border-[var(--gray-a6)]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{c.feed_title || '(untitled feed)'}</span>
                      <Badge variant="soft" color="neutral">{c.kind}</Badge>
                      {c.cross_domain && <Badge variant="soft" color="warning">cross-domain</Badge>}
                      {c.is_root_index && <Badge variant="soft" color="neutral">root index.xml</Badge>}
                      {isCurrent && <Badge variant="soft" color="success">current</Badge>}
                    </div>
                    <div className="text-xs text-[var(--gray-11)] mt-0.5 break-all">{c.feed_url}</div>
                    <div className="text-xs text-[var(--gray-10)] mt-0.5">
                      {c.entry_count} {c.entry_count === 1 ? 'entry' : 'entries'} · newest {c.newest_entry_at ? relativeTime(c.newest_entry_at, now) : 'undated'} · via {c.found_via}
                    </div>
                  </div>
                  {!isCurrent && (
                    <Button size="1" variant="outline" onClick={() => void adoptCandidate(c)}>Use this feed</Button>
                  )}
                </div>
              );
            })}
            {probeResult.errors.length > 0 && (
              <details className="text-xs text-[var(--gray-10)]">
                <summary className="cursor-pointer">Resolver notes ({probeResult.errors.length})</summary>
                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                  {probeResult.errors.map((m, i) => <li key={i} className="break-all">{m}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
