import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  TableCellsIcon,
  CircleStackIcon,
  CodeBracketIcon,
  ShieldCheckIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Select } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import { getApiBaseUrl } from '@/config/brands';

interface Environment {
  id: string;
  name: string;
  slug: string;
  type: string;
  supabase_url: string;
  supabase_anon_key: string | null;
  supabase_service_role_key: string | null;
  is_current: boolean;
  status: string;
}

interface SyncConfig {
  direction: 'push' | 'pull';
  targetEnvironmentId: string;
  tables: string[];
  storageBuckets: string[];
  includeEdgeFunctions: boolean;
  includeAuthConfig: boolean;
  conflictStrategy: 'skip' | 'overwrite' | 'merge';
}

interface SyncLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

const conflictOptions = [
  { value: 'skip', label: 'Skip existing rows' },
  { value: 'overwrite', label: 'Overwrite existing rows' },
  { value: 'merge', label: 'Merge (update non-null fields)' },
];

export default function SyncPage() {
  const { environmentId } = useParams();
  const navigate = useNavigate();

  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [otherEnvironments, setOtherEnvironments] = useState<Environment[]>([]);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [tableFilter, setTableFilter] = useState('');
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);
  const [syncComplete, setSyncComplete] = useState(false);

  const [config, setConfig] = useState<SyncConfig>({
    direction: 'pull',
    targetEnvironmentId: '',
    tables: [],
    storageBuckets: [],
    includeEdgeFunctions: false,
    includeAuthConfig: false,
    conflictStrategy: 'skip',
  });

  const apiBaseUrl = getApiBaseUrl();

  // Resolve which environment is the "source" — the one we read tables
  // and buckets from. For pull, source is whichever the user picked in
  // the dropdown (otherEnvironments). For push, source is the current
  // environment in the URL.
  const getSourceEnv = useCallback((): Environment | null => {
    if (!environment) return null;
    if (config.direction === 'push') return environment;
    return otherEnvironments.find((e) => e.id === config.targetEnvironmentId) ?? null;
  }, [environment, otherEnvironments, config.direction, config.targetEnvironmentId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [envRes, allEnvRes] = await Promise.all([
        supabase.from('environments').select('*').eq('id', environmentId).single(),
        supabase.from('environments').select('*').neq('id', environmentId).order('name'),
      ]);

      if (envRes.error) throw envRes.error;
      setEnvironment(envRes.data);
      setOtherEnvironments(allEnvRes.data ?? []);

      // Default target to first other environment
      if (allEnvRes.data?.length && !config.targetEnvironmentId) {
        setConfig((prev) => ({ ...prev, targetEnvironmentId: allEnvRes.data![0].id }));
      }
    } catch (error) {
      console.error('Error loading sync data:', error);
      toast.error('Failed to load environment');
    } finally {
      setLoading(false);
    }
  };

  // Discovery goes through the server (api.ts /environments/tables and
  // /environments/buckets) so that:
  //   1. We can list from the *source* env (its tables/buckets, not
  //      ours) — pulling needs to know what's available upstream.
  //   2. We use the env's service role key without leaking it to the
  //      browser. Service-role-only endpoints (storage bucket list,
  //      OpenAPI schema with private tables) require it.
  //   3. CORS isn't a problem — the browser only ever talks to our own
  //      api host, never to a foreign Supabase instance.
  // Read the JSON body even on error responses so we can surface the
  // server's actual error message (api routes return { error } on 4xx/5xx).
  // Without this the UI just sees "500" with no clue what to fix.
  const fetchJsonOrThrow = async (url: string, label: string) => {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (netErr: any) {
      throw new Error(`${label}: network error — ${netErr.message}`);
    }
    let body: any = {};
    try { body = await res.json(); } catch { /* keep empty body */ }
    if (!res.ok) {
      const detail = body?.error ?? body?.message ?? `HTTP ${res.status}`;
      throw new Error(`${label}: ${detail}`);
    }
    return body;
  };

  const discoverTables = useCallback(async () => {
    const src = getSourceEnv();
    if (!src) return;
    try {
      const body = await fetchJsonOrThrow(
        `${apiBaseUrl}/environments/tables?environmentId=${encodeURIComponent(src.id)}`,
        'tables',
      );
      setAvailableTables(body.tables ?? []);
    } catch (error: any) {
      console.error('Error discovering tables:', error);
      toast.error(error.message ?? 'Failed to discover tables');
      setAvailableTables([]);
    }
  }, [apiBaseUrl, getSourceEnv]);

  const discoverBuckets = useCallback(async () => {
    const src = getSourceEnv();
    if (!src) return;
    try {
      const body = await fetchJsonOrThrow(
        `${apiBaseUrl}/environments/buckets?environmentId=${encodeURIComponent(src.id)}`,
        'buckets',
      );
      setAvailableBuckets(body.buckets ?? []);
    } catch (error: any) {
      console.error('Error discovering buckets:', error);
      toast.error(error.message ?? 'Failed to discover buckets');
      setAvailableBuckets([]);
    }
  }, [apiBaseUrl, getSourceEnv]);

  useEffect(() => {
    if (environmentId) loadData();
  }, [environmentId]);

  // Re-discover tables/buckets whenever the source env changes (toggle
  // direction or pick a different target).
  useEffect(() => {
    if (environment && config.targetEnvironmentId) {
      discoverTables();
      discoverBuckets();
    }
  }, [environment, config.targetEnvironmentId, config.direction, discoverTables, discoverBuckets]);

  const addLog = useCallback((level: SyncLogEntry['level'], message: string) => {
    setSyncLog((prev) => [
      ...prev,
      { timestamp: new Date().toISOString(), level, message },
    ]);
  }, []);

  const getTargetEnv = () => otherEnvironments.find((e) => e.id === config.targetEnvironmentId);

  const handleSync = async () => {
    if (!environment || !config.targetEnvironmentId) {
      toast.error('Please select a target environment');
      return;
    }

    const target = getTargetEnv();
    if (!target) return;

    // Determine source and destination based on direction
    const sourceEnv = config.direction === 'push' ? environment : target;
    const destEnv = config.direction === 'push' ? target : environment;

    if (!sourceEnv.supabase_service_role_key) {
      toast.error(`Source environment "${sourceEnv.name}" is missing a service role key`);
      return;
    }
    if (!destEnv.supabase_service_role_key) {
      toast.error(`Target environment "${destEnv.name}" is missing a service role key`);
      return;
    }

    if (
      config.tables.length === 0 &&
      config.storageBuckets.length === 0 &&
      !config.includeEdgeFunctions &&
      !config.includeAuthConfig
    ) {
      toast.error('Please select at least one thing to sync');
      return;
    }

    setSyncing(true);
    setSyncLog([]);
    setSyncComplete(false);

    addLog('info', `Starting ${config.direction} sync on the API server…`);
    addLog('info', `Source: ${sourceEnv.name} (${sourceEnv.supabase_url})`);
    addLog('info', `Target: ${destEnv.name} (${destEnv.supabase_url})`);

    // Kick off the sync server-side. The api server has direct access
    // to both environments' service role keys (via the environments
    // table) and runs the work in the background. We then poll the
    // operation row for progress. This avoids:
    //   - leaking service role keys to the browser
    //   - CORS errors on cross-origin Supabase POSTs
    //   - long-running fetch loops blocking the admin UI
    let operationId: string | null = null;
    try {
      const startRes = await fetch(`${apiBaseUrl}/environments/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction: config.direction,
          sourceEnvironmentId: sourceEnv.id,
          targetEnvironmentId: destEnv.id,
          tables: config.tables,
          storageBuckets: config.storageBuckets,
          conflictStrategy: config.conflictStrategy,
        }),
      });

      const body = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !body.operationId) {
        const msg = body?.error ?? `HTTP ${startRes.status}`;
        addLog('error', `Failed to start sync: ${msg}`);
        toast.error(`Sync failed to start: ${msg}`);
        setSyncing(false);
        return;
      }
      operationId = body.operationId;
      addLog('info', `Operation queued: ${operationId}`);
    } catch (err: any) {
      addLog('error', `Failed to reach API: ${err.message}`);
      toast.error('Failed to start sync');
      setSyncing(false);
      return;
    }

    // Poll the operation row every 2s, mirroring its server-persisted
    // log into the local UI state. Stops on terminal status.
    let cancelled = false;
    const POLL_MS = 2000;
    const poll = async () => {
      if (cancelled || !operationId) return;
      try {
        const res = await fetch(
          `${apiBaseUrl}/environments/sync/${encodeURIComponent(operationId)}`,
        );
        if (!res.ok) {
          addLog('warn', `Status poll returned ${res.status}; retrying…`);
          setTimeout(poll, POLL_MS);
          return;
        }
        const { operation } = await res.json();
        const serverLog = (operation?.log ?? []) as SyncLogEntry[];
        if (serverLog.length > 0) {
          // Replace local log with server log (server is authoritative).
          // Keep the local "Operation queued" header lines on top by
          // merging; but server includes its own header so we just take
          // its log verbatim.
          setSyncLog(serverLog);
        }
        const status = operation?.status as string | undefined;
        if (status === 'completed') {
          addLog('success', 'Sync completed successfully');
          if (operation?.rows_processed != null) {
            addLog(
              'info',
              `Rows: ${operation.rows_processed} processed, ${operation.rows_inserted ?? 0} inserted, ${operation.rows_skipped ?? 0} skipped`,
            );
          }
          if ((operation?.files_synced ?? 0) > 0) {
            addLog('info', `Files: ${operation.files_synced} synced`);
          }
          setSyncComplete(true);
          toast.success('Sync completed');
          setSyncing(false);
        } else if (status === 'failed') {
          addLog('error', `Sync failed: ${operation?.error_message ?? 'unknown error'}`);
          toast.error('Sync failed');
          setSyncing(false);
        } else {
          // still running
          setTimeout(poll, POLL_MS);
        }
      } catch (err: any) {
        addLog('warn', `Poll error: ${err.message}; retrying…`);
        setTimeout(poll, POLL_MS);
      }
    };
    poll();

    // Notify on flags that the server doesn't yet support so the user
    // isn't surprised by silence on those switches.
    if (config.includeEdgeFunctions) {
      addLog(
        'info',
        'Edge function sync must be done via the Supabase CLI (`supabase functions deploy --project-ref …`).',
      );
    }
    if (config.includeAuthConfig) {
      addLog(
        'info',
        'Auth provider settings must be configured per-environment via the Supabase dashboard or CLI.',
      );
    }

    return () => {
      cancelled = true;
    };
  };

  const toggleTable = (table: string) => {
    setConfig((prev) => ({
      ...prev,
      tables: prev.tables.includes(table)
        ? prev.tables.filter((t) => t !== table)
        : [...prev.tables, table],
    }));
  };

  const toggleBucket = (bucket: string) => {
    setConfig((prev) => ({
      ...prev,
      storageBuckets: prev.storageBuckets.includes(bucket)
        ? prev.storageBuckets.filter((b) => b !== bucket)
        : [...prev.storageBuckets, bucket],
    }));
  };

  // Filter helper: case-insensitive substring match. Empty filter
  // returns the full list. Lets the operator narrow 100+ tables down
  // to e.g. all `events*` rows by typing "events" then Select All.
  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    if (!q) return availableTables;
    return availableTables.filter((t) => t.toLowerCase().includes(q));
  }, [availableTables, tableFilter]);

  // "Select All" acts on the *visible* (filtered) tables only — that
  // way "type 'events' → Select All" picks events, event_hosts,
  // events_speakers etc. without disturbing other selections. When all
  // visible are already selected, the same button removes them.
  const allFilteredSelected =
    filteredTables.length > 0 && filteredTables.every((t) => config.tables.includes(t));

  const toggleSelectAllFiltered = () => {
    setConfig((prev) => {
      const visibleSet = new Set(filteredTables);
      if (allFilteredSelected) {
        return { ...prev, tables: prev.tables.filter((t) => !visibleSet.has(t)) };
      }
      const next = new Set(prev.tables);
      for (const t of filteredTables) next.add(t);
      return { ...prev, tables: Array.from(next) };
    });
  };

  if (loading) {
    return (
      <Page title="Sync">
        <div className="p-6 flex items-center justify-center min-h-[400px]">
          <ArrowPathIcon className="size-6 animate-spin text-[var(--gray-a8)]" />
        </div>
      </Page>
    );
  }

  if (!environment) {
    return (
      <Page title="Environment Not Found">
        <div className="p-6 text-center">
          <h2 className="text-lg font-medium">Environment not found</h2>
          <Button onClick={() => navigate('/environments')} style={{ marginTop: "1rem" }}>
            Back to Environments
          </Button>
        </div>
      </Page>
    );
  }

  const targetEnv = getTargetEnv();
  const sourceLabel = config.direction === 'push' ? environment.name : (targetEnv?.name || '—');
  const destLabel = config.direction === 'push' ? (targetEnv?.name || '—') : environment.name;

  return (
    <Page title={`Sync — ${environment.name}`}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => navigate(`/admin/environments/${environmentId}`)}
            className="gap-1"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Content Sync
          </h1>
          <p className="text-[var(--gray-a8)] mt-1">
            Push or pull database content, storage files, and configuration between environments.
            Schema changes are not applied — only content is transferred.
          </p>
        </div>

        {/* Direction & Target Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-4">Direction</h3>
            <div className="flex gap-3">
              <button
                onClick={() => setConfig((prev) => ({ ...prev, direction: 'pull' }))}
                disabled={syncing}
                className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                  config.direction === 'pull'
                    ? 'border-[var(--accent-9)] bg-[var(--accent-a2)]'
                    : 'border-[var(--gray-a5)] hover:border-[var(--gray-a7)]'
                }`}
              >
                <ArrowDownTrayIcon className="size-6 mx-auto mb-2" />
                <div className="font-medium text-sm">Pull</div>
                <div className="text-xs text-[var(--gray-a8)] mt-1">
                  Import content into this environment
                </div>
              </button>
              <button
                onClick={() => setConfig((prev) => ({ ...prev, direction: 'push' }))}
                disabled={syncing}
                className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                  config.direction === 'push'
                    ? 'border-[var(--accent-9)] bg-[var(--accent-a2)]'
                    : 'border-[var(--gray-a5)] hover:border-[var(--gray-a7)]'
                }`}
              >
                <ArrowUpTrayIcon className="size-6 mx-auto mb-2" />
                <div className="font-medium text-sm">Push</div>
                <div className="text-xs text-[var(--gray-a8)] mt-1">
                  Export content from this environment
                </div>
              </button>
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-4">
              {config.direction === 'pull' ? 'Pull From' : 'Push To'}
            </h3>
            {otherEnvironments.length === 0 ? (
              <div className="text-sm text-[var(--gray-a8)]">
                No other environments configured.{' '}
                <button
                  onClick={() => navigate('/environments')}
                  className="text-[var(--accent-9)] underline"
                >
                  Add one
                </button>
              </div>
            ) : (
              <Select
                data={otherEnvironments.map((e) => ({
                  value: e.id,
                  label: `${e.name} (${e.type})`,
                }))}
                value={config.targetEnvironmentId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setConfig((prev) => ({ ...prev, targetEnvironmentId: e.target.value }))
                }
                disabled={syncing}
              />
            )}

            <div className="mt-4 p-3 bg-[var(--gray-a2)] rounded-lg text-sm">
              <div className="flex items-center gap-2 text-[var(--gray-a8)]">
                <span className="font-medium text-[var(--gray-12)]">{sourceLabel}</span>
                <span>&rarr;</span>
                <span className="font-medium text-[var(--gray-12)]">{destLabel}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Conflict Strategy */}
        <Card className="p-6">
          <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-4">Conflict Strategy</h3>
          <Select
            data={conflictOptions}
            value={config.conflictStrategy}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setConfig((prev) => ({
                ...prev,
                conflictStrategy: e.target.value as SyncConfig['conflictStrategy'],
              }))
            }
            disabled={syncing}
            description="How to handle rows that already exist in the target environment"
          />
        </Card>

        {/* What to Sync */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Tables */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <TableCellsIcon className="size-5 text-[var(--blue-9)]" />
                <h3 className="text-sm font-semibold text-[var(--gray-12)]">
                  Database Tables
                </h3>
                {config.tables.length > 0 && (
                  <Badge color="info" variant="soft">
                    {config.tables.length} selected
                  </Badge>
                )}
              </div>
              <button
                onClick={toggleSelectAllFiltered}
                className="text-xs text-[var(--accent-9)] hover:underline disabled:opacity-50"
                disabled={syncing || filteredTables.length === 0}
                title={
                  tableFilter
                    ? `Toggle the ${filteredTables.length} table(s) matching "${tableFilter}"`
                    : 'Toggle every table'
                }
              >
                {allFilteredSelected ? 'Deselect' : 'Select'} {tableFilter ? 'Filtered' : 'All'}
              </button>
            </div>

            {availableTables.length > 0 && (
              <input
                type="text"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                placeholder="Filter tables (e.g. events) — substring match"
                disabled={syncing}
                className="w-full mb-3 px-3 py-1.5 text-sm font-mono rounded-md border border-[var(--gray-a5)] bg-[var(--gray-a1)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-7)]"
              />
            )}

            {availableTables.length === 0 ? (
              <div className="text-sm text-[var(--gray-a8)]">No tables discovered</div>
            ) : filteredTables.length === 0 ? (
              <div className="text-sm text-[var(--gray-a8)]">
                No tables match "{tableFilter}"
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {filteredTables.map((table) => (
                  <label
                    key={table}
                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                      config.tables.includes(table)
                        ? 'bg-[var(--accent-a2)]'
                        : 'hover:bg-[var(--gray-a2)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={config.tables.includes(table)}
                      onChange={() => toggleTable(table)}
                      disabled={syncing}
                      className="rounded"
                    />
                    <CircleStackIcon className="size-4 text-[var(--gray-a8)]" />
                    <span className="font-mono text-sm">{table}</span>
                  </label>
                ))}
              </div>
            )}
          </Card>

          {/* Storage Buckets */}
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <ArrowUpTrayIcon className="size-5 text-[var(--green-9)]" />
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">
                Storage Buckets
              </h3>
              {config.storageBuckets.length > 0 && (
                <Badge color="success" variant="soft">{config.storageBuckets.length}</Badge>
              )}
            </div>

            {availableBuckets.length === 0 ? (
              <div className="text-sm text-[var(--gray-a8)]">No storage buckets found</div>
            ) : (
              <div className="space-y-1">
                {availableBuckets.map((bucket) => (
                  <label
                    key={bucket}
                    className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                      config.storageBuckets.includes(bucket)
                        ? 'bg-[var(--accent-a2)]'
                        : 'hover:bg-[var(--gray-a2)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={config.storageBuckets.includes(bucket)}
                      onChange={() => toggleBucket(bucket)}
                      disabled={syncing}
                      className="rounded"
                    />
                    <span className="font-mono text-sm">{bucket}</span>
                  </label>
                ))}
              </div>
            )}

            {/* Extra Options */}
            <div className="border-t border-[var(--gray-a5)] mt-4 pt-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.includeEdgeFunctions}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, includeEdgeFunctions: e.target.checked }))
                  }
                  disabled={syncing}
                  className="rounded"
                />
                <CodeBracketIcon className="size-4 text-[var(--amber-9)]" />
                <div>
                  <span className="text-sm font-medium">Edge Functions</span>
                  <span className="text-xs text-[var(--gray-a8)] block">
                    Provides CLI instructions for function deployment
                  </span>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.includeAuthConfig}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, includeAuthConfig: e.target.checked }))
                  }
                  disabled={syncing}
                  className="rounded"
                />
                <ShieldCheckIcon className="size-4 text-[var(--red-9)]" />
                <div>
                  <span className="text-sm font-medium">Auth Configuration</span>
                  <span className="text-xs text-[var(--gray-a8)] block">
                    Sync user metadata (passwords are not transferable)
                  </span>
                </div>
              </label>
            </div>
          </Card>
        </div>

        {/* Production Warning */}
        {targetEnv?.type === 'production' && config.direction === 'push' && (
          <Card className="p-4 border-2 border-[var(--amber-9)]">
            <div className="flex items-start gap-3">
              <ExclamationTriangleIcon className="size-6 text-[var(--amber-9)] shrink-0 mt-0.5" />
              <div>
                <h4 className="font-medium text-[var(--amber-11)]">
                  Pushing to Production
                </h4>
                <p className="text-sm text-[var(--gray-a8)] mt-1">
                  You are about to push content to a production environment. This may overwrite
                  existing data depending on your conflict strategy. Proceed with caution.
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Sync Button */}
        <div className="flex justify-end">
          <Button
            onClick={handleSync}
            disabled={syncing || otherEnvironments.length === 0}
            className="gap-2 px-6"
            color={config.direction === 'push' ? 'primary' : 'success'}
          >
            {syncing ? (
              <>
                <ArrowPathIcon className="size-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                {config.direction === 'push' ? (
                  <ArrowUpTrayIcon className="size-4" />
                ) : (
                  <ArrowDownTrayIcon className="size-4" />
                )}
                {config.direction === 'push' ? 'Push Content' : 'Pull Content'}
              </>
            )}
          </Button>
        </div>

        {/* Sync Log */}
        {syncLog.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">Sync Log</h3>
              {syncComplete && (
                <Badge color="success" variant="soft">
                  <CheckIcon className="size-3 mr-1" />
                  Complete
                </Badge>
              )}
            </div>

            <div className="bg-[var(--gray-a2)] rounded-lg p-4 max-h-80 overflow-y-auto font-mono text-xs space-y-1">
              {syncLog.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-[var(--gray-a8)] shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={
                      entry.level === 'error'
                        ? 'text-[var(--red-9)]'
                        : entry.level === 'warn'
                          ? 'text-[var(--amber-9)]'
                          : entry.level === 'success'
                            ? 'text-[var(--green-9)]'
                            : 'text-[var(--gray-12)]'
                    }
                  >
                    [{entry.level.toUpperCase()}]
                  </span>
                  <span className="text-[var(--gray-12)]">{entry.message}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
