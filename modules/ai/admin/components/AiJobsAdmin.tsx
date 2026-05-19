/**
 * Jobs tab — operator view of BullMQ jobs across the platform.
 *
 * Spec: spec-ai-job-runner §4.5. Reachable at /admin/ai/jobs.
 *
 * Three sub-views (secondary tabs):
 *   - Active / Waiting / Delayed
 *   - Failed
 *   - Live tail (when a job row is expanded)
 *
 * Per-row actions:
 *   - Stop (active|waiting|delayed): pub/sub cancel + BullMQ remove
 *   - Retry (failed):                BullMQ moves back to waiting
 *   - Promote (delayed):             BullMQ clears delay
 *
 * Default view scopes to ai:* jobs. The "Cross-module" toggle lists
 * the full `jobs` queue (read-only for non-ai entries).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { ArrowPathIcon, StopCircleIcon, ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { JobsService, type AdminJobDto, type JobStatus } from '../utils/jobsService';

const STATUS_COLORS: Record<JobStatus, string> = {
  active: 'text-blue-500',
  waiting: 'text-[var(--gray-10)]',
  delayed: 'text-amber-500',
  failed: 'text-red-600',
  completed: 'text-green-600',
};

const STATUS_LABELS: Record<JobStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  delayed: 'Delayed',
  failed: 'Failed',
  completed: 'Completed',
};

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'in the future';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface FilterState {
  view: 'live' | 'failed';
  crossModule: boolean;
}

export default function AiJobsAdmin() {
  const [jobs, setJobs] = useState<AdminJobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>({ view: 'live', crossModule: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const statuses: JobStatus[] = useMemo(() => {
    return filter.view === 'failed' ? ['failed'] : ['active', 'waiting', 'delayed'];
  }, [filter.view]);

  const loadJobs = useCallback(async () => {
    const res = await JobsService.list({
      status: statuses,
      type: filter.crossModule ? 'all' : 'ai:',
      limit: 100,
    });
    if (!res.ok) {
      toast.error(`Failed to load jobs: ${res.error.message}`);
      setLoading(false);
      return;
    }
    setJobs(res.value.jobs);
    setLoading(false);
  }, [statuses, filter.crossModule]);

  // Auto-refresh while the tab is visible.
  useEffect(() => {
    loadJobs();
    const id = window.setInterval(loadJobs, 5000);
    return () => window.clearInterval(id);
  }, [loadJobs]);

  const onStop = useCallback(async (id: string) => {
    const r = await JobsService.stop(id);
    if (!r.ok) {
      toast.error(`Stop failed: ${r.error.message}`);
      return;
    }
    toast.success(`Stop requested`);
    loadJobs();
  }, [loadJobs]);

  const onRetry = useCallback(async (id: string) => {
    const r = await JobsService.retry(id);
    if (!r.ok) {
      toast.error(`Retry failed: ${r.error.message}`);
      return;
    }
    toast.success(`Retry queued`);
    loadJobs();
  }, [loadJobs]);

  const onPromote = useCallback(async (id: string) => {
    const r = await JobsService.promote(id);
    if (!r.ok) {
      toast.error(`Promote failed: ${r.error.message}`);
      return;
    }
    toast.success(`Promoted`);
    loadJobs();
  }, [loadJobs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded-md border border-[var(--gray-6)] overflow-hidden text-sm">
          <button
            type="button"
            className={`px-3 py-1.5 ${filter.view === 'live' ? 'bg-[var(--gray-4)]' : ''}`}
            onClick={() => setFilter((f) => ({ ...f, view: 'live' }))}
          >
            Active / Waiting / Delayed
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 border-l border-[var(--gray-6)] ${filter.view === 'failed' ? 'bg-[var(--gray-4)]' : ''}`}
            onClick={() => setFilter((f) => ({ ...f, view: 'failed' }))}
          >
            Failed
          </button>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-[var(--gray-11)]">
          <input
            type="checkbox"
            checked={filter.crossModule}
            onChange={(e) => setFilter((f) => ({ ...f, crossModule: e.target.checked }))}
          />
          Cross-module (show all modules)
        </label>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={loadJobs}>
            <ArrowPathIcon className="size-4 mr-1.5" /> Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 flex justify-center">
          <LoadingSpinner />
        </div>
      ) : jobs.length === 0 ? (
        <div className="p-8 text-center text-[var(--gray-10)] text-sm">
          No jobs in the selected view.
        </div>
      ) : (
        <div className="rounded-md border border-[var(--gray-6)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--gray-3)] text-left text-xs uppercase text-[var(--gray-11)]">
              <tr>
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Age</th>
                <th className="px-3 py-2">Attempts</th>
                <th className="px-3 py-2">Linked Row</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  expanded={expandedId === j.id}
                  onToggle={() => setExpandedId(expandedId === j.id ? null : j.id)}
                  onStop={() => onStop(j.id)}
                  onRetry={() => onRetry(j.id)}
                  onPromote={() => onPromote(j.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface JobRowProps {
  job: AdminJobDto;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  onRetry: () => void;
  onPromote: () => void;
}

function JobRow({ job, expanded, onToggle, onStop, onRetry, onPromote }: JobRowProps) {
  const isAiOwned = job.owner_module === 'ai';
  const canStop = isAiOwned && ['active', 'waiting', 'delayed'].includes(job.status);
  const canRetry = isAiOwned && job.status === 'failed';
  const canPromote = isAiOwned && job.status === 'delayed';
  const canTail = Boolean(job.stream_key) && ['active', 'waiting', 'completed'].includes(job.status);

  return (
    <>
      <tr className="border-t border-[var(--gray-6)] hover:bg-[var(--gray-2)]">
        <td className="px-3 py-2 align-top">
          {canTail ? (
            <button type="button" onClick={onToggle} aria-label="Toggle live tail">
              {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
            </button>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top">
          <div className="font-mono text-xs">{job.name}</div>
          <div className="text-[var(--gray-10)] text-xs">{job.id}</div>
        </td>
        <td className={`px-3 py-2 align-top ${STATUS_COLORS[job.status]}`}>{STATUS_LABELS[job.status]}</td>
        <td className="px-3 py-2 align-top text-[var(--gray-11)]">{timeAgo(job.created_at)}</td>
        <td className="px-3 py-2 align-top text-[var(--gray-11)]">
          {job.attempts_made} / {job.attempts_made + job.attempts_remaining}
        </td>
        <td className="px-3 py-2 align-top">
          {job.linked_row ? (
            <span className="text-xs">
              <span className="text-[var(--gray-10)]">{job.linked_row.table}</span>
              <br />
              <span className="font-mono">{job.linked_row.id.slice(0, 8)}…</span>
            </span>
          ) : (
            <span className="text-[var(--gray-9)]">—</span>
          )}
        </td>
        <td className="px-3 py-2 align-top text-right">
          {canStop && (
            <Button variant="outline" size="sm" onClick={onStop} className="ml-1">
              <StopCircleIcon className="size-4" />
            </Button>
          )}
          {canRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} className="ml-1">
              Retry
            </Button>
          )}
          {canPromote && (
            <Button variant="outline" size="sm" onClick={onPromote} className="ml-1">
              Promote
            </Button>
          )}
        </td>
      </tr>
      {expanded && job.stream_key && (
        <tr className="border-t border-[var(--gray-6)]">
          <td colSpan={7} className="px-3 py-3 bg-[var(--gray-2)]">
            <LiveTail jobId={job.id} jobStatus={job.status} />
            {job.failed_reason && (
              <div className="mt-2 text-red-600 text-xs">
                <span className="font-semibold">Failure reason:</span> {job.failed_reason}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

interface StreamEntry {
  id: string;
  raw: Record<string, unknown>;
}

function LiveTail({ jobId, jobStatus }: { jobId: string; jobStatus: JobStatus }) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = JobsService.streamUrl(jobId, '0');
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const onMessage = (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data) as Record<string, unknown>;
        setEntries((prev) => [...prev.slice(-199), { id: ev.lastEventId || String(Date.now()), raw: data }]);
      } catch {
        // Ignore unparseable lines (heartbeats arrive as comment-only frames).
      }
    };
    es.onmessage = onMessage;
    // Listen on the specific event types so EventSource fires them too.
    for (const type of [
      'run.start',
      'step.start',
      'step.complete',
      'token',
      'tool_call',
      'tool_result',
      'assistant.complete',
      'run.complete',
      'run.failed',
      'run.cancelled',
      'close',
    ]) {
      es.addEventListener(type, onMessage as EventListener);
    }
    es.onerror = (): void => {
      // EventSource auto-reconnects; surface only when we're not in a
      // terminal state.
      if (['completed', 'failed'].includes(jobStatus)) {
        es?.close();
      }
    };
    return () => {
      es?.close();
    };
  }, [jobId, jobStatus]);

  if (error) {
    return <div className="text-red-600 text-xs">Stream error: {error}</div>;
  }
  if (entries.length === 0) {
    return <div className="text-[var(--gray-10)] text-xs">Waiting for events…</div>;
  }
  return (
    <div className="font-mono text-xs space-y-1 max-h-72 overflow-auto">
      {entries.map((e) => (
        <div key={e.id} className="border-l-2 border-[var(--gray-6)] pl-2">
          <span className="text-[var(--gray-10)]">{(e.raw.type as string) ?? 'event'}</span>{' '}
          <span className="text-[var(--gray-12)]">
            {JSON.stringify(
              Object.fromEntries(Object.entries(e.raw).filter(([k]) => k !== 'type' && k !== 'ts')),
            ).slice(0, 200)}
          </span>
        </div>
      ))}
    </div>
  );
}
