import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CircleStackIcon,
  CubeIcon,
  ServerStackIcon,
  CodeBracketIcon,
  ArchiveBoxIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';

interface Environment {
  id: string;
  name: string;
  slug: string;
  type: string;
  supabase_url: string;
  supabase_service_role_key: string | null;
  status: string;
}

type MigrationStatus = 'pending' | 'applied' | 'changed';

interface CoreMigration {
  filename: string;
  status: MigrationStatus;
}

interface ModuleMigration {
  moduleId: string;
  moduleName: string;
  filename: string;
  status: MigrationStatus;
}

interface ProvisionPreview {
  coreMigrations: CoreMigration[];
  moduleMigrations: ModuleMigration[];
  edgeFunctions: string[];
  storageBuckets: string[];
  targetHasTracking: boolean;
  appliedCount: number;
}

interface SyncLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export default function ProvisionPage() {
  const { environmentId } = useParams();
  const navigate = useNavigate();

  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [preview, setPreview] = useState<ProvisionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [provisioning, setProvisioning] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [operationLog, setOperationLog] = useState<SyncLogEntry[]>([]);

  const [steps, setSteps] = useState({
    coreMigrations: true,
    moduleMigrations: true,
    storageBuckets: true,
    edgeFunctions: true,
    contentSync: false,
  });

  const loadData = async () => {
    try {
      setLoading(true);

      const [envRes, previewRes] = await Promise.all([
        supabase.from('environments').select('*').eq('id', environmentId).single(),
        fetch(`/api/environments/provision/preview?environmentId=${environmentId}`).then((r) => r.json()),
      ]);

      if (envRes.error) throw envRes.error;
      setEnvironment(envRes.data);
      setPreview(previewRes);
    } catch (error) {
      console.error('Error loading provision data:', error);
      toast.error('Failed to load provisioning data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (environmentId) loadData();
  }, [environmentId]);

  // Poll operation status
  useEffect(() => {
    if (!operationId || operationStatus === 'completed' || operationStatus === 'failed') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/environments/sync/${operationId}`);
        const data = await res.json();

        if (data.operation) {
          setOperationStatus(data.operation.status);
          if (data.operation.log) {
            setOperationLog(data.operation.log);
          }

          if (data.operation.status === 'completed' || data.operation.status === 'failed') {
            setProvisioning(false);
            if (data.operation.status === 'completed') {
              toast.success('Provisioning complete!');
            } else {
              toast.error(`Provisioning failed: ${data.operation.error_message || 'Unknown error'}`);
            }
          }
        }
      } catch {
        // Polling error, will retry
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [operationId, operationStatus]);

  const handleProvision = async () => {
    if (!environment) return;

    if (environment.type === 'production') {
      const confirmed = window.confirm(
        'You are about to provision a PRODUCTION environment. This will apply all database migrations. Are you sure?'
      );
      if (!confirmed) return;
    }

    setProvisioning(true);
    setOperationLog([]);
    setOperationStatus('running');

    try {
      const res = await fetch('/api/environments/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environmentId: environment.id,
          steps,
        }),
      });

      const data = await res.json();

      if (data.success && data.operationId) {
        setOperationId(data.operationId);
        toast.success('Provisioning started');
      } else {
        toast.error(data.error || 'Failed to start provisioning');
        setProvisioning(false);
        setOperationStatus(null);
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to start provisioning');
      setProvisioning(false);
      setOperationStatus(null);
    }
  };

  if (loading) {
    return (
      <Page title="Provision">
        <div className="p-6 flex items-center justify-center min-h-[400px]">
          <ArrowPathIcon className="size-6 animate-spin text-[var(--gray-a8)]" />
        </div>
      </Page>
    );
  }

  if (!environment) {
    return (
      <Page title="Not Found">
        <div className="p-6 text-center">
          <h2 className="text-lg font-medium">Environment not found</h2>
          <Button onClick={() => navigate('/environments')} className="mt-4">
            Back to Environments
          </Button>
        </div>
      </Page>
    );
  }

  const modulesByName = preview?.moduleMigrations.reduce<Record<string, ModuleMigration[]>>((acc, m) => {
    if (!acc[m.moduleName]) acc[m.moduleName] = [];
    acc[m.moduleName].push(m);
    return acc;
  }, {}) ?? {};

  const pendingCoreCount = preview?.coreMigrations.filter((m) => m.status !== 'applied').length ?? 0;
  const pendingModuleCount = preview?.moduleMigrations.filter((m) => m.status !== 'applied').length ?? 0;
  const totalPendingCount = pendingCoreCount + pendingModuleCount;

  const statusIcon = (status: MigrationStatus) => {
    if (status === 'applied') return <CheckCircleIcon className="size-3.5 text-[var(--green-9)]" />;
    if (status === 'changed') return <ExclamationTriangleIcon className="size-3.5 text-[var(--amber-9)]" />;
    return <span className="size-3.5 rounded-full border-2 border-[var(--gray-a6)] inline-block" />;
  };

  return (
    <Page title={`Provision — ${environment.name}`}>
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
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Provision Environment
            </h1>
            <Badge color="info" variant="soft">{environment.name}</Badge>
          </div>
          <p className="text-[var(--gray-a8)] mt-1">
            Deploy the full Gatewaze platform — database schema, module tables, storage buckets, and
            edge function configuration — to a clean Supabase project.
          </p>
        </div>

        {/* Target Info */}
        <Card className="p-4 border-l-4 border-l-[var(--accent-9)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <ServerStackIcon className="size-5 text-[var(--accent-9)]" />
              <div>
                <div className="font-medium">{environment.name}</div>
                <div className="font-mono text-xs text-[var(--gray-a8)]">{environment.supabase_url}</div>
              </div>
              {!environment.supabase_service_role_key && (
                <Badge color="error" variant="soft">Missing service role key</Badge>
              )}
            </div>
            <div className="flex items-center gap-3">
              {preview?.targetHasTracking && (
                <Badge color="success" variant="soft">
                  {preview.appliedCount} migration(s) applied
                </Badge>
              )}
              {totalPendingCount > 0 && (
                <Badge color="info" variant="soft">
                  {totalPendingCount} pending
                </Badge>
              )}
              {totalPendingCount === 0 && preview && (
                <Badge color="success" variant="soft">
                  <CheckCircleIcon className="size-3 mr-1" />
                  Up to date
                </Badge>
              )}
            </div>
          </div>
        </Card>

        {/* Steps Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Core Migrations */}
          <Card className="p-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={steps.coreMigrations}
                onChange={(e) => setSteps((s) => ({ ...s, coreMigrations: e.target.checked }))}
                disabled={provisioning}
                className="rounded mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <CircleStackIcon className="size-5 text-[var(--blue-9)]" />
                  <span className="font-medium">Core Schema</span>
                  {pendingCoreCount > 0 ? (
                    <Badge color="info" variant="soft">{pendingCoreCount} pending</Badge>
                  ) : preview ? (
                    <Badge color="success" variant="soft">up to date</Badge>
                  ) : (
                    <Badge color="neutral" variant="soft">{preview?.coreMigrations.length ?? 0} files</Badge>
                  )}
                </div>
                <p className="text-xs text-[var(--gray-a8)] mt-1">
                  Foundation tables, admin system, people, events, RLS policies, RPC functions
                </p>
                {preview && steps.coreMigrations && (
                  <div className="mt-3 text-xs space-y-1 font-mono">
                    {preview.coreMigrations.map((m) => (
                      <div key={m.filename} className="flex items-center gap-2">
                        {statusIcon(m.status)}
                        <span className={m.status === 'applied' ? 'text-[var(--gray-a7)]' : 'text-[var(--gray-12)]'}>
                          {m.filename}
                        </span>
                        {m.status === 'changed' && (
                          <Badge color="warning" variant="soft" className="text-[10px]">changed</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </label>
          </Card>

          {/* Module Migrations */}
          <Card className="p-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={steps.moduleMigrations}
                onChange={(e) => setSteps((s) => ({ ...s, moduleMigrations: e.target.checked }))}
                disabled={provisioning}
                className="rounded mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <CubeIcon className="size-5 text-[var(--purple-9)]" />
                  <span className="font-medium">Module Migrations</span>
                  {pendingModuleCount > 0 ? (
                    <Badge color="purple" variant="soft">{pendingModuleCount} pending</Badge>
                  ) : preview ? (
                    <Badge color="success" variant="soft">up to date</Badge>
                  ) : (
                    <Badge color="neutral" variant="soft">{preview?.moduleMigrations.length ?? 0} files</Badge>
                  )}
                </div>
                <p className="text-xs text-[var(--gray-a8)] mt-1">
                  Tables and data for all enabled modules, plus module registry sync
                </p>
                {preview && steps.moduleMigrations && Object.keys(modulesByName).length > 0 && (
                  <div className="mt-3 text-xs space-y-2">
                    {Object.entries(modulesByName).map(([name, migrations]) => (
                      <div key={name}>
                        <span className="font-medium text-[var(--gray-11)]">{name}</span>
                        {migrations.map((m) => (
                          <div key={m.filename} className="font-mono ml-3 flex items-center gap-2 mt-0.5">
                            {statusIcon(m.status)}
                            <span className={m.status === 'applied' ? 'text-[var(--gray-a7)]' : 'text-[var(--gray-12)]'}>
                              {m.filename}
                            </span>
                            {m.status === 'changed' && (
                              <Badge color="warning" variant="soft" className="text-[10px]">changed</Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </label>
          </Card>

          {/* Storage Buckets */}
          <Card className="p-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={steps.storageBuckets}
                onChange={(e) => setSteps((s) => ({ ...s, storageBuckets: e.target.checked }))}
                disabled={provisioning}
                className="rounded mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <ArchiveBoxIcon className="size-5 text-[var(--green-9)]" />
                  <span className="font-medium">Storage Buckets</span>
                  <Badge color="success" variant="soft">
                    {preview?.storageBuckets.length ?? 0}
                  </Badge>
                </div>
                <p className="text-xs text-[var(--gray-a8)] mt-1">
                  Create storage buckets on the target to match your local environment
                </p>
                {preview && steps.storageBuckets && preview.storageBuckets.length > 0 && (
                  <div className="mt-3 text-xs font-mono text-[var(--gray-a8)] space-y-0.5">
                    {preview.storageBuckets.map((b) => (
                      <div key={b}>{b}</div>
                    ))}
                  </div>
                )}
              </div>
            </label>
          </Card>

          {/* Edge Functions */}
          <Card className="p-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={steps.edgeFunctions}
                onChange={(e) => setSteps((s) => ({ ...s, edgeFunctions: e.target.checked }))}
                disabled={provisioning}
                className="rounded mt-1"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <CodeBracketIcon className="size-5 text-[var(--amber-9)]" />
                  <span className="font-medium">Edge Functions</span>
                  <Badge color="warning" variant="soft">
                    {preview?.edgeFunctions.length ?? 0}
                  </Badge>
                </div>
                <p className="text-xs text-[var(--gray-a8)] mt-1">
                  Generates CLI commands to deploy edge functions. Requires Supabase CLI.
                </p>
                {preview && steps.edgeFunctions && preview.edgeFunctions.length > 0 && (
                  <div className="mt-3 text-xs font-mono text-[var(--gray-a8)] max-h-32 overflow-y-auto space-y-0.5">
                    {preview.edgeFunctions.map((f) => (
                      <div key={f}>{f}</div>
                    ))}
                  </div>
                )}
              </div>
            </label>
          </Card>
        </div>

        {/* Production Warning */}
        {environment.type === 'production' && (
          <Card className="p-4 border-2 border-[var(--amber-9)]">
            <div className="flex items-start gap-3">
              <ExclamationTriangleIcon className="size-6 text-[var(--amber-9)] shrink-0 mt-0.5" />
              <div>
                <h4 className="font-medium text-[var(--amber-11)]">Production Environment</h4>
                <p className="text-sm text-[var(--gray-a8)] mt-1">
                  You are provisioning a production environment. Migrations are idempotent (using IF NOT EXISTS)
                  but please ensure you have reviewed what will be applied. You will be asked to confirm.
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Provision Button */}
        <div className="flex justify-end gap-3">
          {operationStatus === 'completed' && (
            <Button
              variant="outlined"
              onClick={() => navigate(`/admin/environments/${environmentId}/sync`)}
              className="gap-2"
            >
              Continue to Content Sync
            </Button>
          )}
          <Button
            onClick={handleProvision}
            disabled={provisioning || !environment.supabase_service_role_key || (!steps.coreMigrations && !steps.moduleMigrations && !steps.storageBuckets && !steps.edgeFunctions)}
            className="gap-2 px-6"
          >
            {provisioning ? (
              <>
                <ArrowPathIcon className="size-4 animate-spin" />
                Provisioning...
              </>
            ) : (
              <>
                <RocketLaunchIcon className="size-4" />
                Provision Environment
              </>
            )}
          </Button>
        </div>

        {/* Operation Log */}
        {operationLog.length > 0 && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">Provisioning Log</h3>
              {operationStatus === 'completed' && (
                <Badge color="success" variant="soft">
                  <CheckCircleIcon className="size-3 mr-1" />
                  Complete
                </Badge>
              )}
              {operationStatus === 'failed' && (
                <Badge color="error" variant="soft">
                  <ExclamationTriangleIcon className="size-3 mr-1" />
                  Failed
                </Badge>
              )}
              {operationStatus === 'running' && (
                <Badge color="info" variant="soft">
                  <ArrowPathIcon className="size-3 mr-1 animate-spin" />
                  Running
                </Badge>
              )}
            </div>

            <div className="bg-[var(--gray-a2)] rounded-lg p-4 max-h-96 overflow-y-auto font-mono text-xs space-y-1">
              {operationLog.map((entry, i) => (
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
