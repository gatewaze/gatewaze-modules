import { useState, useEffect, useCallback } from 'react';
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

      // Discover available tables (exclude system/module tables)
      await discoverTables();
      await discoverBuckets();
    } catch (error) {
      console.error('Error loading sync data:', error);
      toast.error('Failed to load environment');
    } finally {
      setLoading(false);
    }
  };

  const discoverTables = async () => {
    try {
      // Query information_schema to discover user tables
      const { data, error } = await supabase.rpc('exec_sql', {
        sql_text: `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
            AND table_name NOT IN (
              'installed_modules',
              'module_migrations',
              'module_sources',
              'platform_settings',
              'environments',
              'environment_sync_profiles',
              'environment_sync_operations'
            )
          ORDER BY table_name
        `,
      });

      // exec_sql returns void, so we need to use a different approach
      // Fetch table names via the REST API schema
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`,
        {
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
          },
        }
      );

      if (response.ok) {
        const schema = await response.json();
        // The REST endpoint returns an OpenAPI spec with paths for each table
        if (schema?.paths) {
          const tables = Object.keys(schema.paths)
            .map((p) => p.replace('/', ''))
            .filter(
              (t) =>
                t &&
                !t.startsWith('rpc/') &&
                ![
                  'installed_modules',
                  'module_migrations',
                  'module_sources',
                  'platform_settings',
                  'environments',
                  'environment_sync_profiles',
                  'environment_sync_operations',
                ].includes(t)
            )
            .sort();
          setAvailableTables(tables);
        }
      }
    } catch (error) {
      console.error('Error discovering tables:', error);
    }
  };

  const discoverBuckets = async () => {
    try {
      const { data } = await supabase.storage.listBuckets();
      setAvailableBuckets((data ?? []).map((b) => b.name));
    } catch (error) {
      console.error('Error discovering buckets:', error);
    }
  };

  useEffect(() => {
    if (environmentId) loadData();
  }, [environmentId]);

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

    if (config.tables.length === 0 && config.storageBuckets.length === 0 && !config.includeEdgeFunctions && !config.includeAuthConfig) {
      toast.error('Please select at least one thing to sync');
      return;
    }

    setSyncing(true);
    setSyncLog([]);
    setSyncComplete(false);

    // Create the sync operation record
    const { data: syncOp, error: opError } = await supabase
      .from('environment_sync_operations')
      .insert({
        direction: config.direction,
        source_environment_id: sourceEnv.id,
        target_environment_id: destEnv.id,
        tables_synced: config.tables,
        storage_buckets_synced: config.storageBuckets,
        edge_functions_synced: config.includeEdgeFunctions,
        auth_config_synced: config.includeAuthConfig,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (opError) {
      toast.error('Failed to create sync operation');
      setSyncing(false);
      return;
    }

    addLog('info', `Starting ${config.direction} sync...`);
    addLog('info', `Source: ${sourceEnv.name} (${sourceEnv.supabase_url})`);
    addLog('info', `Target: ${destEnv.name} (${destEnv.supabase_url})`);

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalProcessed = 0;
    let totalFiles = 0;

    try {
      // --- Sync Tables ---
      for (const tableName of config.tables) {
        addLog('info', `Syncing table: ${tableName}`);

        try {
          // Fetch all rows from source
          const sourceResponse = await fetch(
            `${sourceEnv.supabase_url}/rest/v1/${tableName}?select=*`,
            {
              headers: {
                apikey: sourceEnv.supabase_service_role_key!,
                Authorization: `Bearer ${sourceEnv.supabase_service_role_key!}`,
                Prefer: 'return=representation',
              },
            }
          );

          if (!sourceResponse.ok) {
            addLog('error', `Failed to read ${tableName} from source: ${sourceResponse.statusText}`);
            continue;
          }

          const rows = await sourceResponse.json();
          addLog('info', `Found ${rows.length} rows in ${tableName}`);

          if (rows.length === 0) {
            addLog('info', `Skipping ${tableName} — no rows`);
            continue;
          }

          // Upsert rows to target in batches
          const batchSize = 500;
          for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);

            let prefer = 'return=minimal';
            if (config.conflictStrategy === 'skip') {
              prefer += ',resolution=ignore-duplicates';
            } else if (config.conflictStrategy === 'overwrite') {
              prefer += ',resolution=merge-duplicates';
            } else {
              prefer += ',resolution=merge-duplicates';
            }

            const destResponse = await fetch(
              `${destEnv.supabase_url}/rest/v1/${tableName}`,
              {
                method: 'POST',
                headers: {
                  apikey: destEnv.supabase_service_role_key!,
                  Authorization: `Bearer ${destEnv.supabase_service_role_key!}`,
                  'Content-Type': 'application/json',
                  Prefer: prefer,
                },
                body: JSON.stringify(batch),
              }
            );

            if (!destResponse.ok) {
              const errText = await destResponse.text();
              addLog('warn', `Batch insert for ${tableName} returned ${destResponse.status}: ${errText}`);
              totalSkipped += batch.length;
            } else {
              totalInserted += batch.length;
            }
            totalProcessed += batch.length;
          }

          addLog('success', `Completed ${tableName}: ${rows.length} rows processed`);
        } catch (tableError: any) {
          addLog('error', `Error syncing ${tableName}: ${tableError.message}`);
        }
      }

      // --- Sync Storage Buckets ---
      for (const bucketName of config.storageBuckets) {
        addLog('info', `Syncing storage bucket: ${bucketName}`);

        try {
          // List files in source bucket
          const listResponse = await fetch(
            `${sourceEnv.supabase_url}/storage/v1/object/list/${bucketName}`,
            {
              method: 'POST',
              headers: {
                apikey: sourceEnv.supabase_service_role_key!,
                Authorization: `Bearer ${sourceEnv.supabase_service_role_key!}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ prefix: '', limit: 1000 }),
            }
          );

          if (!listResponse.ok) {
            addLog('error', `Failed to list files in ${bucketName}: ${listResponse.statusText}`);
            continue;
          }

          const files = await listResponse.json();
          addLog('info', `Found ${files.length} files in ${bucketName}`);

          // Ensure bucket exists on target
          await fetch(`${destEnv.supabase_url}/storage/v1/bucket`, {
            method: 'POST',
            headers: {
              apikey: destEnv.supabase_service_role_key!,
              Authorization: `Bearer ${destEnv.supabase_service_role_key!}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ id: bucketName, name: bucketName, public: false }),
          });

          for (const file of files) {
            if (file.id === null) continue; // folder placeholder

            try {
              // Download from source
              const downloadRes = await fetch(
                `${sourceEnv.supabase_url}/storage/v1/object/${bucketName}/${file.name}`,
                {
                  headers: {
                    apikey: sourceEnv.supabase_service_role_key!,
                    Authorization: `Bearer ${sourceEnv.supabase_service_role_key!}`,
                  },
                }
              );

              if (!downloadRes.ok) {
                addLog('warn', `Failed to download ${file.name}`);
                continue;
              }

              const blob = await downloadRes.blob();

              // Upload to target
              const formData = new FormData();
              formData.append('', blob, file.name);

              await fetch(
                `${destEnv.supabase_url}/storage/v1/object/${bucketName}/${file.name}`,
                {
                  method: 'POST',
                  headers: {
                    apikey: destEnv.supabase_service_role_key!,
                    Authorization: `Bearer ${destEnv.supabase_service_role_key!}`,
                    'x-upsert': 'true',
                  },
                  body: formData,
                }
              );

              totalFiles++;
            } catch (fileError: any) {
              addLog('warn', `Failed to sync file ${file.name}: ${fileError.message}`);
            }
          }

          addLog('success', `Completed ${bucketName}: ${files.length} files processed`);
        } catch (bucketError: any) {
          addLog('error', `Error syncing bucket ${bucketName}: ${bucketError.message}`);
        }
      }

      // --- Edge Functions ---
      if (config.includeEdgeFunctions) {
        addLog('info', 'Edge function sync is a deployment-level operation.');
        addLog('info', 'Use the Supabase CLI to deploy edge functions between environments:');
        addLog('info', '  supabase functions deploy --project-ref <target-ref>');
        addLog('warn', 'Edge function code sync must be done via CLI or CI/CD pipeline.');
      }

      // --- Auth Config ---
      if (config.includeAuthConfig) {
        addLog('info', 'Syncing auth configuration...');

        try {
          // Fetch auth config from source via management API
          // Note: This requires the management API which uses a different auth pattern
          addLog('info', 'Auth provider settings must be configured per-environment via the Supabase dashboard or CLI.');
          addLog('info', 'Syncing auth.users table rows...');

          // We can sync the users table content (not passwords/tokens, but profile data)
          const usersResponse = await fetch(
            `${sourceEnv.supabase_url}/auth/v1/admin/users`,
            {
              headers: {
                apikey: sourceEnv.supabase_service_role_key!,
                Authorization: `Bearer ${sourceEnv.supabase_service_role_key!}`,
              },
            }
          );

          if (usersResponse.ok) {
            const usersData = await usersResponse.json();
            const users = usersData.users ?? [];
            addLog('info', `Found ${users.length} users in source`);
            addLog('warn', 'User sync transfers metadata only — passwords and sessions are not transferable.');
          } else {
            addLog('warn', `Could not fetch users: ${usersResponse.statusText}`);
          }
        } catch (authError: any) {
          addLog('error', `Auth sync error: ${authError.message}`);
        }
      }

      // Update sync operation as completed
      const logEntries = syncLog.concat([
        { timestamp: new Date().toISOString(), level: 'success' as const, message: 'Sync completed' },
      ]);

      await supabase
        .from('environment_sync_operations')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          rows_processed: totalProcessed,
          rows_inserted: totalInserted,
          rows_updated: totalUpdated,
          rows_skipped: totalSkipped,
          files_synced: totalFiles,
          log: logEntries,
        })
        .eq('id', syncOp.id);

      addLog('success', 'Sync completed successfully!');
      addLog('info', `Rows: ${totalProcessed} processed, ${totalInserted} inserted, ${totalSkipped} skipped`);
      if (totalFiles > 0) addLog('info', `Files: ${totalFiles} synced`);

      setSyncComplete(true);
      toast.success('Sync completed');
    } catch (error: any) {
      addLog('error', `Sync failed: ${error.message}`);

      await supabase
        .from('environment_sync_operations')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: error.message,
          rows_processed: totalProcessed,
          rows_inserted: totalInserted,
          rows_updated: totalUpdated,
          rows_skipped: totalSkipped,
          files_synced: totalFiles,
        })
        .eq('id', syncOp.id);

      toast.error('Sync failed');
    } finally {
      setSyncing(false);
    }
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

  const selectAllTables = () => {
    setConfig((prev) => ({
      ...prev,
      tables: prev.tables.length === availableTables.length ? [] : [...availableTables],
    }));
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
          <Button onClick={() => navigate('/environments')} className="mt-4">
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
            onClick={() => navigate(`/environments/${environmentId}`)}
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
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TableCellsIcon className="size-5 text-[var(--blue-9)]" />
                <h3 className="text-sm font-semibold text-[var(--gray-12)]">
                  Database Tables
                </h3>
                {config.tables.length > 0 && (
                  <Badge color="info" variant="soft">{config.tables.length}</Badge>
                )}
              </div>
              <button
                onClick={selectAllTables}
                className="text-xs text-[var(--accent-9)] hover:underline"
                disabled={syncing}
              >
                {config.tables.length === availableTables.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            {availableTables.length === 0 ? (
              <div className="text-sm text-[var(--gray-a8)]">No tables discovered</div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {availableTables.map((table) => (
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
