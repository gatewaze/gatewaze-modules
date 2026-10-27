import { useState } from 'react';
import { ArrowPathIcon, CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { api, eventKey, type SyncNowResult } from './client';
import { refreshEventLedger, useEventLedger } from './useEventLedger';

/**
 * Cvent line on the event's Registrations tab (slot `event-registrations:status`).
 * Shows how many active registrations are in Cvent and lets the organiser
 * push the rest or retry failures without leaving the tab. Renders nothing
 * for events that have no Cvent event id, so the tab stays clean elsewhere.
 */

interface Props {
  eventId: string;
  eventUuid?: string;
  brandId?: string;
}

export function CventRegistrationsStatus({ eventId, eventUuid }: Props) {
  const id = eventKey(eventId, eventUuid);
  const { ledger, refresh } = useEventLedger(id);
  const [syncing, setSyncing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (!ledger || !ledger.configured) return null;

  const s = ledger.status;
  const active = s.active ?? 0;
  const synced = s.synced ?? 0;
  const pending = s.pending ?? 0;
  const failed = s.failed ?? 0;
  const allIn = active > 0 && synced >= active && failed === 0;

  async function syncNow() {
    setSyncing(true);
    try {
      const data = await api<SyncNowResult>(`/events/${id}/sync-now`, { method: 'POST' });
      if (data.aborted) toast.error(`Cvent sync stopped: ${data.aborted}`);
      else if (data.remaining) toast.success(`Pushed ${data.created + data.alreadyExists} so far; the worker is finishing the rest.`);
      else toast.success(`Cvent: ${data.created} new, ${data.alreadyExists} already there, ${data.failed} failed`);
    } catch (err) {
      toast.error('Cvent sync failed: ' + (err as Error).message);
    } finally {
      setSyncing(false);
      await refreshEventLedger(id);
    }
  }

  async function retryFailed() {
    setRetrying(true);
    try {
      const data = await api<{ reset: number }>(`/events/${id}/retry-failed`, { method: 'POST' });
      toast.success(`${data.reset} registration${data.reset === 1 ? '' : 's'} will be retried`);
    } catch (err) {
      toast.error('Could not reset: ' + (err as Error).message);
    } finally {
      setRetrying(false);
      await refreshEventLedger(id);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 p-3 rounded-md bg-[var(--gray-a2)] border border-[var(--gray-a5)] text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium text-[var(--gray-12)]">Cvent badges</span>
        {ledger.syncEnabled ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">
            <CheckCircleIcon className="w-3.5 h-3.5" />
            Live sync on
          </span>
        ) : (
          <span className="text-xs font-medium text-[var(--gray-11)] bg-[var(--gray-a3)] px-2 py-0.5 rounded-full">Live sync off</span>
        )}
      </div>

      <div className="flex items-center gap-3 text-[var(--gray-11)]">
        <span className={allIn ? 'text-green-600 dark:text-green-400 font-medium' : ''}>
          {synced} of {active} in Cvent
        </span>
        {pending > 0 && <span>{pending} pending</span>}
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
            <ExclamationCircleIcon className="w-4 h-4" />
            {failed} failed
          </span>
        )}
        {s.last_synced_at && <span className="text-xs">Last synced {new Date(s.last_synced_at).toLocaleTimeString()}</span>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {failed > 0 && (
          <Button variant="soft" size="sm" onClick={retryFailed} loading={retrying} disabled={retrying}>
            Retry failed
          </Button>
        )}
        {!ledger.syncEnabled && (
          <Button
            variant="soft"
            size="sm"
            onClick={syncNow}
            loading={syncing}
            disabled={syncing || !ledger.credentialsConfigured}
            title={ledger.credentialsConfigured ? 'Push pending registrants to Cvent now' : 'Set the Cvent credentials under Modules → Cvent first'}
          >
            <ArrowPathIcon className="w-4 h-4" />
            Sync now
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Refresh">
          <ArrowPathIcon className="w-4 h-4" />
        </Button>
      </div>

      {s.last_error && (
        <p className="basis-full text-xs text-red-500 dark:text-red-400 break-words">Last error: {s.last_error}</p>
      )}
      {ledger.truncated && (
        <p className="basis-full text-xs text-[var(--gray-10)]">
          Too many registrations to label each row; the counts above are complete.
        </p>
      )}
      {ledger.error && <p className="basis-full text-xs text-[var(--gray-10)]">Status may be stale: {ledger.error}</p>}
    </div>
  );
}

export default CventRegistrationsStatus;
