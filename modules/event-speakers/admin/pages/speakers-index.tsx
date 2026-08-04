import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { MagnifyingGlassIcon, MicrophoneIcon } from '@heroicons/react/24/outline';
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Input,
  Select,
  Button,
  Badge,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { EventService } from '../../../events/admin/utils/eventService';
import {
  SpeakersRollupService,
  type SpeakerDirectoryRow,
} from '../services/speakersRollupService';
import {
  DEFAULT_SPEAKER_SORT,
  buildSpeakerListingQuery,
  defaultDirectionFor,
  type SpeakerSortColumn,
} from '../services/speakerListingQuery';

const columnHelper = createColumnHelper<SpeakerDirectoryRow>();

/** Sentinel for the "no event filter" option — an empty <option> value. */
const ALL_EVENTS = '';

type EventOption = { id: string; label: string };

export default function SpeakersIndexPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ---- URL is the source of truth for every listing input -------------------
  // Normalised through the same helper the service uses, so what the pager and
  // the sort arrows display can't drift from what was actually queried.
  const { sort, direction, page, pageSize, eventId: validEventId } = buildSpeakerListingQuery({
    sort: searchParams.get('sort'),
    dir: searchParams.get('dir'),
    page: searchParams.get('page'),
    pageSize: searchParams.get('pageSize'),
    eventId: searchParams.get('eventId'),
  });
  // Raw, for the search box — the service sanitises before it reaches PostgREST.
  const q = searchParams.get('q') ?? '';
  const eventId = validEventId ?? ALL_EVENTS;

  const [speakers, setSpeakers] = useState<SpeakerDirectoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<EventOption[]>([]);

  // Local mirror of `q` so typing stays responsive; pushed to the URL on a
  // debounce. Re-seeded whenever the URL changes underneath us (back/forward,
  // or a bookmarked link), so restoring state doesn't strand the input.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  /**
   * Merge a patch into the URL params. A patch that doesn't itself set `page`
   * resets to page 1 — otherwise narrowing a search while on page 7 lands on
   * an empty page. Empty/null values are deleted rather than written, so a
   * default-state URL stays clean and shareable.
   */
  const patchParams = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  // Debounced search -> URL. Replaces rather than pushes, so a search doesn't
  // leave one history entry per keystroke for Back to walk through.
  useEffect(() => {
    if (searchInput === q) return;
    const t = setTimeout(() => patchParams({ q: searchInput || null }, true), 300);
    return () => clearTimeout(t);
  }, [searchInput, q, patchParams]);

  // Event options for the filter control.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await EventService.getAllEventsLight();
      if (cancelled || !result.success || !result.data) return;
      setEvents(
        result.data
          .map((e) => ({
            id: e.id,
            label: e.eventStart
              ? `${e.eventTitle} — ${new Date(e.eventStart).getFullYear()}`
              : e.eventTitle,
          }))
          .filter((e) => Boolean(e.id)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listing fetch. Server-side search / sort / filter / paging, so every
  // listing input is a dependency.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const result = await SpeakersRollupService.listSpeakers({
        search: q,
        eventId: eventId || null,
        sort,
        dir: direction,
        page,
        pageSize,
      });
      if (cancelled) return;
      if (result.success && result.data) {
        setSpeakers(result.data.speakers);
        setTotal(result.data.total);
        setPageCount(result.data.pageCount);
      } else {
        setSpeakers([]);
        setTotal(0);
        setPageCount(1);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [q, eventId, sort, direction, page, pageSize]);

  // ---- Table ---------------------------------------------------------------
  const sorting = useMemo<SortingState>(
    () => [{ id: sort, desc: direction === 'desc' }],
    [sort, direction],
  );

  const onSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      // enableSortingRemoval is off, so `next` is never empty in practice —
      // fall back to the defaults if it somehow is.
      const nextSort = (first?.id as SpeakerSortColumn | undefined) ?? DEFAULT_SPEAKER_SORT;
      const nextDir = first ? (first.desc ? 'desc' : 'asc') : defaultDirectionFor(nextSort);
      patchParams({
        sort: nextSort === DEFAULT_SPEAKER_SORT ? null : nextSort,
        // Only carry `dir` when it differs from the column's natural default,
        // so the common case leaves a clean URL.
        dir: nextDir === defaultDirectionFor(nextSort) ? null : nextDir,
      });
    },
    [sorting, patchParams],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Speaker',
        cell: (info) => {
          const speaker = info.row.original;
          return (
            <div className="flex items-center gap-3">
              <div className="size-8 rounded-full bg-[var(--gray-3)] flex items-center justify-center flex-shrink-0">
                {speaker.avatar_url ? (
                  <img
                    src={speaker.avatar_url}
                    alt={speaker.name}
                    className="size-8 rounded-full object-cover"
                  />
                ) : (
                  <MicrophoneIcon className="size-4 text-[var(--gray-10)]" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {/* The row also navigates on double-click (house convention),
                      but the card list this replaced opened on a single click —
                      keep a real focusable control so that (and keyboard
                      access) survives. */}
                  <button
                    type="button"
                    onClick={() => navigate(`/speakers/${speaker.id}`)}
                    className="font-medium text-[var(--gray-12)] hover:underline text-left"
                  >
                    {speaker.name}
                  </button>
                  {!speaker.is_active && (
                    <Badge color="neutral" className="text-[10px]">
                      inactive
                    </Badge>
                  )}
                </div>
                {speaker.topics && speaker.topics.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {speaker.topics.slice(0, 3).map((topic) => (
                      <span
                        key={topic}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gray-3)] text-[var(--gray-11)]"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('company', {
        header: 'Title & company',
        cell: (info) => {
          const speaker = info.row.original;
          const line = [speaker.title, speaker.company].filter(Boolean).join(' · ');
          return <span className="text-sm text-[var(--gray-11)]">{line || '—'}</span>;
        },
      }),
      columnHelper.accessor('email', {
        header: 'Email',
        cell: (info) => (
          <span className="text-xs font-mono text-[var(--gray-11)]">{info.getValue() || '—'}</span>
        ),
      }),
      columnHelper.accessor('event_count', {
        header: 'Events',
        // A count column is far more useful "most first" — tanstack otherwise
        // starts ascending and cycles through an unsorted third state, so both
        // flags are needed to get a plain desc -> asc toggle.
        sortDescFirst: true,
        cell: (info) => (
          <span className="tabular-nums text-sm text-[var(--gray-12)]">{info.getValue() ?? 0}</span>
        ),
      }),
    ],
    [navigate],
  );

  const table = useReactTable({
    data: speakers,
    columns,
    state: { sorting },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    // The server does the work; tanstack must not re-sort or re-slice the page
    // it was handed.
    manualSorting: true,
    manualPagination: true,
    enableSortingRemoval: false,
    pageCount,
  });

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  const isFiltered = Boolean(q) || Boolean(eventId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--gray-11)]">
          Everyone who has spoken or offered to speak across your brand.
          <span className="ml-2 text-[var(--gray-10)]">({total})</span>
        </p>
        <Button onClick={() => navigate('/speakers/talks')} variant="outline">
          View talk pool
        </Button>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <Input
              placeholder="Search by name, email, or company"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              prefix={<MagnifyingGlassIcon className="size-4" />}
            />
          </div>
          <div className="sm:w-72">
            <Select
              value={eventId}
              onChange={(e) => patchParams({ eventId: e.target.value || null })}
              aria-label="Filter by event"
            >
              <option value={ALL_EVENTS}>All events</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <DataTable
          table={table}
          loading={loading}
          emptyState={
            isFiltered
              ? 'No speakers match your search.'
              : 'No speakers in the directory yet.'
          }
          onRowDoubleClick={(row) => navigate(`/speakers/${row.id}`)}
        />

        {!loading && total > 0 && (
          <div className="flex items-center justify-between gap-4 border-t border-[var(--gray-6)] px-4 py-3">
            <span className="text-sm text-[var(--gray-11)]">
              Showing {rangeStart}–{rangeEnd} of {total}
            </span>
            {/* Controlled by `page`; every edge control routes through the
                context's setPage, so onChange is the single write path. */}
            <Pagination
              total={pageCount}
              value={page}
              onChange={(next) => patchParams({ page: next <= 1 ? null : String(next) })}
            >
              <PaginationFirst />
              <PaginationPrevious />
              <PaginationItems />
              <PaginationNext />
              <PaginationLast />
            </Pagination>
          </div>
        )}
      </Card>
    </div>
  );
}
