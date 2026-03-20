import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ServerStackIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  SignalIcon,
  ArrowLeftIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Tabs } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';

interface Environment {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  supabase_url: string;
  supabase_anon_key: string | null;
  supabase_service_role_key: string | null;
  type: string;
  is_current: boolean;
  status: string;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncOperation {
  id: string;
  direction: 'push' | 'pull';
  source_environment_id: string;
  target_environment_id: string;
  tables_synced: string[];
  storage_buckets_synced: string[];
  edge_functions_synced: boolean;
  auth_config_synced: boolean;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  rows_processed: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  files_synced: number;
  created_at: string;
  initiated_by: string | null;
}

const statusIconMap: Record<string, typeof CheckCircleIcon> = {
  completed: CheckCircleIcon,
  failed: XCircleIcon,
  running: ArrowPathIcon,
  pending: ClockIcon,
  cancelled: ExclamationTriangleIcon,
};

const statusColorMap: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  running: 'info',
  pending: 'neutral',
  cancelled: 'warning',
};

export default function EnvironmentDetailPage() {
  const { environmentId } = useParams();
  const navigate = useNavigate();
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncOperation[]>([]);
  const [allEnvironments, setAllEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [testing, setTesting] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);

      const [envRes, historyRes, allEnvRes] = await Promise.all([
        supabase.from('environments').select('*').eq('id', environmentId).single(),
        supabase
          .from('environment_sync_operations')
          .select('*')
          .or(`source_environment_id.eq.${environmentId},target_environment_id.eq.${environmentId}`)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase.from('environments').select('id, name, slug'),
      ]);

      if (envRes.error) throw envRes.error;
      setEnvironment(envRes.data);
      setSyncHistory(historyRes.data ?? []);
      setAllEnvironments(allEnvRes.data ?? []);
    } catch (error) {
      console.error('Error loading environment:', error);
      toast.error('Failed to load environment');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (environmentId) loadData();
  }, [environmentId]);

  const handleTestConnection = async () => {
    if (!environment) return;
    setTesting(true);
    try {
      const response = await fetch(`${environment.supabase_url}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: environment.supabase_anon_key || '' },
      });

      const newStatus = response.ok ? 'active' : 'unreachable';
      await supabase
        .from('environments')
        .update({
          status: newStatus,
          last_connected_at: response.ok ? new Date().toISOString() : undefined,
        })
        .eq('id', environment.id);

      toast.success(response.ok ? 'Connection successful' : 'Environment unreachable');
      loadData();
    } catch {
      await supabase
        .from('environments')
        .update({ status: 'unreachable' })
        .eq('id', environment.id);
      toast.error('Connection failed');
      loadData();
    } finally {
      setTesting(false);
    }
  };

  const getEnvName = (id: string) => {
    return allEnvironments.find((e) => e.id === id)?.name || 'Unknown';
  };

  if (loading) {
    return (
      <Page title="Environment">
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

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'history', label: 'Sync History', count: syncHistory.length },
  ];

  return (
    <Page title={environment.name}>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => navigate('/environments')}
            className="gap-1"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </div>

        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
                {environment.name}
              </h1>
              {environment.is_current && (
                <Badge color="info" variant="soft">current</Badge>
              )}
              <Badge color={statusColorMap[environment.status] as any}>
                {environment.status}
              </Badge>
            </div>
            {environment.description && (
              <p className="text-[var(--gray-a8)] mt-1">{environment.description}</p>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              variant="outlined"
              onClick={handleTestConnection}
              disabled={testing}
              className="gap-2"
            >
              <SignalIcon className={`size-4 ${testing ? 'animate-pulse' : ''}`} />
              Test Connection
            </Button>
            <Button
              variant="outlined"
              onClick={() => navigate(`/admin/environments/${environment.id}/provision`)}
              className="gap-2"
            >
              <RocketLaunchIcon className="size-4" />
              Provision
            </Button>
            <Button
              onClick={() => navigate(`/admin/environments/${environment.id}/sync`)}
              className="gap-2"
            >
              <ArrowsRightLeftIcon className="size-4" />
              Sync Content
            </Button>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-xs text-[var(--gray-a8)] uppercase tracking-wide">Type</div>
            <div className="text-sm font-medium mt-1 capitalize">{environment.type}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-[var(--gray-a8)] uppercase tracking-wide">Supabase URL</div>
            <div className="text-sm font-mono mt-1 truncate" title={environment.supabase_url}>
              {environment.supabase_url}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-[var(--gray-a8)] uppercase tracking-wide">Last Connected</div>
            <div className="text-sm font-medium mt-1">
              {environment.last_connected_at
                ? new Date(environment.last_connected_at).toLocaleString()
                : 'Never'}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-[var(--gray-a8)] uppercase tracking-wide">Credentials</div>
            <div className="text-sm mt-1 flex gap-2">
              <Badge color={environment.supabase_anon_key ? 'success' : 'neutral'} variant="soft">
                anon
              </Badge>
              <Badge color={environment.supabase_service_role_key ? 'success' : 'neutral'} variant="soft">
                service_role
              </Badge>
            </div>
          </Card>
        </div>

        <Tabs
          value={activeTab}
          onChange={setActiveTab}
          tabs={tabs}
        />

        {activeTab === 'overview' && (
          <Card className="p-6">
            <h3 className="text-lg font-medium text-[var(--gray-12)] mb-4">Connection Details</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--gray-a8)]">Supabase URL</label>
                <div className="font-mono text-sm bg-[var(--gray-a2)] rounded-lg p-3 mt-1">
                  {environment.supabase_url}
                </div>
              </div>
              <div>
                <label className="text-sm text-[var(--gray-a8)]">Anon Key</label>
                <div className="font-mono text-sm bg-[var(--gray-a2)] rounded-lg p-3 mt-1">
                  {environment.supabase_anon_key
                    ? `${environment.supabase_anon_key.substring(0, 20)}...`
                    : 'Not configured'}
                </div>
              </div>
              <div>
                <label className="text-sm text-[var(--gray-a8)]">Service Role Key</label>
                <div className="font-mono text-sm bg-[var(--gray-a2)] rounded-lg p-3 mt-1">
                  {environment.supabase_service_role_key
                    ? `${environment.supabase_service_role_key.substring(0, 20)}...`
                    : 'Not configured'}
                </div>
              </div>
            </div>
          </Card>
        )}

        {activeTab === 'history' && (
          <Card className="overflow-hidden">
            {syncHistory.length === 0 ? (
              <div className="p-12 text-center">
                <ArrowsRightLeftIcon className="mx-auto h-12 w-12 text-[var(--gray-a6)]" />
                <h3 className="mt-2 text-sm font-medium">No sync history</h3>
                <p className="mt-1 text-sm text-[var(--gray-a8)]">
                  Content sync operations involving this environment will appear here.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--gray-a5)]">
                {syncHistory.map((op) => {
                  const StatusIcon = statusIconMap[op.status] || ClockIcon;
                  const isSource = op.source_environment_id === environmentId;
                  const otherEnvName = getEnvName(
                    isSource ? op.target_environment_id : op.source_environment_id
                  );

                  return (
                    <div key={op.id} className="p-4 flex items-center gap-4">
                      <div className={`p-2 rounded-lg bg-[var(--${op.direction === 'push' ? 'blue' : 'green'}-a3)]`}>
                        <ArrowsRightLeftIcon className={`size-5 text-[var(--${op.direction === 'push' ? 'blue' : 'green'}-9)]`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium capitalize">{op.direction}</span>
                          <span className="text-[var(--gray-a8)]">
                            {op.direction === 'push' ? 'to' : 'from'}
                          </span>
                          <span className="font-medium">{otherEnvName}</span>
                        </div>
                        <div className="text-xs text-[var(--gray-a8)] mt-1 flex gap-3">
                          {op.tables_synced.length > 0 && (
                            <span>{op.tables_synced.length} table(s)</span>
                          )}
                          {op.rows_processed > 0 && (
                            <span>{op.rows_processed.toLocaleString()} rows</span>
                          )}
                          {op.files_synced > 0 && (
                            <span>{op.files_synced} files</span>
                          )}
                          {op.edge_functions_synced && <span>edge functions</span>}
                        </div>
                      </div>
                      <Badge color={statusColorMap[op.status] as any} variant="soft">
                        <StatusIcon className="size-3 mr-1" />
                        {op.status}
                      </Badge>
                      <span className="text-xs text-[var(--gray-a8)] whitespace-nowrap">
                        {new Date(op.created_at).toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}
      </div>
    </Page>
  );
}
