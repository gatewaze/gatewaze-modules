/**
 * Events admin page — rebuilt on the platform listing primitives but
 * keeping the rich legacy UI (filter chips, dropdowns, composite cells,
 * preview thumbnails, action menus, bulk actions). Server-paginated via
 * useListingQuery; everything below is presentation.
 */

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { toast } from 'sonner';
import {
  ArrowPathIcon,
  CameraIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  PhotoIcon,
  PlusIcon,
  EyeIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { EventService, EventIdGenerator, type Event as EventRecord } from '@/utils/eventService';

import { Page } from '@/components/shared/Page';
import { Button } from '@/components/ui/Button';
import { Badge, Card, Pagination, PaginationFirst, PaginationItems, PaginationLast, PaginationNext, PaginationPrevious } from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { TerminalOutputModal } from '@/components/shared/TerminalOutputModal';
import { useListingQuery } from '@/components/listing';

import { eventsListingSchema } from '../../listing-schema';

type Row = Record<string, any>;

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const REGION_LABELS: Record<string, string> = {
  na: 'North America',
  eu: 'Europe',
  as: 'Asia',
  sa: 'South America',
  af: 'Africa',
  oc: 'Oceania',
  on: 'Online',
};

const SOURCE_BADGE: Record<string, { color: 'blue' | 'green' | 'purple' | 'gray'; label: string }> = {
  manual: { color: 'blue', label: 'Manual' },
  scraper: { color: 'green', label: 'Scraped' },
  user_submission: { color: 'purple', label: 'User' },
};

interface DistinctValue {
  value: string;
  count?: number;
}

function useDistinctValues(column: string) {
  const [values, setValues] = useState<DistinctValue[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const apiBase = import.meta.env.VITE_API_URL ?? '';
    fetch(`${apiBase}/api/admin/events/distinct/${encodeURIComponent(column)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setValues((body?.values as DistinctValue[]) ?? []);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [column]);
  return { values, loaded };
}

export default function EventsPage() {
  const navigate = useNavigate();

  const result = useListingQuery<Row>({
    schema: eventsListingSchema,
    endpoint: '/api/admin/events/list',
  });

  const {
    query,
    setQuery,
    rows,
    totalCount,
    totalCountEstimate,
    countStrategy,
    page,
    pageSize,
    isLoading,
    error,
    refresh,
    selection,
    isRowSelected,
    toggleRow,
    selectAllOnPage,
    clearSelection,
    selectAllMatching,
    isPageFullySelected,
  } = result;

  const filters = (query.filters ?? {}) as Record<string, any>;

  // Dropdown sources — distinct columns served by the platform endpoint.
  const eventTypeOptions = useDistinctValues('event_type');
  const sourceTypeOptions = useDistinctValues('source_type');
  const scrapedByOptions = useDistinctValues('scraped_by');
  const contentCategoryOptions = useDistinctValues('content_category');

  // ── Local mirror for snappy search ─────────────────────────────────────
  const [searchDraft, setSearchDraft] = useState(query.search ?? '');
  useEffect(() => setSearchDraft(query.search ?? ''), [query.search]);

  const flushSearch = () => {
    const trimmed = searchDraft.trim();
    setQuery({ search: trimmed === '' ? undefined : trimmed, page: 0 });
  };

  // ── Filter helpers ─────────────────────────────────────────────────────
  const setFilter = (key: string, value: any) => {
    const nextFilters = { ...filters };
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete nextFilters[key];
    } else {
      nextFilters[key] = value;
    }
    setQuery({ filters: nextFilters, page: 0 });
  };

  const hidePast = !!filters.endsAfter;
  const noScreenshots = filters.screenshot === 'none';

  const toggleHidePast = () =>
    setFilter('endsAfter', hidePast ? undefined : new Date().toISOString());
  const toggleNoScreenshots = () =>
    setFilter('screenshot', noScreenshots ? undefined : 'none');

  const filtersActive =
    !!query.search ||
    !!query.sort ||
    Object.keys(filters).length > 0;

  const resetAll = () => {
    setSearchDraft('');
    setQuery({ search: undefined, sort: undefined, filters: {}, page: 0 });
  };

  // ── Action handlers ────────────────────────────────────────────────────
  const openEvent = (row: Row) => row.event_id && navigate(`/events/${row.event_id}`);
  const editEvent = (row: Row) => row.event_id && navigate(`/events/${row.event_id}/edit`);

  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);

  // Screenshot generation modal state — mirrors the legacy events page UX.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalTitle, setTerminalTitle] = useState('');
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [screenshotPreviewUrl, setScreenshotPreviewUrl] = useState<string | undefined>();
  const [currentEventId, setCurrentEventId] = useState<string | undefined>();
  const [currentEventTitle, setCurrentEventTitle] = useState<string | undefined>();

  const apiBase = import.meta.env.VITE_API_URL ?? '';

  const reScrapeEvent = async (row: Row) => {
    if (!row.scrapedBy) return toast.error('No scraper info — cannot re-scrape');
    if (!row.eventLink) return toast.error('No event link — cannot re-scrape');
    setBusyRowId(String(row.id));
    try {
      // Endpoint expected to live in the scrapers module under
      // /api/scrapers/refresh-event. Note the /api prefix — the legacy
      // events page used getApiBaseUrl() which appends /api; here we
      // construct it explicitly because VITE_API_URL is the host root.
      const res = await fetch(`${apiBase}/api/scrapers/refresh-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: row.event_id, scraperName: row.scrapedBy, eventLink: row.eventLink }),
      });
      if (res.status === 404) {
        toast.error('Re-scrape endpoint not implemented yet — enable the scrapers module + add this route to enable.');
        return;
      }
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        toast.success(`"${row.eventTitle}" re-scraped`);
        refresh();
      } else {
        toast.error(`Re-scrape failed: ${out?.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Re-scrape failed');
    } finally {
      setBusyRowId(null);
    }
  };

  const generateScreenshot = async (row: Row) => {
    if (!row.event_id || !row.eventLink) return toast.error('No event link — cannot screenshot');
    if (row.scrapedBy === 'Luma iCal Scraper')
      return toast.warning('Luma events use images from their pages, not screenshots');

    // Open the terminal modal up-front — same UX as the legacy events page.
    setBusyRowId(String(row.id));
    setCurrentEventId(String(row.event_id));
    setCurrentEventTitle(String(row.eventTitle ?? ''));
    setTerminalTitle(`Generating Screenshot — ${row.eventTitle ?? row.event_id}`);
    setTerminalOutput([]);
    setScreenshotPreviewUrl(row.screenshotUrl ? String(row.screenshotUrl) : `/preview/${row.event_id}.jpg`);
    setTerminalOpen(true);
    setTerminalRunning(true);

    try {
      const { ScreenshotService } = await import('@/utils/screenshotService');
      ScreenshotService.generateScreenshotWithStream(String(row.event_id), {
        onProgress: (line: string) => setTerminalOutput((prev) => [...prev, line]),
        onComplete: (result: { success: boolean; error?: string }) => {
          setTerminalRunning(false);
          if (result.success) {
            setTerminalOutput((prev) => [...prev, '', '✅ Screenshot generation completed successfully!']);
            refresh();
          } else {
            setTerminalOutput((prev) => [...prev, '', `❌ Screenshot generation failed: ${result.error ?? 'unknown'}`]);
          }
          setBusyRowId(null);
        },
        onError: (err: string) => {
          setTerminalRunning(false);
          setTerminalOutput((prev) => [...prev, '', `❌ Error: ${err}`]);
          setBusyRowId(null);
        },
      });
    } catch (err) {
      setTerminalRunning(false);
      setTerminalOutput((prev) => [...prev, '', `❌ Unexpected error: ${err instanceof Error ? err.message : String(err)}`]);
      setBusyRowId(null);
    }
  };

  const duplicateEvent = async (row: Row) => {
    setBusyRowId(String(row.id));
    try {
      // Fetch the full event so we copy every field, then write it back
      // with a fresh event_id and "(Copy)" suffix. The full record lives
      // behind getEventById since the listing only returns admin
      // projection columns.
      const full = await EventService.getEventById(String(row.id));
      if (!full.success || !full.data) {
        return toast.error(`Could not fetch event: ${full.error ?? 'unknown'}`);
      }
      const src = full.data;
      const newEventId = await EventIdGenerator.generateUniqueEventId();
      const copy: Omit<EventRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        ...src,
        eventId: newEventId,
        eventTitle: `${src.eventTitle} (Copy)`,
      };
      delete (copy as { id?: string }).id;
      const create = await EventService.createEvent(copy);
      if (create.success) {
        toast.success('Event duplicated');
        refresh();
      } else {
        toast.error(`Duplicate failed: ${create.error ?? 'unknown'}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Duplicate failed');
    } finally {
      setBusyRowId(null);
    }
  };

  const deleteEvent = async (row: Row) => {
    if (!row.id) return;
    if (!confirm(`Delete "${row.eventTitle}"? This cannot be undone.`)) return;
    setBusyRowId(String(row.id));
    try {
      const res = await EventService.deleteEvent(String(row.id));
      if (res.success) {
        toast.success('Event deleted');
        refresh();
      } else {
        toast.error(`Delete failed: ${res.error ?? 'unknown'}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyRowId(null);
    }
  };

  const handleBulkDelete = async () => {
    const matchingMode = selection.mode === 'matchingFilter';
    const message = matchingMode
      ? `Delete ALL ${selection.count.toLocaleString()} events matching this filter? This cannot be undone.`
      : `Delete ${selection.ids.size} selected event(s)? This cannot be undone.`;
    if (!confirm(message)) return;
    setBulkDeleting(true);
    const apiBase = import.meta.env.VITE_API_URL ?? '';
    const body = matchingMode
      ? { matchingFilter: { ...query, page: 0, pageSize: 5000 } }
      : { ids: Array.from(selection.ids) };
    try {
      const res = await fetch(`${apiBase}/api/admin/events/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(out?.error?.message ?? `Delete failed (${res.status})`);
      } else {
        toast.success(`Deleted ${out.deleted ?? 0} event(s)`);
        clearSelection();
        refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  // ── tanstack columns — composite cells matching legacy UI ──────────────
  const columns = useMemo(() => {
    const helper = createColumnHelper<Row>();
    return [
      // Selection checkbox
      helper.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            checked={isPageFullySelected}
            ref={(el) => {
              if (el) {
                const partial = !isPageFullySelected && selection.ids.size > 0;
                el.indeterminate = partial;
              }
            }}
            onChange={selectAllOnPage}
            className="rounded border-[var(--gray-a6)] text-[var(--accent-9)] focus:ring-[var(--accent-8)]"
          />
        ),
        size: 44,
        cell: ({ row }) => {
          const id = String(row.original.id ?? '');
          if (!id) return <div className="w-4 h-4" />;
          return (
            <input
              type="checkbox"
              checked={isRowSelected(id)}
              onChange={(e) => {
                e.stopPropagation();
                toggleRow(id);
              }}
              onClick={(e) => e.stopPropagation()}
              className="rounded border-[var(--gray-a6)] text-[var(--accent-9)] focus:ring-[var(--accent-8)]"
            />
          );
        },
      }),

      // Preview thumbnail
      helper.display({
        id: 'preview',
        header: 'Preview',
        size: 120,
        cell: ({ row }) => {
          const r = row.original;
          const src = (r.eventLogo || r.screenshotUrl) as string | undefined;
          if (!src) {
            return (
              <div className="w-[100px] h-[60px] rounded-md bg-[var(--gray-a4)] flex items-center justify-center text-[var(--gray-a8)]">
                <PhotoIcon className="size-5" />
              </div>
            );
          }
          return (
            <img
              src={src}
              alt={String(r.eventTitle ?? '')}
              loading="lazy"
              className="w-[100px] h-[60px] object-cover rounded-md bg-[var(--gray-a3)]"
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
            />
          );
        },
      }),

      helper.accessor('eventTitle', {
        header: 'Event',
        size: 350,
        enableSorting: true,
        cell: ({ row }) => {
          const r = row.original;
          let host = '';
          if (r.eventLink) {
            try { host = new URL(String(r.eventLink)).hostname; } catch { /* ignore */ }
          }
          return (
            <div className="flex items-center gap-3 max-w-[350px]">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[var(--gray-12)] truncate">
                  {r.eventTitle}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs font-mono text-[var(--gray-11)] bg-[var(--gray-a3)] px-2 py-0.5 rounded-md">
                    {r.event_id}
                  </span>
                </div>
                {r.eventLink && (
                  <a
                    href={r.eventLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 mt-1.5 text-xs text-[var(--gray-a8)] hover:text-[var(--accent-11)]"
                  >
                    <GlobeAltIcon className="size-3" />
                    <span className="truncate max-w-[180px]">{host || r.eventLink}</span>
                  </a>
                )}
              </div>
            </div>
          );
        },
      }),

      helper.display({
        id: 'location',
        header: 'Location',
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-start gap-2">
              <MapPinIcon className="w-4 h-4 text-[var(--gray-a8)] mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-12)]">
                  {r.eventCity}
                  {r.eventCountryCode && (
                    <span className="ml-1 text-[var(--gray-11)] font-normal">{r.eventCountryCode}</span>
                  )}
                </div>
                {r.eventRegion && (
                  <div className="text-xs text-[var(--gray-a8)] mt-0.5">
                    {REGION_LABELS[String(r.eventRegion)] ?? r.eventRegion}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),

      helper.accessor('eventStart', {
        header: 'Date',
        enableSorting: true,
        cell: ({ row }) => {
          const r = row.original;
          const startDate = r.eventStart ? new Date(r.eventStart) : null;
          const endDate = r.eventEnd ? new Date(r.eventEnd) : null;
          const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const isPast = endDate ? endDate.getTime() < Date.now() : false;
          const isSameDay = startDate && endDate && startDate.toDateString() === endDate.toDateString();
          return (
            <div className="flex flex-col gap-0.5 whitespace-nowrap">
              <span className={`text-sm ${isPast ? 'text-[var(--gray-a8)]' : 'text-[var(--gray-12)]'}`}>
                {startDate ? fmt(startDate) : 'N/A'}
              </span>
              {endDate && !isSameDay && (
                <span className={`text-xs ${isPast ? 'text-[var(--gray-a8)]' : 'text-[var(--gray-a11)]'}`}>
                  to {fmt(endDate)}
                </span>
              )}
              {isPast && <Badge color="gray" variant="soft">Past</Badge>}
            </div>
          );
        },
      }),

      helper.accessor('eventType', {
        header: 'Type',
        enableSorting: true,
        cell: ({ row }) => {
          const v = row.original.eventType;
          if (!v) return <span className="text-xs text-[var(--gray-a8)]">—</span>;
          return <Badge color="gray" variant="soft" className="capitalize">{String(v)}</Badge>;
        },
      }),

      helper.accessor('sourceType', {
        header: 'Source',
        enableSorting: true,
        cell: ({ row }) => {
          const v = row.original.sourceType;
          const meta = SOURCE_BADGE[String(v)] ?? { color: 'gray' as const, label: 'Unknown' };
          return <Badge color={meta.color} variant="soft">{meta.label}</Badge>;
        },
      }),

      helper.accessor('sourceEventId', {
        header: 'Source Event ID',
        cell: ({ row }) => {
          const v = row.original.sourceEventId;
          if (!v) return <span className="text-xs text-[var(--gray-a8)]">—</span>;
          return (
            <span
              className="text-xs font-mono text-[var(--gray-11)] bg-[var(--gray-a3)] px-2 py-0.5 rounded-md max-w-[120px] truncate inline-block"
              title={String(v)}
            >
              {String(v)}
            </span>
          );
        },
      }),

      helper.display({
        id: 'registrations',
        header: 'Registrations',
        cell: ({ row }) => {
          const arr = row.original.events_registrations as Array<{ count: number }> | undefined;
          const count = arr?.[0]?.count ?? 0;
          return <Badge color={count > 0 ? 'green' : 'gray'} variant="soft">{count}</Badge>;
        },
      }),

      helper.display({
        id: '__actions__',
        header: '',
        cell: ({ row }) => {
          const r = row.original;
          const busy = busyRowId === String(r.id);
          return (
            <div className="flex justify-end">
              <RowActions
                actions={[
                  {
                    label: 'View/Edit',
                    icon: <EyeIcon className="size-4" />,
                    onClick: () => openEvent(r),
                  },
                  {
                    label: 'Re-scrape',
                    icon: <ArrowPathIcon className="size-4" />,
                    onClick: () => reScrapeEvent(r),
                    disabled: busy || !r.eventLink,
                    hidden: !r.scrapedBy,
                  },
                  {
                    label: 'Screenshot',
                    icon: <CameraIcon className="size-4" />,
                    onClick: () => generateScreenshot(r),
                    disabled: busy || !r.eventLink,
                  },
                  {
                    label: 'Duplicate',
                    icon: <DocumentDuplicateIcon className="size-4" />,
                    onClick: () => duplicateEvent(r),
                    disabled: busy,
                  },
                  {
                    label: 'Delete',
                    icon: <TrashIcon className="size-4" />,
                    color: 'red',
                    onClick: () => deleteEvent(r),
                    disabled: busy,
                  },
                ]}
              />
            </div>
          );
        },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPageFullySelected, selection.ids.size, busyRowId]);

  const sorting: SortingState = useMemo(
    () => (query.sort ? [{ id: query.sort.column, desc: query.sort.direction === 'desc' }] : []),
    [query.sort]
  );

  const pageCount = totalCount !== null ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

  const table = useReactTable<Row>({
    data: rows,
    columns,
    state: { sorting, pagination: { pageIndex: page, pageSize } },
    pageCount,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (next.length === 0) return setQuery({ sort: undefined, page: 0 });
      const first = next[0];
      setQuery({ sort: { column: first.id, direction: first.desc ? 'desc' : 'asc' }, page: 0 });
    },
    onPaginationChange: (updater) => {
      const prev = { pageIndex: page, pageSize };
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const patch: { page?: number; pageSize?: number } = {};
      if (next.pageIndex !== prev.pageIndex) patch.page = next.pageIndex;
      if (next.pageSize !== prev.pageSize) {
        patch.pageSize = next.pageSize;
        patch.page = 0;
      }
      if (Object.keys(patch).length > 0) setQuery(patch);
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const totalDisplay = totalCount ?? totalCountEstimate ?? 0;
  const totalPrefix = countStrategy === 'estimated' || countStrategy === 'planned' ? '~' : '';
  const fromRow = page * pageSize + 1;
  const toRow = page * pageSize + rows.length;

  // Selection-banner helpers
  const showSelectAllPrompt =
    selection.mode === 'page' &&
    isPageFullySelected &&
    totalCount !== null &&
    totalCount > rows.length;

  return (
    <Page title="Events">
      <div className="p-6 space-y-4">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Events</h1>
            <p className="text-sm text-[var(--gray-11)] mt-1">
              <span className="font-semibold text-[var(--accent-11)]">
                {totalPrefix}{totalDisplay.toLocaleString()}
              </span>{' '}
              events
              {filtersActive && (
                <>
                  {' · '}
                  <span className="font-semibold text-[var(--accent-11)]">{rows.length.toLocaleString()}</span>{' '}
                  on this page
                </>
              )}
            </p>
          </div>
          <Button onClick={() => navigate('/events/new')} variant="solid">
            <PlusIcon className="size-4" />
            Add Event
          </Button>
        </div>

        {/* ── Filter bar ────────────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <MagnifyingGlassIcon className="size-4 text-[var(--gray-a8)]" />
            </div>
            <input
              type="text"
              placeholder="Search events..."
              value={searchDraft}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && flushSearch()}
              onBlur={flushSearch}
              className="w-full pl-9 pr-3 py-1.5 text-sm bg-[var(--gray-a3)] border border-[var(--gray-a5)] rounded-lg text-[var(--gray-12)] placeholder-[var(--gray-a8)] focus:ring-2 focus:ring-[var(--accent-8)] focus:border-transparent"
            />
          </div>

          <FilterDropdown
            label="Event Type"
            value={singular(filters.eventType)}
            onChange={(v) => setFilter('eventType', v ? [v] : undefined)}
            options={eventTypeOptions.values}
            loading={!eventTypeOptions.loaded}
            capitalize
          />

          <FilterDropdown
            label="Source"
            value={singular(filters.sourceType)}
            onChange={(v) => setFilter('sourceType', v ? [v] : undefined)}
            options={sourceTypeOptions.values}
            loading={!sourceTypeOptions.loaded}
            renderLabel={(v) => SOURCE_BADGE[v]?.label ?? v}
          />

          <FilterDropdown
            label="Scraper"
            value={singular(filters.scrapedBy)}
            onChange={(v) => setFilter('scrapedBy', v ? [v] : undefined)}
            options={scrapedByOptions.values}
            loading={!scrapedByOptions.loaded}
          />

          {contentCategoryOptions.values.length > 0 && (
            <FilterDropdown
              label="Category"
              value={singular(filters.contentCategory)}
              onChange={(v) => setFilter('contentCategory', v ? [v] : undefined)}
              options={contentCategoryOptions.values}
              loading={!contentCategoryOptions.loaded}
              capitalize
            />
          )}

          <div className="flex items-center gap-1.5">
            <Button
              size="1"
              variant={hidePast ? 'soft' : 'ghost'}
              color={hidePast ? 'orange' : 'gray'}
              onClick={toggleHidePast}
            >
              <ClockIcon className="size-3.5" />
              Hide past
            </Button>
            <Button
              size="1"
              variant={noScreenshots ? 'soft' : 'ghost'}
              color={noScreenshots ? undefined : 'gray'}
              onClick={toggleNoScreenshots}
            >
              <PhotoIcon className="size-3.5" />
              No screenshots
            </Button>
          </div>

          {filtersActive && (
            <Button size="1" variant="ghost" color="gray" onClick={resetAll}>
              Reset
            </Button>
          )}
        </div>

        {/* ── Selection banner ────────────────────────────────── */}
        {selection.count > 0 && (
          <div className="flex items-center gap-3 rounded-md border border-[var(--accent-a6)] bg-[var(--accent-a3)] px-4 py-2 text-sm">
            <span className="text-[var(--accent-11)] font-medium">
              {selection.mode === 'matchingFilter'
                ? `All ${selection.count.toLocaleString()} matching events selected`
                : `${selection.count.toLocaleString()} selected`}
            </span>
            {showSelectAllPrompt && (
              <Button size="1" variant="soft" onClick={selectAllMatching}>
                Select all {totalDisplay.toLocaleString()} matching the filter
              </Button>
            )}
            <Button size="1" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button size="1" color="red" variant="soft" onClick={handleBulkDelete} disabled={bulkDeleting}>
                <TrashIcon className="size-3.5" />
                {bulkDeleting ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Error surface ─────────────────────────────────────── */}
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            <strong>{error.code}</strong>: {error.message}
          </div>
        )}

        {/* ── Table ─────────────────────────────────────────────── */}
        <Card className="p-0 overflow-hidden">
          <DataTable
            table={table}
            loading={isLoading}
            emptyState="No events match your filters"
            onRowDoubleClick={openEvent}
          />

          {rows.length > 0 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-[var(--gray-a5)]">
              <div className="flex items-center gap-4">
                <span className="text-sm text-[var(--gray-11)]">
                  <span className="font-semibold text-[var(--gray-12)]">{fromRow.toLocaleString()}</span>
                  <span className="mx-1">-</span>
                  <span className="font-semibold text-[var(--gray-12)]">{toRow.toLocaleString()}</span>
                  <span className="mx-1">of</span>
                  <span className="font-semibold text-[var(--gray-12)]">
                    {totalPrefix}{totalDisplay.toLocaleString()}
                  </span>
                </span>
                <select
                  value={String(pageSize)}
                  onChange={(e) => setQuery({ pageSize: Number(e.target.value), page: 0 })}
                  className="px-3 py-1.5 text-sm bg-[var(--gray-a2)] border border-[var(--gray-a5)] rounded-lg focus:ring-2 focus:ring-[var(--accent-8)] cursor-pointer"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n} / page</option>
                  ))}
                </select>
              </div>

              <Pagination
                total={pageCount}
                value={page + 1}
                onChange={(nextPage) => setQuery({ page: nextPage - 1 })}
                className="flex items-center gap-1"
              >
                <PaginationFirst onClick={() => setQuery({ page: 0 })} disabled={page === 0 || isLoading} />
                <PaginationPrevious onClick={() => setQuery({ page: Math.max(0, page - 1) })} disabled={page === 0 || isLoading} />
                <PaginationItems />
                <PaginationNext onClick={() => setQuery({ page: page + 1 })} disabled={page >= pageCount - 1 || isLoading} />
                <PaginationLast onClick={() => setQuery({ page: pageCount - 1 })} disabled={page >= pageCount - 1 || isLoading} />
              </Pagination>
            </div>
          )}
        </Card>
      </div>

      {/* Screenshot generation modal — same UX as the legacy events page. */}
      <TerminalOutputModal
        isOpen={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        title={terminalTitle}
        isRunning={terminalRunning}
        output={terminalOutput}
        onClear={() => setTerminalOutput([])}
        screenshotUrl={screenshotPreviewUrl}
        eventTitle={currentEventTitle}
        showScreenshotPreview
        currentEventId={currentEventId}
      />
    </Page>
  );
}

// ----------------------------------------------------------------------------
// FilterDropdown — server-populated select with active-state styling.
// ----------------------------------------------------------------------------

function singular(v: unknown): string {
  if (Array.isArray(v)) return v[0] ? String(v[0]) : '';
  return v ? String(v) : '';
}

interface FilterDropdownProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; count?: number }>;
  loading?: boolean;
  capitalize?: boolean;
  renderLabel?: (value: string) => string;
}

function FilterDropdown({ label, value, onChange, options, loading, capitalize, renderLabel }: FilterDropdownProps) {
  const active = value !== '';
  const display = (v: string) => {
    const labelStr = renderLabel ? renderLabel(v) : v;
    return capitalize ? labelStr.charAt(0).toUpperCase() + labelStr.slice(1) : labelStr;
  };
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={loading}
      className={`px-2.5 py-1.5 text-sm rounded-lg border bg-[var(--gray-a3)] focus:ring-2 focus:ring-[var(--accent-8)] cursor-pointer ${
        active ? 'border-[var(--accent-8)] text-[var(--accent-11)]' : 'border-[var(--gray-a5)] text-[var(--gray-11)]'
      } ${capitalize ? 'capitalize' : ''}`}
    >
      <option value="">{loading ? `${label}…` : label}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {display(o.value)}
          {typeof o.count === 'number' ? ` (${o.count})` : ''}
        </option>
      ))}
    </select>
  );
}
