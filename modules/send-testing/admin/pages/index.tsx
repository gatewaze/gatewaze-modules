import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  BeakerIcon,
  ExclamationTriangleIcon,
  InboxArrowDownIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, ConfirmModal, Modal } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { Spinner } from '@/components/ui/Spinner';
import SendTestingService, {
  type ModuleStatus,
  type ProvisionStatus,
  type SendTestRun,
} from '../lib/sendTestingService';

const inputCls =
  'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

function statusTone(status: SendTestRun['status']): 'green' | 'gray' | 'blue' {
  if (status === 'open') return 'green';
  if (status === 'closed') return 'blue';
  return 'gray';
}

export default function SendTestingIndexPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ModuleStatus | null>(null);
  const [provision, setProvision] = useState<ProvisionStatus | null>(null);
  const [runs, setRuns] = useState<SendTestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [showProvision, setShowProvision] = useState(false);
  const [targetCount, setTargetCount] = useState('');
  const [showDeprovision, setShowDeprovision] = useState(false);
  const [showStartRun, setShowStartRun] = useState(false);
  const [runName, setRunName] = useState('');
  const [runSource, setRunSource] = useState('broadcast');
  const [runSubject, setRunSubject] = useState('');
  const [runNotes, setRunNotes] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, p, r] = await Promise.all([
        SendTestingService.getStatus(),
        SendTestingService.getProvisionStatus(),
        SendTestingService.listRuns({ pageSize: 25 }),
      ]);
      setStatus(s);
      setProvision(p);
      setRuns(r.data);
      if (!targetCount) setTargetCount(String(s.default_population_size || 25000));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load send-testing status');
    } finally {
      setLoading(false);
    }
  }, [targetCount]);

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only while a job is actually running, and stop as soon as it settles.
  useEffect(() => {
    if (provision?.job_state !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const next = await SendTestingService.getProvisionStatus();
        setProvision(next);
        if (next.job_state !== 'running') {
          const s = await SendTestingService.getStatus();
          setStatus(s);
          if (next.job_state === 'failed') toast.error(next.last_error || 'Provisioning failed');
          else if (next.job_state === 'no_change') toast.info('Population already at that size');
          else toast.success('Provisioning finished');
        }
      } catch {
        // Transient polling failures are not worth a toast per tick.
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [provision?.job_state]);

  const openRun = runs.find((r) => r.status === 'open') ?? null;

  async function handleProvision() {
    const target = Number(targetCount);
    if (!Number.isInteger(target) || target < 1) {
      toast.error('Enter a positive whole number');
      return;
    }
    setBusy(true);
    try {
      await SendTestingService.provision(target);
      setShowProvision(false);
      toast.success('Provisioning started');
      setProvision(await SendTestingService.getProvisionStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeprovision() {
    setBusy(true);
    try {
      await SendTestingService.deprovision();
      setShowDeprovision(false);
      toast.success('Deletion started');
      setProvision(await SendTestingService.getProvisionStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Deletion failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleResubscribe() {
    setBusy(true);
    try {
      await SendTestingService.resubscribe();
      toast.success('Resetting subscriptions');
      setProvision(await SendTestingService.getProvisionStatus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleStartRun() {
    if (!runName.trim()) {
      toast.error('Give the run a name');
      return;
    }
    setBusy(true);
    try {
      const run = await SendTestingService.createRun({
        name: runName.trim(),
        send_source: runSource,
        subject_filter: runSubject.trim() || undefined,
        notes: runNotes.trim() || undefined,
      });
      setShowStartRun(false);
      setRunName('');
      setRunSubject('');
      setRunNotes('');
      toast.success('Run opened');
      navigate(`/send-testing/runs/${run.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open run');
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    try {
      await SendTestingService.downloadCsv();
      toast.success('Export started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  }

  if (loading) {
    return (
      <Page title="Send Testing">
        <div className="flex items-center justify-center py-24">
          <Spinner />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Send Testing">
      <div className="p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-[var(--gray-12)] flex items-center gap-2">
              <BeakerIcon className="h-5 w-5" />
              Send Testing
            </h1>
            <p className="text-sm text-[var(--gray-11)] mt-1 max-w-3xl">
              Rehearse a large send against synthetic recipients, then measure what actually
              arrived. This module does not send: point any broadcast or newsletter at the{' '}
              <strong>Bulk Send Testing</strong> list, or export the list and send from an external
              system.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" onClick={handleExport}>
              <ArrowDownTrayIcon className="h-4 w-4 mr-1" />
              Export list (CSV)
            </Button>
            <Button
              onClick={() => setShowStartRun(true)}
              disabled={!status?.domain_configured || Boolean(openRun)}
            >
              <PlayIcon className="h-4 w-4 mr-1" />
              Start test run
            </Button>
          </div>
        </div>

        {!status?.domain_configured && (
          <Card className="p-4 border-l-4 border-l-[var(--amber-9)]">
            <div className="flex gap-3">
              <ExclamationTriangleIcon className="h-5 w-5 text-[var(--amber-11)] shrink-0" />
              <div className="text-sm space-y-2">
                <p className="font-medium text-[var(--gray-12)]">Setup needed before any run</p>
                <ol className="list-decimal ml-4 space-y-1 text-[var(--gray-11)]">
                  <li>
                    Set <code>inbound_domain</code> and <code>inbound_token</code> in this module's
                    configuration.
                  </li>
                  <li>
                    Point that domain's MX records at SendGrid Inbound Parse.
                  </li>
                  <li>
                    Add an Inbound Parse binding for the host, targeting the{' '}
                    <code>send-test-inbound</code> edge function with the token in the URL.
                  </li>
                  <li>
                    Send one probe message to an <code>st-000001@…</code> address and confirm it
                    appears, before provisioning 25,000 people.
                  </li>
                </ol>
                <p className="text-[var(--gray-11)]">
                  Inbound Parse offers no request signing, so the URL token is the only
                  authentication the receiver can have. Treat it as a secret.
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--gray-11)]">
              Test population
            </div>
            <div className="text-2xl font-semibold text-[var(--gray-12)] mt-1">
              {status?.population.toLocaleString() ?? '—'}
            </div>
            <div className="text-xs text-[var(--gray-11)] mt-1">
              at {status?.inbound_domain || 'no domain configured'}
            </div>
            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowProvision(true)}
                disabled={!status?.domain_configured || provision?.job_state === 'running'}
              >
                Provision
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowDeprovision(true)}
                disabled={!status?.population || provision?.job_state === 'running'}
              >
                <TrashIcon className="h-4 w-4 mr-1" />
                Delete all
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--gray-11)]">
              Unsubscribed
            </div>
            <div className="text-2xl font-semibold text-[var(--gray-12)] mt-1">
              {status?.unsubscribed_count.toLocaleString() ?? '—'}
            </div>
            <div className="text-xs text-[var(--gray-11)] mt-1">
              Unsubscribes are kept, not auto-reverted, so an unsubscribe test stays valid. They do
              shrink the next run's audience.
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={handleResubscribe}
              disabled={busy || !status?.unsubscribed_count || provision?.job_state === 'running'}
            >
              <ArrowPathIcon className="h-4 w-4 mr-1" />
              Reset subscriptions
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-[var(--gray-11)]">
              Provisioning job
            </div>
            <div className="text-2xl font-semibold text-[var(--gray-12)] mt-1 capitalize">
              {provision?.job_state ?? 'idle'}
            </div>
            {provision?.job_state === 'running' && (
              <div className="text-xs text-[var(--gray-11)] mt-1">
                {provision.processed.toLocaleString()} of{' '}
                {(provision.target_count ?? 0).toLocaleString()} processed
              </div>
            )}
            {provision?.job_state === 'failed' && provision.last_error && (
              <div className="text-xs text-[var(--red-11)] mt-1 break-words">
                {provision.last_error}
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="mt-3"
              onClick={() => navigate('/send-testing/inbox/inspectable')}
            >
              <InboxArrowDownIcon className="h-4 w-4 mr-1" />
              Test inboxes
            </Button>
          </Card>
        </div>

        {(status?.postmaster_url || status?.snds_url) && (
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--gray-12)]">Reputation monitoring</div>
            <p className="text-xs text-[var(--gray-11)] mt-1">
              Neither service uses test recipients: Postmaster Tools needs a DNS-verified sending
              domain, SNDS needs registered sending IPs. Both report on real traffic over time, so
              register before the real send.
            </p>
            <div className="flex gap-3 mt-2 text-sm">
              {status.postmaster_url && (
                <a
                  className="text-[var(--accent-11)] hover:underline"
                  href={status.postmaster_url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Google Postmaster Tools
                </a>
              )}
              {status.snds_url && (
                <a
                  className="text-[var(--accent-11)] hover:underline"
                  href={status.snds_url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Microsoft SNDS
                </a>
              )}
            </div>
          </Card>
        )}

        <Card>
          <div className="p-4 border-b border-[var(--gray-a5)] flex items-center justify-between">
            <div className="text-sm font-medium text-[var(--gray-12)]">Test runs</div>
            {openRun && (
              <Badge color="green">
                Run open: {openRun.name}
              </Badge>
            )}
          </div>
          {runs.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--gray-11)]">
              No runs yet. Open one, then send to the Bulk Send Testing list.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--gray-11)]">
                  <th className="px-4 py-2 font-medium">Run</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium text-right">Expected</th>
                  <th className="px-4 py-2 font-medium text-right">Arrived</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-t border-[var(--gray-a5)] hover:bg-[var(--gray-a2)] cursor-pointer"
                    onClick={() => navigate(`/send-testing/runs/${run.id}`)}
                  >
                    <td className="px-4 py-2 text-[var(--gray-12)]">{run.name}</td>
                    <td className="px-4 py-2">
                      <Badge color={statusTone(run.status)}>{run.status}</Badge>
                      {run.attribution_status === 'failed' && (
                        <Badge color="red" className="ml-1">
                          attribution failed
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[var(--gray-11)]">{run.send_source ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-[var(--gray-11)]">
                      {run.expected_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right text-[var(--gray-11)]">
                      {(run.arrival_count ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-[var(--gray-11)]">
                      {new Date(run.started_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Modal
        isOpen={showProvision}
        onClose={() => setShowProvision(false)}
        title="Provision test people"
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">
            Creates synthetic people up to this total and subscribes them to the Bulk Send Testing
            list. Top-up only: a smaller number changes nothing, and shrinking is a separate delete
            action.
          </p>
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Target total</span>
            <input
              className={inputCls}
              value={targetCount}
              onChange={(e) => setTargetCount(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowProvision(false)}>
              Cancel
            </Button>
            <Button onClick={handleProvision} disabled={busy}>
              Start
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={showDeprovision}
        onClose={() => setShowDeprovision(false)}
        onConfirm={handleDeprovision}
        title="Delete all test people"
        confirmText="Delete"
        confirmColor="red"
        message={`This permanently deletes ${(status?.population ?? 0).toLocaleString()} synthetic people and their subscriptions. Only rows created by this module at ${status?.inbound_domain} are affected; real people cannot be touched. Past runs stay, but stop being comparable.`}
      />

      <Modal isOpen={showStartRun} onClose={() => setShowStartRun(false)} title="Start test run">
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Name</span>
            <input
              className={inputCls}
              value={runName}
              onChange={(e) => setRunName(e.target.value)}
              placeholder="25k rehearsal"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Send source</span>
            <select
              className={inputCls}
              value={runSource}
              onChange={(e) => setRunSource(e.target.value)}
            >
              <option value="broadcast">Broadcast</option>
              <option value="newsletter">Newsletter</option>
              <option value="external">External system (LFX, other ESP)</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Subject filter (optional)</span>
            <input
              className={inputCls}
              value={runSubject}
              onChange={(e) => setRunSubject(e.target.value)}
              placeholder="A distinctive part of the subject line"
            />
            <span className="text-xs text-[var(--gray-11)]">
              Recommended for back-to-back runs: a straggler from the previous send can otherwise
              land inside this run's window.
            </span>
          </label>
          <label className="block text-sm">
            <span className="text-[var(--gray-11)]">Notes (optional)</span>
            <textarea
              className={inputCls}
              rows={2}
              value={runNotes}
              onChange={(e) => setRunNotes(e.target.value)}
              placeholder="Pacing, template, anything worth comparing later"
            />
          </label>

          <div className="rounded-md bg-[var(--amber-a3)] p-3 text-xs text-[var(--gray-12)] space-y-1">
            <p className="font-medium">Before you send</p>
            <ul className="list-disc ml-4 space-y-0.5">
              <li>
                For a broadcast, set the unsubscribe category list to <strong>Bulk Send
                Testing</strong> as well. The audience is intersected with it, so any other choice
                resolves to zero recipients.
              </li>
              <li>
                Expected recipients are snapshotted now:{' '}
                <strong>{(status?.population ?? 0).toLocaleString()}</strong> subscribed test people.
              </li>
              {runSource === 'external' && (
                <li>
                  Export the CSV from this page and send to exactly that list, so the denominator
                  matches.
                </li>
              )}
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowStartRun(false)}>
              Cancel
            </Button>
            {runSource === 'external' && (
              <Button variant="secondary" onClick={handleExport}>
                <ArrowDownTrayIcon className="h-4 w-4 mr-1" />
                Download CSV
              </Button>
            )}
            <Button onClick={handleStartRun} disabled={busy}>
              Open run
            </Button>
          </div>
        </div>
      </Modal>
    </Page>
  );
}
