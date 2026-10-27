import { useCallback, useEffect, useState } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Card, Input } from '@/components/ui';
import { api, eventKey, type SyncNowResult, type SyncStatus } from './api';
import { refreshEventLedger } from './useEventLedger';

/**
 * Cvent tab on the event detail page.
 *
 * Everything goes through the module's own API (/api/modules/cvent/*), which
 * checks the caller is an admin. The tab never reads or writes tables directly.
 */

interface CventSettings {
  cvent_event_id: string | null;
  cvent_event_code: string | null;
  cvent_admission_item_id: string | null;
  cvent_sync_enabled: boolean;
}

interface AdmissionItem {
  id: string;
  name: string;
  code?: string;
}

interface Registrant {
  id: string;
  email: string;
  name: string;
  status: string;
}

interface CventTabProps {
  /** events.id (uuid) — the host passes the uuid as eventId for module tabs. */
  eventId: string;
  eventUuid?: string;
}

const EMPTY: CventSettings = {
  cvent_event_id: null,
  cvent_event_code: null,
  cvent_admission_item_id: null,
  cvent_sync_enabled: false,
};

export function CventTab({ eventId, eventUuid }: CventTabProps) {
  const id = eventKey(eventId, eventUuid);

  const [settings, setSettings] = useState<CventSettings>(EMPTY);
  const [status, setStatus] = useState<SyncStatus>({});
  const [credentialsConfigured, setCredentialsConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [admissionItems, setAdmissionItems] = useState<AdmissionItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null);
  const [retrying, setRetrying] = useState(false);

  const [registrantSearch, setRegistrantSearch] = useState('');
  const [registrants, setRegistrants] = useState<Registrant[]>([]);
  const [selectedRegistrantId, setSelectedRegistrantId] = useState('');
  const [testSyncing, setTestSyncing] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; action?: string; error?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ settings: CventSettings; status: SyncStatus; credentials_configured: boolean }>(
        `/events/${id}/settings`,
      );
      setSettings(data.settings);
      setStatus(data.status ?? {});
      setCredentialsConfigured(data.credentials_configured);
    } catch (err) {
      toast.error('Could not load Cvent settings: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/events/${id}/settings`, { method: 'PUT', body: JSON.stringify(settings) });
      toast.success('Cvent settings saved');
      await load();
      void refreshEventLedger(id);
    } catch (err) {
      toast.error('Failed to save: ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function fetchAdmissionItems() {
    if (!settings.cvent_event_id) {
      toast.error('Enter and save a Cvent event id first');
      return;
    }
    setLoadingItems(true);
    try {
      const data = await api<{ items: AdmissionItem[] }>(`/events/${id}/admission-items`);
      if (data.items.length === 0) {
        toast.warning('No admission items found. Paste the id from Cvent → Event → Registration Setup → Admission Items.');
      }
      setAdmissionItems(data.items);
    } catch (err) {
      toast.error('Could not fetch from Cvent: ' + (err as Error).message);
    } finally {
      setLoadingItems(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const data = await api<SyncNowResult>(`/events/${id}/sync-now`, { method: 'POST' });
      setSyncResult(data);
      setStatus(data.status ?? {});
      if (data.aborted) {
        toast.error(`Stopped: ${data.aborted}`);
      } else {
        toast.success(
          data.remaining
            ? `Pushed ${data.created + data.alreadyExists} so far; the worker will finish the rest shortly.`
            : `Done: ${data.created} new, ${data.alreadyExists} already in Cvent, ${data.failed} failed`,
        );
      }
    } catch (err) {
      toast.error('Sync failed: ' + (err as Error).message);
    } finally {
      setSyncing(false);
      void refreshEventLedger(id);
    }
  }

  async function retryFailed() {
    setRetrying(true);
    try {
      const data = await api<{ reset: number }>(`/events/${id}/retry-failed`, { method: 'POST' });
      toast.success(`${data.reset} registration${data.reset === 1 ? '' : 's'} will be retried on the next run`);
      await load();
    } catch (err) {
      toast.error('Could not reset: ' + (err as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  // Registrant search for the single-registrant test (server-side, admin-gated).
  useEffect(() => {
    if (registrantSearch.trim().length < 2 || selectedRegistrantId) {
      setRegistrants([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ registrants: Registrant[] }>(
          `/events/${id}/registrants?q=${encodeURIComponent(registrantSearch.trim())}`,
        );
        setRegistrants(data.registrants);
      } catch {
        setRegistrants([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [registrantSearch, selectedRegistrantId, id]);

  async function testSyncRegistrant() {
    if (!selectedRegistrantId) return;
    setTestSyncing(true);
    setTestResult(null);
    try {
      const data = await api<{ success: boolean; action?: string; error?: string }>(
        `/registrations/${selectedRegistrantId}/sync`,
        { method: 'POST' },
      );
      setTestResult(data);
      if (data.success) toast.success(data.action === 'already_exists' || data.action === 'already_synced' ? 'Already in Cvent' : 'Synced to Cvent');
      else toast.error(data.error || 'Sync failed');
      await load();
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message });
      toast.error('Test sync error: ' + (err as Error).message);
    } finally {
      setTestSyncing(false);
    }
  }

  const isConfigured = !!settings.cvent_event_id && !!settings.cvent_admission_item_id;
  const inputClass = 'font-mono text-sm';

  if (loading) {
    return <Card className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading Cvent settings…</Card>;
  }

  return (
    <div className="space-y-6">
      {!credentialsConfigured && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-amber-700 dark:text-amber-400 text-sm">
          <InformationCircleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            No Cvent credentials yet. Set the client id and secret under Modules → Cvent before syncing.
          </span>
        </div>
      )}

      <Card className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Cvent badge printing</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Push registrants to Cvent so badges can be printed on site.
            </p>
          </div>
          {settings.cvent_sync_enabled ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2.5 py-1 rounded-full">
              <CheckCircleIcon className="w-3.5 h-3.5" />
              Live sync on
            </span>
          ) : (
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2.5 py-1 rounded-full">
              Sync off
            </span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cvent event id</label>
            <Input
              value={settings.cvent_event_id ?? ''}
              onChange={(e) => setSettings((s) => ({ ...s, cvent_event_id: e.target.value || null }))}
              placeholder="7685bda5-094c-47b1-a272-eaf5e6936587"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The uuid from the Cvent event URL or event settings.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cvent event code</label>
            <Input
              value={settings.cvent_event_code ?? ''}
              onChange={(e) => setSettings((s) => ({ ...s, cvent_event_code: e.target.value || null }))}
              placeholder="7CND3JC7G2G"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Short code shown in Cvent. Display only.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Admission item</label>
            <div className="flex gap-2">
              {admissionItems.length > 0 ? (
                <select
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={settings.cvent_admission_item_id ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, cvent_admission_item_id: e.target.value || null }))}
                >
                  <option value="">— select admission item —</option>
                  {admissionItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.code ? ` (${item.code})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={settings.cvent_admission_item_id ?? ''}
                  onChange={(e) => setSettings((s) => ({ ...s, cvent_admission_item_id: e.target.value || null }))}
                  placeholder="Paste the item id, or click Fetch to load from Cvent"
                  className={`flex-1 ${inputClass}`}
                />
              )}
              <Button
                variant="soft"
                size="sm"
                onClick={fetchAdmissionItems}
                loading={loadingItems}
                disabled={loadingItems || !settings.cvent_event_id || !credentialsConfigured}
              >
                Fetch
              </Button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The ticket type registrants get in Cvent. Fetch reads the saved event id, so save first.
            </p>
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Live sync</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Push every new registration to Cvent within seconds, and re-push name, title and company when they change.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.cvent_sync_enabled}
              disabled={!isConfigured}
              onClick={() => setSettings((s) => ({ ...s, cvent_sync_enabled: !s.cvent_sync_enabled }))}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
                settings.cvent_sync_enabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  settings.cvent_sync_enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {!isConfigured && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-amber-700 dark:text-amber-400 text-xs">
              <InformationCircleIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Save a Cvent event id and an admission item before turning on live sync or syncing.</span>
            </div>
          )}

          <Button onClick={save} loading={saving} disabled={saving} className="w-full">
            Save Cvent settings
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Sync status</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Active registrations for this event and how many are in Cvent.
            </p>
          </div>
          <Button variant="soft" size="sm" onClick={load}>
            <ArrowPathIcon className="w-4 h-4" />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Active" value={status.active ?? 0} />
          <Stat label="In Cvent" value={status.synced ?? 0} tone="good" />
          <Stat label="Pending" value={status.pending ?? 0} />
          <Stat label="Failed" value={status.failed ?? 0} tone={(status.failed ?? 0) > 0 ? 'bad' : undefined} />
        </div>
        {status.last_synced_at && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Last synced {new Date(status.last_synced_at).toLocaleString()}
          </p>
        )}
        {status.last_error && (
          <p className="text-xs text-red-500 dark:text-red-400 mb-3 break-words">Last error: {status.last_error}</p>
        )}

        {settings.cvent_sync_enabled ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Live sync is on: the worker pushes pending registrants within seconds, so there is nothing to run by hand.
            Turn live sync off to run a manual pass.
          </p>
        ) : (
          <>
            <Button
              variant="soft"
              onClick={syncNow}
              loading={syncing}
              disabled={syncing || !isConfigured || !credentialsConfigured}
              className="w-full"
            >
              <ArrowPathIcon className="w-4 h-4" />
              {syncing ? 'Syncing to Cvent…' : 'Sync now'}
            </Button>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Pushes pending registrants now (about 20 seconds per click). Safe to run again; registrants already in Cvent are skipped.
            </p>
          </>
        )}
        {(status.failed ?? 0) > 0 && (
          <Button variant="soft" size="sm" onClick={retryFailed} loading={retrying} disabled={retrying} className="mt-2 w-full">
            Retry failed ({status.failed})
          </Button>
        )}

        {syncResult && (
          <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl text-xs text-gray-600 dark:text-gray-300 space-y-0.5">
            <p>{syncResult.created} newly synced, {syncResult.alreadyExists} already in Cvent, {syncResult.failed} failed</p>
            {syncResult.remaining && <p>More are pending; the worker will continue.</p>}
            {syncResult.errors.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-red-500 dark:text-red-400">
                {syncResult.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card className="p-6">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Test with one registrant</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">
          Pushes a single registration whether or not live sync is on. Useful before switching sync on for everyone.
        </p>
        <div className="space-y-2">
          <div className="relative">
            <Input
              value={registrantSearch}
              onChange={(e) => {
                setRegistrantSearch(e.target.value);
                setSelectedRegistrantId('');
                setTestResult(null);
              }}
              placeholder="Search by email or name…"
              className="text-sm"
            />
            {registrants.length > 0 && !selectedRegistrantId && (
              <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {registrants.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-0"
                    onClick={() => {
                      setSelectedRegistrantId(r.id);
                      setRegistrantSearch(r.name ? `${r.name} <${r.email}>` : r.email);
                      setRegistrants([]);
                    }}
                  >
                    <span className="font-medium text-gray-900 dark:text-white">{r.name || r.email}</span>
                    {r.name && <span className="text-gray-500 dark:text-gray-400 ml-1 text-xs">{r.email}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="soft"
            size="sm"
            onClick={testSyncRegistrant}
            loading={testSyncing}
            disabled={testSyncing || !selectedRegistrantId || !isConfigured || !credentialsConfigured}
            className="w-full"
          >
            Test sync to Cvent
          </Button>
          {testResult && (
            <div
              className={`text-xs px-2 py-1.5 rounded-lg flex items-center gap-1.5 ${
                testResult.success
                  ? 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
                  : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'
              }`}
            >
              {testResult.success ? (
                <>
                  <CheckCircleIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  {testResult.action === 'already_exists' || testResult.action === 'already_synced' ? 'Already in Cvent' : 'Synced to Cvent'}
                </>
              ) : (
                <>
                  <ExclamationCircleIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  {testResult.error}
                </>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  const color =
    tone === 'good'
      ? 'text-green-600 dark:text-green-400'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : 'text-gray-900 dark:text-white';
  return (
    <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export default CventTab;
