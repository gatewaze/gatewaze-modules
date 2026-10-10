/**
 * Schedule-import card for the Agenda tab
 * (spec-event-agenda-schedule-import §10, §6.4).
 *
 * Shows where this event's programme comes from, the state of the last
 * import, and the two actions an operator has: run it, or point it somewhere
 * else. Kept as its own component because EventAgendaTab is already long and
 * this has nothing to do with hand-building entries.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, Input } from '@/components/ui';
import {
  getScheduleImport,
  runScheduleImport,
  setScheduleSource,
  describeStats,
  type ScheduleImportState,
  type ScheduleImportStatus,
} from './utils/scheduleImportService';

interface Props {
  eventUuid: string;
  /** Called after a successful import so the timeline can reload. */
  onImported?: () => void;
}

const STATUS_LABEL: Record<ScheduleImportStatus, string> = {
  pending: 'Not imported yet',
  unavailable: 'No programme published yet',
  importing: 'Importing…',
  complete: 'Imported',
  failed: 'Last import failed',
};

const STATUS_TONE: Record<ScheduleImportStatus, string> = {
  pending: 'text-gray-500 dark:text-gray-400',
  unavailable: 'text-amber-600 dark:text-amber-400',
  importing: 'text-primary-600 dark:text-primary-400',
  complete: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
};

function relative(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function ScheduleImportCard({ eventUuid, onImported }: Props) {
  const [state, setState] = useState<ScheduleImportState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editingSource, setEditingSource] = useState(false);
  const [sourceInput, setSourceInput] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await getScheduleImport(eventUuid);
      setState(next);
      setSourceInput(next.import?.schedule_url ?? '');
      return next;
    } catch {
      // A module installed without its routes mounted should not break the tab.
      setState(null);
      return null;
    }
  }, [eventUuid]);

  useEffect(() => {
    void (async () => { await load(); setLoading(false); })();
  }, [load]);

  // Poll only while a run is in flight.
  useEffect(() => {
    if (state?.import?.status !== 'importing') return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [state?.import?.status, load]);

  async function handleRun(force: boolean) {
    setBusy(true);
    try {
      await runScheduleImport(eventUuid, force);
      toast.success('Import queued');
      const next = await load();
      if (next?.import?.status === 'complete') onImported?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the import');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSource() {
    setBusy(true);
    try {
      await setScheduleSource(eventUuid, sourceInput.trim() || null);
      toast.success(sourceInput.trim() ? 'Schedule source saved' : 'Reverted to the event’s own link');
      setEditingSource(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the source');
    } finally {
      setBusy(false);
    }
  }

  if (loading || !state) return null;

  const imp = state.import;
  const status: ScheduleImportStatus = imp?.status ?? 'pending';
  const source = imp?.resolved_source_url ?? imp?.schedule_url ?? state.candidate_source_url;
  const stale = imp?.stats?.stale ?? [];
  const running = status === 'importing';

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Programme import</h3>
            <span className={`text-xs font-medium ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
            {imp?.last_success_at && status === 'complete' && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{relative(imp.last_success_at)}</span>
            )}
          </div>

          <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 break-all">
            {source ? (
              <>
                Source: <span className="font-mono">{source}</span>
                <span className="ml-1 text-gray-400">
                  ({imp?.url_origin === 'manual' ? 'set by hand' : 'from the event'})
                </span>
              </>
            ) : (
              <>No schedule link on this event yet — add one to import its programme.</>
            )}
          </div>

          {status === 'complete' && (
            <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">{describeStats(imp?.stats)}</div>
          )}
          {status === 'failed' && imp?.error && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">{imp.error}</div>
          )}
          {status === 'unavailable' && (
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The page resolved but publishes no programme yet. It will be retried automatically.
            </div>
          )}
          {stale.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-amber-600 dark:text-amber-400 cursor-pointer">
                {stale.length} entr{stale.length === 1 ? 'y is' : 'ies are'} no longer in the source
              </summary>
              <ul className="mt-1 ml-4 list-disc text-xs text-gray-500 dark:text-gray-400">
                {stale.slice(0, 20).map((s) => <li key={s} className="font-mono break-all">{s}</li>)}
              </ul>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                These are kept, not deleted — remove them by hand if they really are gone.
              </p>
            </details>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => void handleRun(false)}
            disabled={busy || running || !source}
            title={!source ? 'Add a schedule link first' : undefined}
          >
            {running ? 'Importing…' : state.has_run ? 'Re-import' : 'Import schedule'}
          </Button>
          {state.has_run && (
            <Button variant="outline" onClick={() => void handleRun(true)} disabled={busy || running}
              title="Re-read the programme even if it has not changed">
              Force
            </Button>
          )}
          <Button variant="outline" onClick={() => setEditingSource((v) => !v)} disabled={busy}>
            {editingSource ? 'Cancel' : 'Change source'}
          </Button>
        </div>
      </div>

      {editingSource && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
            Schedule URL — the event’s sched.com page, or the Linux Foundation page that embeds it
          </label>
          <div className="flex gap-2">
            <Input
              value={sourceInput}
              placeholder="https://myevent.sched.com/"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSourceInput(e.target.value)}
            />
            <Button onClick={() => void handleSaveSource()} disabled={busy}>Save</Button>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Leave empty to go back to the link on the event itself. Imported entries stay editable here,
            and anything you change by hand survives the next import.
          </p>
        </div>
      )}
    </Card>
  );
}

export default ScheduleImportCard;
