/**
 * The video editor's workspace (spec §16.2, §18.2).
 *
 * Dan's seven steps, in order: log in, see the module, open it, choose event
 * or podcast, choose which one, choose a talk, upload the video and its
 * shorts. Then the drafted copy, then schedule.
 *
 * Built as a stepped flow rather than one dense form because the audience is a
 * third-party contractor who may use this once a quarter. Each step asks one
 * question and shows the answer to the last one.
 *
 * Step state is deliberately plain `useState`, matching NewsletterSetupWizard
 * rather than the unused `useStep` hook, and the step indicator is hand-rolled
 * because there is no Stepper in @/components/ui.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowUpTrayIcon,
  CalendarDaysIcon,
  CheckIcon,
  ClockIcon,
  FilmIcon,
  MicrophoneIcon,
  QueueListIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import { Badge, Button, Card, Select, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

import {
  getScope,
  listSubjects,
  listUnits,
  listUnitVideos,
  getCopy,
  mintUploads,
  completeUpload,
  schedulePublication,
  putToStorage,
  probeVideo,
  formatBytes,
  scheduleInputToIso,
  scheduleMinValue,
  type AssetKind,
  type EditorScope,
  type EditorVideo,
  type GeneratedCopy,
  type SubjectOption,
  type SubjectType,
  type UnitOption,
  type Visibility,
} from '../utils/videosEditorService';

const STEPS = [
  { id: 'kind', label: 'Event or podcast', icon: QueueListIcon },
  { id: 'subject', label: 'Which one', icon: CalendarDaysIcon },
  { id: 'unit', label: 'Which talk', icon: MicrophoneIcon },
  { id: 'upload', label: 'Upload', icon: ArrowUpTrayIcon },
  { id: 'publish', label: 'Titles and schedule', icon: ClockIcon },
];

type ItemStatus = 'queued' | 'minting' | 'uploading' | 'finalising' | 'done' | 'failed';

interface QueueItem {
  key: string;
  file: File;
  kind: AssetKind;
  status: ItemStatus;
  progress: number;
  error?: string;
  assetId?: string;
  videoId?: string;
}

/** Two at a time: enough to use the connection, few enough to read. */
const CONCURRENCY = 2;

export default function VideoEditorWorkspace() {
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<EditorScope | null>(null);
  const [loadingScope, setLoadingScope] = useState(true);

  const [subjectType, setSubjectType] = useState<SubjectType>('event');
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  const [units, setUnits] = useState<UnitOption[]>([]);
  const [unitId, setUnitId] = useState('');
  const [loadingUnits, setLoadingUnits] = useState(false);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [videos, setVideos] = useState<EditorVideo[]>([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [copyByVideo, setCopyByVideo] = useState<Record<string, GeneratedCopy>>({});

  const [platform, setPlatform] = useState('youtube');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('later');
  const [scheduledAt, setScheduledAt] = useState('');
  const [scheduling, setScheduling] = useState<string | null>(null);

  const subject = useMemo(() => subjects.find((s) => s.id === subjectId) ?? null, [subjects, subjectId]);
  const unit = useMemo(() => units.find((u) => u.id === unitId) ?? null, [units, unitId]);

  const canSchedule = useMemo(() => {
    if (!scope) return false;
    if (scope.is_admin) return true;
    return scope.grants.some(
      (g) => g.can_schedule && (g.subject_type === 'all' || (g.subject_type === subjectType && g.subject_id === subjectId)),
    );
  }, [scope, subjectType, subjectId]);

  // ── Load scope once ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getScope();
        if (!cancelled) setScope(s);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load your access');
      } finally {
        if (!cancelled) setLoadingScope(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Step 5: subjects for the chosen kind ───────────────────────────────────
  useEffect(() => {
    if (step !== 1) return;
    let cancelled = false;
    setLoadingSubjects(true);
    void (async () => {
      try {
        const list = await listSubjects(subjectType);
        if (!cancelled) setSubjects(list);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load the list');
      } finally {
        if (!cancelled) setLoadingSubjects(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, subjectType]);

  // ── Step 6: units within the subject ───────────────────────────────────────
  useEffect(() => {
    if (step !== 2 || !subjectId) return;
    let cancelled = false;
    setLoadingUnits(true);
    void (async () => {
      try {
        const list = await listUnits(subjectType, subjectId);
        if (!cancelled) setUnits(list);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load the agenda');
      } finally {
        if (!cancelled) setLoadingUnits(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, subjectType, subjectId]);

  const refreshVideos = useCallback(async () => {
    if (!subjectId || !unitId) return;
    setLoadingVideos(true);
    try {
      const list = await listUnitVideos(subjectType, subjectId, unitId);
      setVideos(list);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load this talk’s videos');
    } finally {
      setLoadingVideos(false);
    }
  }, [subjectType, subjectId, unitId]);

  useEffect(() => {
    if (step === 3 || step === 4) void refreshVideos();
  }, [step, refreshVideos]);

  // ── Upload ─────────────────────────────────────────────────────────────────

  const patchItem = (key: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const addFiles = (files: FileList | null, kind: AssetKind) => {
    if (!files?.length) return;
    const next: QueueItem[] = Array.from(files).map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      kind,
      status: 'queued',
      progress: 0,
    }));
    setQueue((q) => [...q, ...next]);
  };

  const totals = useMemo(() => {
    const bytes = queue.reduce((s, q) => s + q.file.size, 0);
    const sent = queue.reduce((s, q) => s + q.file.size * (q.status === 'done' ? 1 : q.progress), 0);
    return {
      bytes,
      pct: bytes ? Math.round((sent / bytes) * 100) : 0,
      done: queue.filter((q) => q.status === 'done').length,
      failed: queue.filter((q) => q.status === 'failed').length,
    };
  }, [queue]);

  const startUploads = async () => {
    const pending = queue.filter((q) => q.status === 'queued' || q.status === 'failed');
    if (!pending.length) return;
    if (!scope?.uploads_available) {
      toast.error('Uploads are not configured on this install');
      return;
    }
    setRunning(true);
    abortRef.current = new AbortController();

    // Mint in one call so the server sees the whole batch and can reject a
    // file before any bytes move.
    pending.forEach((p) => patchItem(p.key, { status: 'minting', progress: 0, error: undefined }));
    let minted;
    try {
      minted = await mintUploads({
        subjectType,
        subjectId,
        unitId,
        files: pending.map((p) => ({
          filename: p.file.name,
          mime_type: p.file.type,
          bytes: p.file.size,
          kind: p.kind,
          title: unit?.label,
        })),
      });
    } catch (err) {
      pending.forEach((p) => patchItem(p.key, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Could not start the upload',
      }));
      setRunning(false);
      return;
    }

    // Results come back in request order.
    const jobs = pending.map((p, i) => ({ item: p, mint: minted[i] }));

    const runOne = async (job: typeof jobs[number]) => {
      const { item, mint } = job;
      if (!mint || mint.status !== 'ready' || !mint.upload_url || !mint.ticket) {
        patchItem(item.key, {
          status: 'failed',
          error: mint?.reason ? describeReason(mint.reason) : 'The server refused this file',
        });
        return;
      }
      try {
        patchItem(item.key, { status: 'uploading', assetId: mint.asset_id, videoId: mint.video_id });
        await putToStorage(mint.upload_url, item.file, (f) => patchItem(item.key, { progress: f }), abortRef.current?.signal);

        patchItem(item.key, { status: 'finalising', progress: 1 });
        const probe = await probeVideo(item.file);
        await completeUpload({
          ticket: mint.ticket,
          durationSeconds: probe.duration,
          width: probe.width,
          height: probe.height,
        });
        patchItem(item.key, { status: 'done', progress: 1 });
      } catch (err) {
        patchItem(item.key, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (job) await runOne(job);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

    setRunning(false);
    abortRef.current = null;
    await refreshVideos();
    const failed = queue.filter((q) => q.status === 'failed').length;
    if (failed) toast.error(`${failed} file(s) failed. You can retry them.`);
    else toast.success('Upload complete');
  };

  const cancelUploads = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  // ── Copy + scheduling ──────────────────────────────────────────────────────

  const loadCopy = async (videoId: string) => {
    try {
      const copy = await getCopy(videoId, [platform]);
      setCopyByVideo((m) => ({ ...m, [videoId]: copy }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not draft the copy');
    }
  };

  const doSchedule = async (video: EditorVideo) => {
    const iso = scheduleMode === 'now' ? null : scheduleInputToIso(scheduledAt);
    if (scheduleMode === 'later' && !iso) {
      toast.error('Pick a date and time');
      return;
    }
    setScheduling(video.id);
    try {
      const copy = copyByVideo[video.id];
      await schedulePublication({
        videoId: video.id,
        subjectType,
        subjectId,
        platform,
        visibility,
        scheduledFor: iso,
        title: copy?.titlesByPlatform?.[platform] ?? copy?.title,
        description: copy?.description,
      });
      toast.success(iso ? 'Scheduled' : 'Queued to publish now');
      await refreshVideos();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not schedule');
    } finally {
      setScheduling(null);
    }
  };

  // ── Gates ──────────────────────────────────────────────────────────────────

  if (loadingScope) {
    return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;
  }

  if (!scope) {
    return (
      <Card variant="surface" className="p-6 m-6">
        <h2 className="text-lg font-semibold mb-2">Video editing</h2>
        <p className="text-sm text-[var(--gray-11)]">
          Your access could not be loaded. Ask an administrator to grant you video editor access.
        </p>
      </Card>
    );
  }

  if (!scope.is_admin && scope.grants.length === 0) {
    return (
      <Card variant="surface" className="p-6 m-6">
        <h2 className="text-lg font-semibold mb-2">No video access yet</h2>
        <p className="text-sm text-[var(--gray-11)]">
          You are signed in, but you have not been given access to any event or podcast.
          An administrator needs to grant you access before you can upload.
        </p>
      </Card>
    );
  }

  const canProceed = () => {
    switch (step) {
      case 0: return true;
      case 1: return subjectId.length > 0;
      case 2: return unitId.length > 0;
      case 3: return true;
      default: return false;
    }
  };

  return (
    <WorkspaceLayout title="Videos">
      <div className="p-6 max-w-5xl">
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === step;
            const isDone = i < step;
            return (
              <div key={s.id} className="flex items-center gap-2 flex-1">
                <button
                  type="button"
                  onClick={() => { if (i < step) setStep(i); }}
                  disabled={i > step}
                  className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${
                    isDone
                      ? 'bg-green-500 text-white cursor-pointer'
                      : isActive
                        ? 'bg-[var(--accent-9)] text-white'
                        : 'bg-[var(--gray-a4)] text-[var(--gray-9)]'
                  }`}
                  title={i < step ? `Back to ${s.label}` : s.label}
                >
                  {isDone ? <CheckIcon className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                </button>
                <span className={`text-sm font-medium hidden sm:inline ${isActive ? 'text-[var(--gray-12)]' : 'text-[var(--gray-9)]'}`}>
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <div className="flex-1 h-px bg-[var(--gray-a5)]" />}
              </div>
            );
          })}
        </div>

        <Card variant="surface" className="p-6 mb-6">
          {/* Step 4: event or podcast */}
          {step === 0 && (
            <div>
              <h3 className="text-base font-semibold mb-1">What are you working on?</h3>
              <p className="text-sm text-[var(--gray-11)] mb-4">
                Event videos attach to a talk on the agenda. Podcast videos attach to an episode.
              </p>
              <div className="flex gap-3">
                {(['event', 'podcast'] as SubjectType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setSubjectType(t); setSubjectId(''); setUnitId(''); setStep(1); }}
                    className={`flex-1 p-4 rounded-lg border text-left ${
                      subjectType === t
                        ? 'border-[var(--accent-9)] bg-[var(--accent-a3)]'
                        : 'border-[var(--gray-a6)] hover:border-[var(--gray-a8)]'
                    }`}
                  >
                    <div className="font-medium capitalize">{t}</div>
                    <div className="text-xs text-[var(--gray-11)] mt-1">
                      {t === 'event' ? 'Conference talks and sessions' : 'Podcast episodes'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 5: which one */}
          {step === 1 && (
            <div>
              <h3 className="text-base font-semibold mb-1">
                Which {subjectType}?
              </h3>
              <p className="text-sm text-[var(--gray-11)] mb-4">
                {scope.unrestricted
                  ? 'You can work on any of these.'
                  : 'These are the ones you have been given access to.'}
              </p>
              {loadingSubjects ? (
                <LoadingSpinner />
              ) : subjects.length === 0 ? (
                <p className="text-sm text-[var(--gray-11)]">
                  Nothing available. {scope.unrestricted
                    ? `No ${subjectType}s exist yet.`
                    : `You have no ${subjectType} access.`}
                </p>
              ) : (
                <Select
                  label={subjectType === 'event' ? 'Event' : 'Podcast'}
                  value={subjectId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setSubjectId(e.target.value); setUnitId(''); }}
                  data={[
                    { label: `Choose a ${subjectType}…`, value: '' },
                    ...subjects.map((s) => ({
                      label: s.starts_at ? `${s.label} (${String(s.starts_at).slice(0, 10)})` : s.label,
                      value: s.id,
                    })),
                  ]}
                />
              )}
            </div>
          )}

          {/* Step 6: which talk */}
          {step === 2 && (
            <div>
              <h3 className="text-base font-semibold mb-1">Which talk?</h3>
              <p className="text-sm text-[var(--gray-11)] mb-4">
                {subject?.label}. The count shows what is already uploaded.
              </p>
              {loadingUnits ? (
                <LoadingSpinner />
              ) : units.length === 0 ? (
                <p className="text-sm text-[var(--gray-11)]">
                  No sessions found. For an event, the programme needs importing on the Agenda tab first.
                </p>
              ) : (
                <div className="max-h-96 overflow-y-auto divide-y divide-[var(--gray-a5)] rounded border border-[var(--gray-a6)]">
                  {units.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => { setUnitId(u.id); setStep(3); }}
                      className={`w-full text-left px-4 py-3 hover:bg-[var(--gray-a3)] ${
                        unitId === u.id ? 'bg-[var(--accent-a3)]' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm">{u.label}</span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {u.videos.full > 0 && <Badge color="green" variant="soft">{u.videos.full} video</Badge>}
                          {u.videos.short > 0 && <Badge color="blue" variant="soft">{u.videos.short} short</Badge>}
                          {u.videos.full === 0 && u.videos.short === 0 && (
                            <Badge color="gray" variant="soft">nothing yet</Badge>
                          )}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 7: upload */}
          {step === 3 && (
            <div>
              <h3 className="text-base font-semibold mb-1">Upload</h3>
              <p className="text-sm text-[var(--gray-11)] mb-4">
                {unit?.label}. The recording and any shorts cut from it.
              </p>

              <div className="grid sm:grid-cols-2 gap-3 mb-4">
                <UploadSlot
                  label="Recording"
                  hint="The full talk. MP4, MOV or WebM, up to 5 GB."
                  icon={<FilmIcon className="w-5 h-5" />}
                  onPick={(f) => addFiles(f, 'master')}
                  disabled={running}
                />
                <UploadSlot
                  label="Shorts"
                  hint="Vertical clips. Up to 500 MB each, several at a time."
                  icon={<ArrowUpTrayIcon className="w-5 h-5" />}
                  multiple
                  onPick={(f) => addFiles(f, 'short')}
                  disabled={running}
                />
              </div>

              {queue.length > 0 && (
                <div className="border border-[var(--gray-a6)] rounded mb-4">
                  <div className="px-3 py-2 flex items-center justify-between border-b border-[var(--gray-a5)]">
                    <span className="text-xs font-medium text-[var(--gray-11)]">
                      {queue.length} file(s) · {formatBytes(totals.bytes)}
                      {running && ` · ${totals.pct}%`}
                    </span>
                    <span className="flex gap-2">
                      {running ? (
                        <Button size="xs" variant="outline" onClick={cancelUploads}>Cancel</Button>
                      ) : (
                        <>
                          <Button size="xs" variant="outline" onClick={() => setQueue([])}>Clear</Button>
                          <Button size="xs" variant="solid" onClick={() => void startUploads()}>
                            {totals.failed > 0 ? 'Retry failed' : 'Start upload'}
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  <ul className="divide-y divide-[var(--gray-a5)]">
                    {queue.map((q) => (
                      <li key={q.key} className="px-3 py-2 flex items-center gap-3 text-sm">
                        <Badge color={q.kind === 'master' ? 'green' : 'blue'} variant="soft">{q.kind}</Badge>
                        <span className="flex-1 truncate" title={q.file.name}>{q.file.name}</span>
                        <span className="text-xs text-[var(--gray-11)] shrink-0">{formatBytes(q.file.size)}</span>
                        <span className="w-28 shrink-0 text-right">
                          {q.status === 'uploading' || q.status === 'minting' ? (
                            <span className="block h-1.5 overflow-hidden rounded bg-[var(--gray-a4)]">
                              <span className="block h-full bg-[var(--accent-9)]" style={{ width: `${Math.round(q.progress * 100)}%` }} />
                            </span>
                          ) : q.status === 'finalising' ? (
                            <span className="text-xs text-[var(--gray-11)]">finalising…</span>
                          ) : q.status === 'done' ? (
                            <span className="text-xs text-[var(--green-11)]">Uploaded</span>
                          ) : q.status === 'failed' ? (
                            <span className="text-xs text-[var(--red-11)]" title={q.error}>Failed</span>
                          ) : (
                            <span className="text-xs text-[var(--gray-9)]">queued</span>
                          )}
                        </span>
                        {!running && (
                          <button
                            type="button"
                            onClick={() => setQueue((qq) => qq.filter((x) => x.key !== q.key))}
                            className="text-[var(--gray-9)] hover:text-[var(--gray-12)]"
                            title="Remove"
                          >
                            <XMarkIcon className="w-4 h-4" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {queue.some((q) => q.error) && (
                    <div className="px-3 py-2 border-t border-[var(--gray-a5)] text-xs text-[var(--red-11)]">
                      {queue.find((q) => q.error)?.error}
                    </div>
                  )}
                </div>
              )}

              <UploadedList videos={videos} loading={loadingVideos} />
            </div>
          )}

          {/* Titles and schedule */}
          {step === 4 && (
            <div>
              <h3 className="text-base font-semibold mb-1">Titles and schedule</h3>
              <p className="text-sm text-[var(--gray-11)] mb-4">
                Drafted from the programme. Edit anything before you schedule.
              </p>

              {!canSchedule && (
                <div className="mb-4 p-3 rounded border border-[var(--amber-a6)] bg-[var(--amber-a3)] text-sm">
                  Your access allows uploading but not scheduling. An administrator can publish these.
                </div>
              )}

              <div className="grid sm:grid-cols-3 gap-3 mb-4">
                <Select
                  label="Platform"
                  value={platform}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPlatform(e.target.value)}
                  data={[
                    { label: 'YouTube', value: 'youtube' },
                    { label: 'LinkedIn', value: 'linkedin' },
                    { label: 'TikTok', value: 'tiktok' },
                  ]}
                />
                <Select
                  label="Visibility"
                  value={visibility}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVisibility(e.target.value as Visibility)}
                  data={[
                    { label: 'Private', value: 'private' },
                    { label: 'Unlisted', value: 'unlisted' },
                    { label: 'Public', value: 'public' },
                  ]}
                />
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-9)] mb-2">When</label>
                  <div className="flex items-center gap-3 h-9">
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input type="radio" checked={scheduleMode === 'now'} onChange={() => setScheduleMode('now')} />
                      Now
                    </label>
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input type="radio" checked={scheduleMode === 'later'} onChange={() => setScheduleMode('later')} />
                      Later
                    </label>
                  </div>
                </div>
              </div>

              {scheduleMode === 'later' && (
                <div className="mb-4 flex items-center gap-2">
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    min={scheduleMinValue()}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                  />
                  <span className="text-xs font-medium text-[var(--gray-9)]">UTC</span>
                </div>
              )}

              {loadingVideos ? <LoadingSpinner /> : videos.length === 0 ? (
                <p className="text-sm text-[var(--gray-11)]">Nothing uploaded for this talk yet.</p>
              ) : (
                <div className="space-y-4">
                  {videos.map((v) => {
                    const copy = copyByVideo[v.id];
                    const ready = v.assets.some((a) => a.state === 'ready');
                    return (
                      <div key={v.id} className="border border-[var(--gray-a6)] rounded p-4">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <span className="flex items-center gap-2">
                            <Badge color={v.kind === 'short' ? 'blue' : 'green'} variant="soft">{v.kind}</Badge>
                            <span className="text-sm font-medium">{v.title}</span>
                          </span>
                          {!copy && (
                            <Button size="xs" variant="outline" onClick={() => void loadCopy(v.id)}>
                              Draft titles
                            </Button>
                          )}
                        </div>

                        {copy && (
                          <div className="space-y-2 mb-3 text-sm">
                            <div>
                              <span className="text-xs text-[var(--gray-9)]">Title for {platform}</span>
                              <p className="font-medium">{copy.titlesByPlatform?.[platform] ?? copy.title}</p>
                            </div>
                            <div>
                              <span className="text-xs text-[var(--gray-9)]">Description</span>
                              <pre className="whitespace-pre-wrap font-sans text-xs text-[var(--gray-11)] max-h-32 overflow-y-auto">
                                {copy.description}
                              </pre>
                            </div>
                          </div>
                        )}

                        {v.publications.length > 0 && (
                          <ul className="mb-3 space-y-1">
                            {v.publications.map((p) => (
                              <li key={p.id} className="text-xs flex items-center gap-2">
                                <Badge
                                  color={p.state === 'published' ? 'green' : p.state === 'failed' ? 'red' : 'blue'}
                                  variant="soft"
                                >
                                  {p.state}
                                </Badge>
                                <span className="text-[var(--gray-11)]">
                                  {p.platform}
                                  {p.scheduled_for ? ` · ${new Date(p.scheduled_for).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}
                                  {` · ${p.requested_visibility}`}
                                </span>
                                {p.last_error && <span className="text-[var(--red-11)]">{p.last_error}</span>}
                              </li>
                            ))}
                          </ul>
                        )}

                        <Button
                          size="sm"
                          variant="solid"
                          disabled={!ready || !canSchedule || scheduling === v.id}
                          onClick={() => void doSchedule(v)}
                        >
                          {scheduling === v.id
                            ? 'Saving…'
                            : scheduleMode === 'now' ? 'Publish now' : 'Schedule'}
                        </Button>
                        {!ready && (
                          <span className="ml-2 text-xs text-[var(--gray-9)]">
                            Waiting for an uploaded file
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || running}
          >
            Back
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--gray-9)]">Step {step + 1} of {STEPS.length}</span>
            {step < STEPS.length - 1 && (
              <Button
                variant="solid"
                onClick={() => setStep((s) => s + 1)}
                disabled={!canProceed() || running}
              >
                {step === 3 ? 'Titles and schedule' : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </WorkspaceLayout>
  );
}

/** A labelled file picker. */
function UploadSlot(props: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: FileList | null) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={() => ref.current?.click()}
      className="p-4 rounded-lg border border-dashed border-[var(--gray-a6)] text-left hover:border-[var(--accent-9)] disabled:opacity-50"
    >
      <span className="flex items-center gap-2 font-medium text-sm">{props.icon}{props.label}</span>
      <span className="block text-xs text-[var(--gray-11)] mt-1">{props.hint}</span>
      <input
        ref={ref}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        multiple={props.multiple}
        className="hidden"
        onChange={(e) => { props.onPick(e.target.files); e.currentTarget.value = ''; }}
      />
    </button>
  );
}

/** What is already stored against this talk. */
function UploadedList({ videos, loading }: { videos: EditorVideo[]; loading: boolean }) {
  if (loading) return <LoadingSpinner />;
  if (videos.length === 0) {
    return <p className="text-sm text-[var(--gray-11)]">Nothing uploaded for this talk yet.</p>;
  }
  return (
    <div>
      <h4 className="text-xs font-medium text-[var(--gray-9)] mb-2">Already uploaded</h4>
      <ul className="divide-y divide-[var(--gray-a5)] border border-[var(--gray-a6)] rounded">
        {videos.flatMap((v) =>
          v.assets
            .filter((a) => a.state !== 'superseded')
            .map((a) => (
              <li key={a.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                <Badge color={a.kind === 'master' ? 'green' : 'blue'} variant="soft">{a.kind}</Badge>
                <span className="flex-1 truncate">{a.filename ?? v.title}</span>
                <span className="text-xs text-[var(--gray-11)]">{formatBytes(a.bytes)}</span>
                <Badge color={a.state === 'ready' ? 'green' : a.state === 'failed' ? 'red' : 'amber'} variant="soft">
                  {a.state}
                </Badge>
              </li>
            )),
        )}
      </ul>
    </div>
  );
}

/** Turn a server rejection code into something an editor can act on. */
function describeReason(reason: string): string {
  switch (reason) {
    case 'mime_not_allowed': return 'That file type is not accepted. Use MP4, MOV or WebM.';
    case 'too_large': return 'That file is over the size limit for its kind.';
    case 'no_size': return 'The file appears to be empty.';
    case 'unknown_kind': return 'Unrecognised upload kind.';
    case 'bad_filename': return 'That filename cannot be used.';
    default: return reason;
  }
}
