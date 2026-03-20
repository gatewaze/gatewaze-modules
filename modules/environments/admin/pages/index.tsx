import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ServerStackIcon,
  PlusIcon,
  ArrowPathIcon,
  SignalIcon,
  SignalSlashIcon,
  CloudIcon,
  ComputerDesktopIcon,
  ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Badge,
  Modal,
  Input,
  Select,
  ConfirmModal,
} from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { useAuthContext } from '@/app/contexts/auth/context';
import { supabase } from '@/lib/supabase';
import { useForm } from 'react-hook-form';

interface Environment {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  supabase_url: string;
  supabase_anon_key: string | null;
  supabase_service_role_key: string | null;
  type: 'development' | 'staging' | 'production' | 'self-hosted';
  is_current: boolean;
  status: 'active' | 'inactive' | 'unreachable';
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EnvironmentFormData {
  name: string;
  slug: string;
  description: string;
  supabase_url: string;
  supabase_anon_key: string;
  supabase_service_role_key: string;
  type: Environment['type'];
}

const typeOptions = [
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
  { value: 'self-hosted', label: 'Self-Hosted' },
];

const typeColorMap: Record<string, string> = {
  development: 'blue',
  staging: 'amber',
  production: 'green',
  'self-hosted': 'purple',
};

const statusColorMap: Record<string, string> = {
  active: 'success',
  inactive: 'neutral',
  unreachable: 'warning',
};

const columnHelper = createColumnHelper<Environment>();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function EnvironmentsPage() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEnv, setEditingEnv] = useState<Environment | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteEnv, setDeleteEnv] = useState<Environment | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const { register, handleSubmit, reset, setValue, watch, formState: { errors } } = useForm<EnvironmentFormData>({
    defaultValues: { type: 'development' },
  });

  const nameValue = watch('name');

  const loadEnvironments = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('environments')
        .select('*')
        .order('is_current', { ascending: false })
        .order('type')
        .order('name');

      if (error) throw error;
      setEnvironments(data ?? []);
    } catch (error) {
      console.error('Error loading environments:', error);
      toast.error('Failed to load environments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEnvironments();
  }, []);

  // Auto-generate slug from name when creating
  useEffect(() => {
    if (!editingEnv && nameValue) {
      setValue('slug', slugify(nameValue));
    }
  }, [nameValue, editingEnv, setValue]);

  const handleTestConnection = async (env: Environment) => {
    setTesting(env.id);
    try {
      // Try to reach the Supabase instance by fetching its health endpoint
      const response = await fetch(`${env.supabase_url}/rest/v1/`, {
        method: 'HEAD',
        headers: {
          'apikey': env.supabase_anon_key || '',
        },
      });

      const newStatus = response.ok ? 'active' : 'unreachable';
      await supabase
        .from('environments')
        .update({
          status: newStatus,
          last_connected_at: response.ok ? new Date().toISOString() : undefined,
        })
        .eq('id', env.id);

      toast.success(response.ok ? 'Connection successful' : 'Environment unreachable');
      loadEnvironments();
    } catch {
      await supabase
        .from('environments')
        .update({ status: 'unreachable' })
        .eq('id', env.id);

      toast.error('Connection failed');
      loadEnvironments();
    } finally {
      setTesting(null);
    }
  };

  const handleOpenModal = (env?: Environment) => {
    if (env) {
      setEditingEnv(env);
      reset({
        name: env.name,
        slug: env.slug,
        description: env.description || '',
        supabase_url: env.supabase_url,
        supabase_anon_key: env.supabase_anon_key || '',
        supabase_service_role_key: env.supabase_service_role_key || '',
        type: env.type,
      });
    } else {
      setEditingEnv(null);
      reset({
        name: '',
        slug: '',
        description: '',
        supabase_url: '',
        supabase_anon_key: '',
        supabase_service_role_key: '',
        type: 'development',
      });
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingEnv(null);
    reset();
  };

  const onSubmit = async (data: EnvironmentFormData) => {
    try {
      setSubmitting(true);
      const payload = {
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        supabase_url: data.supabase_url,
        supabase_anon_key: data.supabase_anon_key || null,
        supabase_service_role_key: data.supabase_service_role_key || null,
        type: data.type,
      };

      if (editingEnv) {
        const { error } = await supabase
          .from('environments')
          .update(payload)
          .eq('id', editingEnv.id);
        if (error) throw error;
        toast.success('Environment updated');
      } else {
        const { error } = await supabase
          .from('environments')
          .insert(payload);
        if (error) throw error;
        toast.success('Environment created');
      }

      handleCloseModal();
      loadEnvironments();
    } catch (error: any) {
      console.error('Error saving environment:', error);
      toast.error(error?.message || 'Failed to save environment');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteEnv) return;
    try {
      const { error } = await supabase
        .from('environments')
        .delete()
        .eq('id', deleteEnv.id);
      if (error) throw error;
      toast.success('Environment deleted');
      setDeleteEnv(null);
      loadEnvironments();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to delete environment');
    }
  };

  const handleMarkCurrent = async (env: Environment) => {
    try {
      // Clear any existing current flag
      await supabase
        .from('environments')
        .update({ is_current: false })
        .eq('is_current', true);

      // Set this one as current
      await supabase
        .from('environments')
        .update({ is_current: true })
        .eq('id', env.id);

      toast.success(`${env.name} set as current environment`);
      loadEnvironments();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update current environment');
    }
  };

  const TypeIcon = ({ type }: { type: string }) => {
    switch (type) {
      case 'production':
      case 'staging':
        return <CloudIcon className="size-4" />;
      case 'self-hosted':
        return <ServerStackIcon className="size-4" />;
      default:
        return <ComputerDesktopIcon className="size-4" />;
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Environment',
        cell: (info) => {
          const env = info.row.original;
          return (
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg bg-[var(--${typeColorMap[env.type] || 'gray'}-a3)]`}>
                <TypeIcon type={env.type} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{info.getValue()}</span>
                  {env.is_current && (
                    <Badge color="info" variant="soft">current</Badge>
                  )}
                </div>
                {env.description && (
                  <div className="text-xs text-[var(--gray-a8)] max-w-xs truncate">
                    {env.description}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('type', {
        header: 'Type',
        cell: (info) => (
          <Badge variant="soft" color={typeColorMap[info.getValue()] as any || 'gray'}>
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('supabase_url', {
        header: 'URL',
        cell: (info) => (
          <span className="font-mono text-xs text-[var(--gray-a8)] max-w-[200px] truncate block">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const env = info.row.original;
          const isTestingThis = testing === env.id;
          return (
            <div className="flex items-center gap-2">
              <Badge color={statusColorMap[info.getValue()] as any}>
                {isTestingThis ? 'testing...' : info.getValue()}
              </Badge>
              {info.getValue() === 'active' ? (
                <SignalIcon className="size-4 text-[var(--green-9)]" />
              ) : (
                <SignalSlashIcon className="size-4 text-[var(--gray-a8)]" />
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('last_connected_at', {
        header: 'Last Connected',
        cell: (info) => {
          const val = info.getValue();
          if (!val) return <span className="text-[var(--gray-a8)]">Never</span>;
          return (
            <span className="text-[var(--gray-a8)] text-sm">
              {new Date(val).toLocaleDateString()}
            </span>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 50,
        cell: (info) => {
          const env = info.row.original;
          return (
            <RowActions
              actions={[
                {
                  label: 'View Details',
                  icon: <ServerStackIcon className="size-4" />,
                  onClick: () => navigate(`/admin/environments/${env.id}`),
                },
                {
                  label: 'Sync Content',
                  icon: <ArrowsRightLeftIcon className="size-4" />,
                  onClick: () => navigate(`/admin/environments/${env.id}/sync`),
                },
                {
                  label: 'Test Connection',
                  icon: <SignalIcon className="size-4" />,
                  onClick: () => handleTestConnection(env),
                },
                {
                  label: 'Set as Current',
                  icon: <ComputerDesktopIcon className="size-4" />,
                  onClick: () => handleMarkCurrent(env),
                  hidden: env.is_current,
                },
                {
                  label: 'Edit',
                  onClick: () => handleOpenModal(env),
                },
                {
                  label: 'Delete',
                  onClick: () => setDeleteEnv(env),
                  color: 'red',
                  hidden: env.is_current,
                },
              ]}
            />
          );
        },
      }),
    ],
    [navigate, testing]
  );

  const table = useReactTable({
    data: environments,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const currentEnv = environments.find((e) => e.is_current);
  const activeCount = environments.filter((e) => e.status === 'active').length;

  return (
    <Page title="Environments">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Environments
            </h1>
            <p className="text-[var(--gray-a8)] mt-1">
              Manage Supabase environments and sync content between them
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <Button
              onClick={loadEnvironments}
              variant="outlined"
              className="gap-2"
              disabled={loading}
            >
              <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={() => handleOpenModal()} className="gap-2">
              <PlusIcon className="size-4" />
              Add Environment
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--blue-a3)] rounded-lg">
                <ServerStackIcon className="size-6 text-[var(--blue-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Total Environments</div>
                <div className="text-2xl font-bold mt-1">{environments.length}</div>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--green-a3)] rounded-lg">
                <SignalIcon className="size-6 text-[var(--green-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Active Connections</div>
                <div className="text-2xl font-bold mt-1">{activeCount}</div>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--purple-a3)] rounded-lg">
                <ComputerDesktopIcon className="size-6 text-[var(--purple-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Current Environment</div>
                <div className="text-lg font-bold mt-1 truncate">
                  {currentEnv?.name || 'Not set'}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Table */}
        <Card className="overflow-hidden">
          <DataTable
            table={table}
            loading={loading}
            onRowDoubleClick={(env) => navigate(`/admin/environments/${env.id}`)}
            emptyState={
              <div>
                <ServerStackIcon className="mx-auto h-12 w-12 text-[var(--gray-a6)]" />
                <h3 className="mt-2 text-sm font-medium">No environments configured</h3>
                <p className="mt-1 text-sm text-[var(--gray-a8)]">
                  Add your first Supabase environment to get started with content syncing.
                </p>
                <Button onClick={() => handleOpenModal()} className="mt-4 gap-2">
                  <PlusIcon className="size-4" />
                  Add Environment
                </Button>
              </div>
            }
          />
        </Card>
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingEnv ? 'Edit Environment' : 'Add Environment'}
        size="lg"
        footer={
          <div className="flex gap-3 justify-end">
            <Button variant="outlined" onClick={handleCloseModal} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit(onSubmit)} disabled={submitting}>
              {submitting ? 'Saving...' : editingEnv ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="e.g. Production Cloud"
            {...register('name', { required: 'Name is required' })}
            error={errors.name?.message}
          />

          <Input
            label="Slug"
            placeholder="production-cloud"
            {...register('slug', { required: 'Slug is required' })}
            error={errors.slug?.message}
          />

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Description
            </label>
            <textarea
              {...register('description')}
              rows={2}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)] placeholder:text-[var(--gray-a8)]"
              placeholder="Optional description"
            />
          </div>

          <Select
            label="Type"
            {...register('type')}
            data={typeOptions}
          />

          <div className="border-t border-[var(--gray-a5)] pt-4 mt-4">
            <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-3">
              Supabase Connection
            </h3>

            <div className="space-y-4">
              <Input
                label="Supabase URL"
                placeholder="https://your-project.supabase.co"
                {...register('supabase_url', { required: 'Supabase URL is required' })}
                error={errors.supabase_url?.message}
              />

              <Input
                label="Anon Key"
                placeholder="eyJ..."
                type="password"
                {...register('supabase_anon_key')}
              />

              <Input
                label="Service Role Key"
                placeholder="eyJ..."
                type="password"
                {...register('supabase_service_role_key')}
                description="Required for pushing/pulling content. Keep this secret."
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={!!deleteEnv}
        onClose={() => setDeleteEnv(null)}
        onConfirm={handleDelete}
        title="Delete Environment"
        message={`Are you sure you want to delete "${deleteEnv?.name}"? Sync history for this environment will also be removed.`}
        confirmText="Delete"
        confirmVariant="danger"
      />
    </Page>
  );
}
