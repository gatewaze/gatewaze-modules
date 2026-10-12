/**
 * Triage for videos that belong to nothing yet.
 *
 * Connecting a platform account adopts its whole back catalogue, so this queue
 * does not start small. On AAIF the first run produced 591 rows: 555 podcast
 * episodes from the feed and 36 YouTube videos. That number is what shapes the
 * screen.
 *
 * Two things follow from it. The list is paged and filtered on the server,
 * because a browser cannot usefully render 591 rows and filtering what arrived
 * would hide every match past the page. And the subject choice is made once
 * and then kept, with checkboxes on the rows, because 555 of those episodes
 * belong to the same podcast and assigning them one at a time would be an hour
 * of clicking.
 *
 * Assigning goes one request per video rather than one bulk request. The API
 * checks authorisation per subject, and a partial failure has to be reportable
 * per video: "412 of 555 assigned, these 3 failed" is actionable, while a
 * single rolled-back error is not.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowTopRightOnSquareIcon,
  CalendarDaysIcon,
  MicrophoneIcon,
} from '@heroicons/react/24/outline';

import { Badge, Button, Card, Input, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  assignVideo,
  getScope,
  listSubjects,
  listUnassigned,
  listUnits,
  unassignedSummary,
  type AssignSubjectType,
  type EditorScope,
  type SubjectOption,
  type SubjectType,
  type UnassignedVideo,
  type UnitOption,
} from '../utils/videosEditorService';

const PAGE_SIZE = 50;

/** How many assigns to have in flight at once. Enough to be quick, few enough
 *  that a 555-row run does not look like an attack on our own API. */
const ASSIGN_CONCURRENCY = 3;

/**
 * A link that is safe to put in an href, or null.
 *
 * The API already nulls anything that is not http(s), because these values
 * come from YouTube and from an RSS feed. Repeated here because this is the
 * component that builds the href, and a render site that trusts its input is
 * one API change away from being wrong.
 */
function safeLink(value: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function providerLabel(provider: string): string {
  if (provider === 'youtube') return 'YouTube';
  if (provider === 'spotify') return 'Spotify';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Views, or a plain statement that we have not collected any yet.
 *
 * Null means no metric row exists, which is not zero. Showing "0 views" for a
 * video we have simply never polled would be a lie, and the operator would
 * sort by it and work on the wrong videos first.
 */
function formatViews(views: number | null): string {
  if (views === null || views === undefined) return 'no figures yet';
  return `${views.toLocaleString()} ${views === 1 ? 'view' : 'views'}`;
}

export default function UnassignedVideos() {
  const [scope, setScope] = useState<EditorScope | null>(null);
  const [loadingScope, setLoadingScope] = useState(true);

  const [videos, setVideos] = useState<UnassignedVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('');
  const [search, setSearch] = useState('');
  const [byProvider, setByProvider] = useState<Record<string, number>>({});
  const [unreadable, setUnreadable] = useState<string[]>([]);

  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [subjectType, setSubjectType] = useState<SubjectType>('event');
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [subjectSearch, setSubjectSearch] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitId, setUnitId] = useState('');
  const [unitsUnavailable, setUnitsUnavailable] = useState('');

  const [assigning, setAssigning] = useState(false);
  const [assignedCount, setAssignedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getScope()
      .then((s) => { if (!cancelled) setScope(s); })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load your access');
      })
      .finally(() => { if (!cancelled) setLoadingScope(false); });
    return () => { cancelled = true; };
  }, []);

  // The queue is only served to admins and 'all' grant holders, because an
  // unassigned video has no subject to scope it by. Reading that off the scope
  // we already have, rather than letting the list 403 and showing the operator
  // an error for something that is not a fault.
  const mayTriage = scope?.unrestricted === true;

  const load = useCallback(async () => {
    if (!mayTriage) return;
    setLoading(true);
    try {
      const page = await listUnassigned({ limit: PAGE_SIZE, offset, provider, search });
      setVideos(page.videos);
      setTotal(page.total);
      // The selection belongs to the page in front of the operator. Keeping it
      // across a page or filter change would let the button say "assign 100"
      // while only the 50 now on screen would actually be assigned.
      setPicked(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the queue');
    } finally {
      setLoading(false);
    }
  }, [mayTriage, offset, provider, search]);

  // Debounced, because this fires on every keystroke in the search box.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  const loadSummary = useCallback(async () => {
    if (!mayTriage) return;
    try {
      const s = await unassignedSummary();
      setByProvider(s.byProvider);
      setUnreadable(s.unreadable);
    } catch {
      /* The counts are a convenience. The list is the screen. */
    }
  }, [mayTriage]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  // Subjects for the picker, searched server-side for the same reason as the
  // editor workspace: the list is capped, so filtering locally hides matches.
  useEffect(() => {
    let cancelled = false;
    setLoadingSubjects(true);
    const t = setTimeout(() => {
      listSubjects(subjectType, subjectSearch)
        .then((r) => { if (!cancelled) setSubjects(r.subjects); })
        .catch((err: unknown) => {
          if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load subjects');
        })
        .finally(() => { if (!cancelled) setLoadingSubjects(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [subjectType, subjectSearch]);

  // Units are optional. A video can be attached to the whole event, which is
  // the right answer for a recap or a highlights reel that is not one talk.
  useEffect(() => {
    if (!subjectId) { setUnits([]); setUnitId(''); setUnitsUnavailable(''); return; }
    let cancelled = false;
    setUnitId('');
    setUnitsUnavailable('');
    listUnits(subjectType, subjectId)
      .then((u) => { if (!cancelled) setUnits(u); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setUnits([]);
          setUnitsUnavailable(err instanceof Error ? err.message : 'Could not load talks');
        }
      });
    return () => { cancelled = true; };
  }, [subjectType, subjectId]);

  const providerFilters = useMemo(
    () => Object.entries(byProvider).sort((a, b) => b[1] - a[1]),
    [byProvider],
  );

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const pageIds = useMemo(() => videos.map((v) => v.id), [videos]);
  const allOnPagePicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));

  const togglePage = () => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allOnPagePicked) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  /**
   * What the picked videos get attached to.
   *
   * A chosen talk wins over the event it belongs to, because that is the more
   * specific answer and it is what the operator just clicked.
   */
  const target: { type: AssignSubjectType; id: string } | null = useMemo(() => {
    if (unitId) {
      return { type: subjectType === 'event' ? 'agenda_entry' : 'podcast_episode', id: unitId };
    }
    if (subjectId) return { type: subjectType, id: subjectId };
    return null;
  }, [subjectType, subjectId, unitId]);

  const runAssign = async () => {
    if (!target || picked.size === 0) return;
    const ids = videos.filter((v) => picked.has(v.id)).map((v) => v.id);
    if (ids.length === 0) {
      toast.error('The picked videos are not on this page. Assign them from the page they are on.');
      return;
    }

    setAssigning(true);
    setAssignedCount(0);
    const failures: Array<{ id: string; reason: string }> = [];
    const done = new Set<string>();

    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        try {
          await assignVideo(id, target.type, target.id);
          done.add(id);
          setAssignedCount((n) => n + 1);
        } catch (err) {
          failures.push({ id, reason: err instanceof Error ? err.message : 'failed' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ASSIGN_CONCURRENCY, ids.length) }, worker));
    setAssigning(false);

    // Drop what succeeded and keep what did not, so a retry is just pressing
    // the button again rather than finding the failures by hand.
    setVideos((prev) => prev.filter((v) => !done.has(v.id)));
    setTotal((t) => Math.max(0, t - done.size));
    setPicked((prev) => {
      const next = new Set(prev);
      done.forEach((id) => next.delete(id));
      return next;
    });

    if (failures.length === 0) {
      toast.success(`${done.size} video${done.size === 1 ? '' : 's'} assigned.`);
    } else {
      toast.error(
        `${done.size} assigned, ${failures.length} failed. First problem: ${failures[0].reason}`,
      );
    }
    void loadSummary();
    if (done.size > 0 && videos.length === done.size) void load();
  };

  if (loadingScope) {
    return (
      <WorkspaceLayout title="Unassigned videos">
        <div className="p-6"><LoadingSpinner /></div>
      </WorkspaceLayout>
    );
  }

  if (!scope) {
    return (
      <WorkspaceLayout title="Unassigned videos">
        <div className="p-6">
          <p className="text-sm text-[var(--gray-11)]">
            Your video access could not be loaded. Reload the page, and if it keeps happening ask an
            administrator to check your editor grants.
          </p>
        </div>
      </WorkspaceLayout>
    );
  }

  if (!mayTriage) {
    return (
      <WorkspaceLayout title="Unassigned videos">
        <div className="p-6 max-w-2xl">
          <p className="text-sm text-[var(--gray-11)]">
            This queue holds videos that belong to no event or podcast yet, so there is no subject
            to decide what you may see. It is open to administrators and to editors granted access
            to everything. Your own events and podcasts are on the{' '}
            <a href="/videos" className="text-[var(--accent-11)] hover:underline">Videos</a> page.
          </p>
        </div>
      </WorkspaceLayout>
    );
  }

  const selectedSubject = subjects.find((s) => s.id === subjectId);
  const selectedUnit = units.find((u) => u.id === unitId);

  return (
    <WorkspaceLayout title="Unassigned videos">
      <div className="p-6">
        <p className="text-sm text-[var(--gray-11)] mb-4 max-w-3xl">
          These videos were found on a connected account and do not belong to an event or a podcast
          yet. Their metrics are being collected either way. Attaching one puts it on the right
          event or episode page and includes it in that subject&rsquo;s totals.
        </p>

        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div className="w-72">
            <Input
              label="Search titles"
              placeholder="Type part of the title…"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <button
              type="button"
              onClick={() => { setProvider(''); setOffset(0); }}
              aria-pressed={provider === ''}
              className={`px-2.5 py-1 rounded-md text-xs ${
                provider === ''
                  ? 'bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                  : 'text-[var(--gray-11)] hover:bg-[var(--gray-3)]'
              }`}
            >
              All platforms
            </button>
            {providerFilters.map(([p, n]) => (
              <button
                key={p}
                type="button"
                onClick={() => { setProvider(p); setOffset(0); }}
                aria-pressed={provider === p}
                className={`px-2.5 py-1 rounded-md text-xs ${
                  provider === p
                    ? 'bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                    : 'text-[var(--gray-11)] hover:bg-[var(--gray-3)]'
                }`}
              >
                {providerLabel(p)} ({n})
              </button>
            ))}
          </div>
        </div>

        {unreadable.length > 0 && (
          <p className="text-xs text-[var(--amber-11)] mb-4">
            The count for {unreadable.join(', ')} could not be read, so the total below is short by
            however many of those are waiting.
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 items-start">
          {/* ── The queue ─────────────────────────────────────────────────── */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--gray-5)]">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={allOnPagePicked}
                  onChange={togglePage}
                  disabled={videos.length === 0}
                  aria-label="Select every video on this page"
                  className="h-4 w-4"
                />
                <span className="text-sm font-medium">
                  {total.toLocaleString()} waiting
                  {picked.size > 0 && (
                    <span className="text-[var(--gray-11)] font-normal"> · {picked.size} selected</span>
                  )}
                </span>
              </div>
              {total > PAGE_SIZE && (
                <div className="flex items-center gap-2 text-sm">
                  <Button
                    variant="soft"
                    size="sm"
                    disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-[var(--gray-11)]">
                    {offset + 1} to {Math.min(offset + PAGE_SIZE, total)}
                  </span>
                  <Button
                    variant="soft"
                    size="sm"
                    disabled={offset + PAGE_SIZE >= total || loading}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="p-6"><LoadingSpinner /></div>
            ) : videos.length === 0 ? (
              <p className="p-6 text-sm text-[var(--gray-11)]">
                {search || provider
                  ? 'Nothing here matches those filters.'
                  : 'Every video found on a connected account has been assigned. Nothing to do.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--gray-5)]">
                {videos.map((v) => {
                  const selected = picked.has(v.id);
                  const link = safeLink(v.url);
                  const thumb = safeLink(v.thumbnail_url);
                  return (
                    <li
                      key={v.id}
                      className={`flex gap-3 px-4 py-3 ${selected ? 'bg-[var(--accent-2)]' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggle(v.id)}
                        aria-label={`Select ${v.title ?? 'untitled video'}`}
                        className="h-4 w-4 mt-1 shrink-0"
                      />
                      {thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          className="w-28 h-16 object-cover rounded shrink-0 bg-[var(--gray-3)]"
                        />
                      ) : (
                        <div className="w-28 h-16 rounded shrink-0 bg-[var(--gray-3)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => toggle(v.id)}
                          className="text-left w-full"
                        >
                          <span className="block text-sm font-medium truncate">
                            {v.title || 'Untitled'}
                          </span>
                        </button>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-[var(--gray-11)]">
                          <Badge>{providerLabel(v.provider)}</Badge>
                          <span>{formatViews(v.latest_views)}</span>
                          {v.duration_seconds ? <span>{formatDuration(v.duration_seconds)}</span> : null}
                          {v.published_at ? <span>{String(v.published_at).slice(0, 10)}</span> : null}
                          {v.connection_label ? <span>{v.connection_label}</span> : null}
                          {link ? (
                            <a
                              href={link}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-[var(--accent-11)] hover:underline"
                            >
                              Open <ArrowTopRightOnSquareIcon className="w-3 h-3" />
                            </a>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* ── Where they go ─────────────────────────────────────────────── */}
          <Card className="overflow-hidden p-0">
            <div className="px-4 py-3 border-b border-[var(--gray-5)]">
              <h3 className="text-sm font-semibold">Assign to</h3>
              <p className="text-xs text-[var(--gray-11)] mt-0.5">
                Chosen once and kept, so a run of episodes can be worked through without picking
                the same podcast again.
              </p>
            </div>

            <div className="p-4 space-y-4">
              <div className="flex gap-2">
                {(['event', 'podcast'] as SubjectType[]).map((t) => {
                  const Icon = t === 'event' ? CalendarDaysIcon : MicrophoneIcon;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setSubjectType(t);
                        setSubjectId('');
                        setUnitId('');
                        setSubjectSearch('');
                      }}
                      aria-pressed={subjectType === t}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm border ${
                        subjectType === t
                          ? 'border-[var(--accent-8)] bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                          : 'border-[var(--gray-6)] hover:bg-[var(--gray-3)]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {t === 'event' ? 'Event' : 'Podcast'}
                    </button>
                  );
                })}
              </div>

              <Input
                label={subjectType === 'event' ? 'Search events' : 'Search podcasts'}
                placeholder="Type part of the name…"
                value={subjectSearch}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubjectSearch(e.target.value)}
              />

              {loadingSubjects ? (
                <LoadingSpinner />
              ) : subjects.length === 0 ? (
                <p className="text-sm text-[var(--gray-11)]">
                  {subjectSearch
                    ? `Nothing matches “${subjectSearch}”.`
                    : subjectType === 'event'
                      ? 'No past event has both an agenda and speakers yet. Import a conference programme on the event’s Agenda tab and it will appear here.'
                      : 'No podcasts exist yet. One has to be created before episodes can be attached to it.'}
                </p>
              ) : (
                <ul className="max-h-56 overflow-y-auto rounded-md border border-[var(--gray-6)] divide-y divide-[var(--gray-5)]">
                  {subjects.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSubjectId(s.id)}
                        aria-pressed={s.id === subjectId}
                        className={`w-full text-left px-3 py-2 text-sm ${
                          s.id === subjectId
                            ? 'bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                            : 'hover:bg-[var(--gray-3)]'
                        }`}
                      >
                        <span className="block truncate">{s.label}</span>
                        {s.starts_at ? (
                          <span className="block text-xs text-[var(--gray-11)]">
                            {String(s.starts_at).slice(0, 10)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {subjectId && (
                <div>
                  <p className="text-xs font-medium mb-1">
                    {subjectType === 'event' ? 'Which talk? (optional)' : 'Which episode? (optional)'}
                  </p>
                  <p className="text-xs text-[var(--gray-11)] mb-2">
                    Leave this alone to attach the videos to the whole{' '}
                    {subjectType === 'event' ? 'event' : 'podcast'}, which is right for a recap or a
                    highlights reel.
                  </p>
                  {unitsUnavailable ? (
                    <p className="text-xs text-[var(--gray-11)]">{unitsUnavailable}</p>
                  ) : units.length === 0 ? (
                    <p className="text-xs text-[var(--gray-11)]">
                      {subjectType === 'event'
                        ? 'This event has no agenda sessions.'
                        : 'This podcast has no episodes yet.'}
                    </p>
                  ) : (
                    <ul className="max-h-40 overflow-y-auto rounded-md border border-[var(--gray-6)] divide-y divide-[var(--gray-5)]">
                      <li>
                        <button
                          type="button"
                          onClick={() => setUnitId('')}
                          aria-pressed={unitId === ''}
                          className={`w-full text-left px-3 py-2 text-sm ${
                            unitId === ''
                              ? 'bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                              : 'hover:bg-[var(--gray-3)]'
                          }`}
                        >
                          The whole {subjectType === 'event' ? 'event' : 'podcast'}
                        </button>
                      </li>
                      {units.map((u) => (
                        <li key={u.id}>
                          <button
                            type="button"
                            onClick={() => setUnitId(u.id)}
                            aria-pressed={u.id === unitId}
                            className={`w-full text-left px-3 py-2 text-sm ${
                              u.id === unitId
                                ? 'bg-[var(--accent-3)] text-[var(--accent-11)] font-medium'
                                : 'hover:bg-[var(--gray-3)]'
                            }`}
                          >
                            <span className="block truncate">{u.label}</span>
                            {u.videos.full + u.videos.short > 0 ? (
                              <span className="block text-xs text-[var(--gray-11)]">
                                already has {u.videos.full} full, {u.videos.short} short
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-[var(--gray-5)]">
              {target && (
                <p className="text-xs text-[var(--gray-11)] mb-2">
                  {picked.size} video{picked.size === 1 ? '' : 's'} to{' '}
                  <span className="font-medium text-[var(--gray-12)]">
                    {selectedUnit?.label ?? selectedSubject?.label ?? 'the chosen subject'}
                  </span>
                </p>
              )}
              <Button
                onClick={() => void runAssign()}
                disabled={!target || picked.size === 0 || assigning}
                className="w-full"
              >
                {assigning
                  ? `Assigning ${assignedCount} of ${picked.size}…`
                  : picked.size === 0
                    ? 'Select videos to assign'
                    : !target
                      ? 'Choose where they go'
                      : `Assign ${picked.size} video${picked.size === 1 ? '' : 's'}`}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </WorkspaceLayout>
  );
}
