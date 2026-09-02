import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChartBarIcon,
  ExclamationTriangleIcon,
  InboxArrowDownIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { Spinner } from '@/components/ui/Spinner';
import { ModuleSlot } from '@/components/ModuleSlot';
import SendTestingService, { type SendTestRun } from '../lib/sendTestingService';
import { TAB_ICON, sendTestingTabs } from './index';

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--gray-11)]">{label}</div>
      <div className="text-2xl font-semibold text-[var(--gray-12)] mt-1">{value}</div>
      {hint && <div className="text-xs text-[var(--gray-11)] mt-1">{hint}</div>}
    </Card>
  );
}

/**
 * Arrival rate over the run window. Deliberately a plain bar strip rather than
 * a charting dependency: the shape is the whole point (timezone waves, or a
 * flat gap where the pipeline stalled) and it has to stay readable in both
 * themes.
 */
function ArrivalsChart({ buckets }: { buckets: { bucket_start: string; count: number }[] }) {
  if (buckets.length === 0) {
    return <div className="text-sm text-[var(--gray-11)]">No arrivals recorded yet.</div>;
  }
  const peak = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div>
      <div className="flex items-end gap-px h-32" role="img" aria-label="Arrivals over time">
        {buckets.map((bucket) => (
          <div
            key={bucket.bucket_start}
            className="flex-1 bg-[var(--accent-9)] min-w-[2px] rounded-t-sm"
            style={{ height: `${Math.max((bucket.count / peak) * 100, bucket.count > 0 ? 2 : 0)}%` }}
            title={`${new Date(bucket.bucket_start).toLocaleTimeString()} — ${bucket.count} arrivals`}
          />
        ))}
      </div>
      <div className="flex justify-between text-xs text-[var(--gray-11)] mt-1">
        <span>{new Date(buckets[0].bucket_start).toLocaleTimeString()}</span>
        <span>peak {peak.toLocaleString()} per bucket</span>
        <span>{new Date(buckets[buckets.length - 1].bucket_start).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

export default function SendTestRunPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<SendTestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Second row: the run's own sections, mirroring how an edition splits into
  // Editor / Details / Sending under the newsletter tabs.
  const [subTab, setSubTab] = useState<'results' | 'placement' | 'notes'>('results');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRun(await SendTestingService.getRun(id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // While the run is open the numbers are computed live, so refresh on a timer.
  // Closed runs serve a materialised summary and need no polling.
  useEffect(() => {
    if (run?.status !== 'open') return;
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [run?.status, load]);

  async function handleClose() {
    if (!run) return;
    setBusy(true);
    try {
      await SendTestingService.updateRun(run.id, { status: 'closed' });
      toast.success('Run closed; attributing arrivals');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not close run');
    } finally {
      setBusy(false);
    }
  }

  async function handleReattribute() {
    if (!run) return;
    setBusy(true);
    try {
      await SendTestingService.reattribute(run.id);
      toast.success('Re-attribution queued');
      setTimeout(load, 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-attribution failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Page title="Test run">
        <div className="flex items-center justify-center py-24">
          <Spinner />
        </div>
      </Page>
    );
  }

  if (!run) {
    return (
      <Page title="Test run">
        <div className="p-6 text-sm text-[var(--gray-11)]">Run not found.</div>
      </Page>
    );
  }

  const results = run.results;
  const isExternal = run.send_source === 'external';

  return (
    <Page title={`Test run — ${run.name}`}>
      <WorkspaceLayout
        title="Send Testing"
        tabs={sendTestingTabs()}
        activeTabId="runs"
        onTabChange={(t) => navigate(t === 'runs' ? '/send-testing' : `/send-testing/${t}`)}
        breadcrumbs={[{ label: 'Runs', to: '/send-testing' }, { label: run.name }]}
        onBreadcrumbNavigate={(to) => navigate(to)}
        subTabs={[
          { id: 'results', label: 'Results', icon: <ChartBarIcon className={TAB_ICON} /> },
          { id: 'placement', label: 'Placement', icon: <InboxArrowDownIcon className={TAB_ICON} /> },
          { id: 'notes', label: 'Notes', icon: <ShieldCheckIcon className={TAB_ICON} /> },
        ]}
        activeSubTabId={subTab}
        onSubTabChange={(t) => setSubTab(t as typeof subTab)}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={run.status === 'open' ? 'green' : 'blue'}>{run.status}</Badge>
            {run.status === 'open' ? (
              <Button variant="solid" onClick={handleClose} disabled={busy}>
                Close run
              </Button>
            ) : (
              <Button variant="outline" onClick={handleReattribute} disabled={busy}>
                <ArrowPathIcon className="h-4 w-4 mr-1" />
                Re-attribute &amp; recompute
              </Button>
            )}
          </div>
        }
      >
      <div className="p-6 space-y-6">
        <p className="text-sm text-[var(--gray-11)]">
          Opened {new Date(run.started_at).toLocaleString()}
          {run.closed_at && ` · closed ${new Date(run.closed_at).toLocaleString()}`}
          {run.send_source && ` · ${run.send_source}`}
          {run.subject_filter && ` · subject contains “${run.subject_filter}”`}
        </p>

        {run.no_sends_detected && (
          <Card className="p-4 border-l-4 border-l-[var(--amber-9)]">
            <div className="flex gap-3 text-sm">
              <ExclamationTriangleIcon className="h-5 w-5 text-[var(--amber-11)] shrink-0" />
              <div>
                <p className="font-medium text-[var(--gray-12)]">No sends detected</p>
                <p className="text-[var(--gray-11)] mt-1">
                  This run has been open for over ten minutes and nothing has been dispatched to a
                  test address. For a broadcast, the usual cause is an unsubscribe category list
                  other than Bulk Send Testing: the audience is intersected with it, so the send
                  resolves to zero recipients and looks identical to a pipeline that never ran.
                </p>
              </div>
            </div>
          </Card>
        )}

        {run.attribution_status === 'failed' && (
          <Card className="p-4 border-l-4 border-l-[var(--red-9)]">
            <div className="flex gap-3 text-sm">
              <ExclamationTriangleIcon className="h-5 w-5 text-[var(--red-11)] shrink-0" />
              <div>
                <p className="font-medium text-[var(--gray-12)]">Attribution failed</p>
                <p className="text-[var(--gray-11)] mt-1 break-words">
                  {run.attribution_error ?? 'Unknown error'}
                </p>
                <p className="text-[var(--gray-11)] mt-1">
                  The figures below may be incomplete. Re-attribution is safe to retry.
                </p>
              </div>
            </div>
          </Card>
        )}

        {typeof run.unattributed_in_window === 'number' && run.unattributed_in_window > 0 && (
          <Card className="p-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <div>
                <span className="font-medium text-[var(--gray-12)]">
                  {run.unattributed_in_window.toLocaleString()} unattributed arrivals
                </span>
                <span className="text-[var(--gray-11)]">
                  {' '}
                  landed inside this run's window — most likely stragglers delayed past close.
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={handleReattribute} disabled={busy}>
                Fold them in
              </Button>
            </div>
          </Card>
        )}

        {subTab === 'results' && (
          <>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat
            label="Completion"
            value={results ? `${results.completion_percent}%` : '—'}
            hint={
              results
                ? `${results.arrival_count.toLocaleString()} of ${results.expected_count.toLocaleString()} confirmed`
                : undefined
            }
          />
          <Stat
            label="Median latency"
            value={results?.latency_ms ? formatMs(results.latency_ms.p50) : '—'}
            hint={
              results?.latency_ms
                ? `${results.latency_ms.matched.toLocaleString()} matched to a dispatch`
                : isExternal
                  ? 'Not available for external sends'
                  : 'No send timestamps yet'
            }
          />
          <Stat
            label="Slowest 1%"
            value={results?.latency_ms ? formatMs(results.latency_ms.p99) : '—'}
            hint={results?.latency_ms ? `max ${formatMs(results.latency_ms.max)}` : undefined}
          />
          <Stat
            label="Failures"
            value={
              results?.send_log
                ? (results.send_log.failed + results.send_log.bounced).toLocaleString()
                : '—'
            }
            hint={
              results?.send_log
                ? `${results.send_log.bounced.toLocaleString()} bounced, ${results.send_log.failed.toLocaleString()} failed`
                : undefined
            }
          />
        </div>

        {isExternal && (
          <Card className="p-4 text-sm text-[var(--gray-11)]">
            This run was sent from an external system, so there are no send-side timestamps in this
            database. Completion and arrival spread are measured; per-message latency is not, and is
            reported as unavailable rather than as zero.
          </Card>
        )}

        <Card className="p-4">
          <div className="text-sm font-medium text-[var(--gray-12)] mb-3">Arrivals over time</div>
          <ArrivalsChart buckets={results?.arrivals_histogram ?? []} />
          <p className="text-xs text-[var(--gray-11)] mt-2">
            A timezone-aware send shows distinct waves. A flat gap is a stall that no percentile
            would reveal.
          </p>
        </Card>

        {results && results.auth.evaluated > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--gray-12)]">Authentication results</div>
            <p className="text-xs text-[var(--gray-11)] mt-1">
              Read from the messages that arrived. A cheap leading indicator of placement trouble:
              if DKIM fails here it will fail at Gmail too.
            </p>
            <div className="grid grid-cols-3 gap-4 mt-3 text-sm">
              {(['spf', 'dkim', 'dmarc'] as const).map((mech) => {
                const passed = results.auth[`${mech}_pass` as const];
                const share = Math.round((passed / results.auth.evaluated) * 100);
                return (
                  <div key={mech}>
                    <div className="text-[var(--gray-11)] uppercase text-xs">{mech}</div>
                    <div className="text-[var(--gray-12)] font-medium flex items-center gap-1">
                      {share === 100 && <CheckCircleIcon className="h-4 w-4 text-[var(--green-11)]" />}
                      {share}% pass
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
          </>
        )}

        {/* Filled by send-testing-glockapps when installed; renders nothing otherwise,
            which is what keeps placement optional rather than a hard dependency. */}
        {subTab === 'placement' && (
          <ModuleSlot name="send-test-run-detail:panels" props={{ run, runId: run.id, reload: load }} />
        )}

        {subTab === 'notes' && (
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--gray-12)]">Notes</div>
            {run.notes ? (
              <p className="text-sm text-[var(--gray-11)] mt-1 whitespace-pre-wrap">{run.notes}</p>
            ) : (
              <p className="text-sm text-[var(--gray-11)] mt-1">
                No notes recorded for this run. Pacing, template and sender details are worth
                capturing here — they are what make an old run comparable to a new one.
              </p>
            )}
          </Card>
        )}
      </div>
      </WorkspaceLayout>
    </Page>
  );
}
