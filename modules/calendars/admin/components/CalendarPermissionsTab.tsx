import { useState, useEffect, useMemo } from 'react';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  ArrowPathIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import {
  Card,
  Button,
  Badge,
  Modal,
  Select,
  ConfirmModal,
} from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { Calendar } from '../services/calendarService';
import { PermissionsService } from '@/lib/permissions/service';
import {
  AdminCalendarPermission,
  CalendarPermissionLevel,
} from '@/lib/permissions/types';
import { useCalendarPermissionManagement } from '@/hooks/usePermissions';
import { supabase } from '@/lib/supabase';

interface CalendarPermissionsTabProps {
  calendar: Calendar;
}

interface AdminWithPermission extends AdminCalendarPermission {
  admin?: {
    email: string;
    first_name?: string;
    last_name?: string;
  };
}

const PAGE_SIZE = 25;

const columnHelper = createColumnHelper<AdminWithPermission>();

const permissionLevels: { value: CalendarPermissionLevel; label: string }[] = [
  { value: 'view', label: 'View Only' },
  { value: 'edit', label: 'Edit' },
  { value: 'manage', label: 'Manage' },
];

export function CalendarPermissionsTab({ calendar }: CalendarPermissionsTabProps) {
  const [permissions, setPermissions] = useState<AdminWithPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'granted_at', desc: true }
  ]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [revokePermission, setRevokePermission] = useState<AdminWithPermission | null>(null);
  const [granting, setGranting] = useState(false);

  // Form state for adding permission
  const [availableAdmins, setAvailableAdmins] = useState<any[]>([]);
  const [searchingAdmins, setSearchingAdmins] = useState(false);
  const [adminSearch, setAdminSearch] = useState('');
  const [selectedAdminId, setSelectedAdminId] = useState<string>('');
  const [selectedPermissionLevel, setSelectedPermissionLevel] = useState<CalendarPermissionLevel>('view');

  const { grantCalendarPermission, revokeCalendarPermission } = useCalendarPermissionManagement();

  useEffect(() => {
    loadPermissions();
  }, [calendar.id]);

  const loadPermissions = async () => {
    setLoading(true);
    try {
      const admins = await PermissionsService.getCalendarAdmins(calendar.id);

      // Enrich with admin profile data
      const enrichedAdmins = await Promise.all(
        admins.map(async (permission) => {
          const { data: admin } = await supabase
            .from('admin_profiles')
            .select('email, first_name, last_name')
            .eq('id', permission.admin_id)
            .single();

          return {
            ...permission,
            admin: admin || undefined,
          };
        })
      );

      setPermissions(enrichedAdmins);
    } catch (error) {
      console.error('Error loading permissions:', error);
      toast.error('Failed to load permissions');
    } finally {
      setLoading(false);
    }
  };

  const searchAdmins = async () => {
    if (!adminSearch.trim()) {
      setAvailableAdmins([]);
      return;
    }

    setSearchingAdmins(true);
    try {
      // Get admins who don't already have permission for this calendar
      const existingAdminIds = permissions.map(p => p.admin_id);

      const { data, error } = await supabase
        .from('admin_profiles')
        .select('id, email, first_name, last_name')
        .or(`email.ilike.%${adminSearch}%,first_name.ilike.%${adminSearch}%,last_name.ilike.%${adminSearch}%`)
        .not('id', 'in', existingAdminIds.length > 0 ? `(${existingAdminIds.join(',')})` : '()')
        .limit(20);

      if (error) throw error;
      setAvailableAdmins(data || []);
    } catch (error) {
      console.error('Error searching admins:', error);
      toast.error('Failed to search admins');
    } finally {
      setSearchingAdmins(false);
    }
  };

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (isAddModalOpen) {
        searchAdmins();
      }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [adminSearch, isAddModalOpen]);

  const handleGrantPermission = async () => {
    if (!selectedAdminId) {
      toast.error('Please select an admin');
      return;
    }

    setGranting(true);
    try {
      await grantCalendarPermission(
        selectedAdminId,
        calendar.id,
        selectedPermissionLevel
      );

      toast.success('Permission granted');
      setIsAddModalOpen(false);
      setSelectedAdminId('');
      setSelectedPermissionLevel('view');
      setAdminSearch('');
      loadPermissions();
    } catch (error) {
      console.error('Error granting permission:', error);
      toast.error('Failed to grant permission');
    } finally {
      setGranting(false);
    }
  };

  const handleRevokePermission = async () => {
    if (!revokePermission) return;

    try {
      await revokeCalendarPermission(revokePermission.admin_id, calendar.id);

      toast.success('Permission revoked');
      setRevokePermission(null);
      loadPermissions();
    } catch (error) {
      console.error('Error revoking permission:', error);
      toast.error('Failed to revoke permission');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('admin', {
        header: 'Admin',
        cell: (info) => {
          const admin = info.getValue();
          return (
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                {admin?.email || 'Unknown'}
              </div>
              {admin && (admin.first_name || admin.last_name) && (
                <div className="text-xs text-gray-500">
                  {[admin.first_name, admin.last_name].filter(Boolean).join(' ')}
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('permission_level', {
        header: 'Permission Level',
        cell: (info) => (
          <Badge
            color={
              info.getValue() === 'manage' ? 'error' :
              info.getValue() === 'edit' ? 'warning' : 'neutral'
            }
            className="capitalize"
          >
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('granted_at', {
        header: 'Granted At',
        cell: (info) => {
          const dateStr = info.getValue();
          if (!dateStr) return '-';
          return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
        },
      }),
      columnHelper.accessor('expires_at', {
        header: 'Expires',
        cell: (info) => {
          const dateStr = info.getValue();
          if (!dateStr) return 'Never';
          return new Date(dateStr).toLocaleDateString();
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 50,
        cell: (info) => (
          <RowActions
            actions={[
              {
                label: 'Revoke',
                icon: <TrashIcon className="size-4" />,
                onClick: () => setRevokePermission(info.row.original),
                color: 'red',
              },
            ]}
          />
        ),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: permissions,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageSize: PAGE_SIZE,
      },
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Admin Permissions</h2>
          <p className="text-sm text-gray-500">
            Manage which admin users can access this calendar
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={loadPermissions}
            variant="outlined"
            className="gap-2"
            disabled={loading}
          >
            <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={() => setIsAddModalOpen(true)} className="gap-2">
            <PlusIcon className="size-4" />
            Grant Permission
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card skin="shadow" className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <div className="flex gap-3">
          <ShieldCheckIcon className="size-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-1">Permission Levels:</p>
            <ul className="space-y-1 text-blue-600 dark:text-blue-400">
              <li><strong>View:</strong> Can view calendar and its events</li>
              <li><strong>Edit:</strong> Can view and modify calendar events</li>
              <li><strong>Manage:</strong> Full access including member management and settings</li>
            </ul>
            <p className="mt-2">
              Note: Calendar admins automatically have access to all events within the calendar.
            </p>
          </div>
        </div>
      </Card>

      {/* Search */}
      <Card skin="shadow" className="p-4">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
          <input
            type="text"
            placeholder="Search permissions..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </Card>

      {/* Permissions Table */}
      <Card className="overflow-hidden">
        <DataTable
          table={table}
          loading={loading}
          emptyState={
            <div>
              <ShieldCheckIcon className="size-12 text-[var(--gray-a6)] mx-auto pb-2" />
              <p className="text-[var(--gray-a8)]">No admin permissions configured</p>
              <p className="text-xs text-[var(--gray-a6)] pt-1 pb-4">
                The calendar creator automatically has manage access.
              </p>
              <Button onClick={() => setIsAddModalOpen(true)} className="gap-2">
                <PlusIcon className="size-4" />
                Grant Permission
              </Button>
            </div>
          }
        />
      </Card>

      {/* Grant Permission Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setSelectedAdminId('');
          setSelectedPermissionLevel('view');
          setAdminSearch('');
        }}
        title="Grant Calendar Permission"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Search Admin
            </label>
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
              <input
                type="text"
                placeholder="Search by email or name..."
                value={adminSearch}
                onChange={(e) => setAdminSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          {searchingAdmins ? (
            <div className="py-4 text-center">
              <LoadingSpinner size="small" />
            </div>
          ) : availableAdmins.length > 0 ? (
            <div className="max-h-48 overflow-y-auto border rounded-lg divide-y">
              {availableAdmins.map((admin) => (
                <label
                  key={admin.id}
                  className={`flex items-center gap-3 p-3 cursor-pointer ${
                    selectedAdminId === admin.id
                      ? 'bg-primary-50 dark:bg-primary-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="admin"
                    checked={selectedAdminId === admin.id}
                    onChange={() => setSelectedAdminId(admin.id)}
                    className="rounded-full"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{admin.email}</div>
                    {(admin.first_name || admin.last_name) && (
                      <div className="text-xs text-gray-500">
                        {[admin.first_name, admin.last_name].filter(Boolean).join(' ')}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          ) : adminSearch.trim() ? (
            <div className="py-4 text-center text-gray-500">
              No admins found
            </div>
          ) : null}

          <Select
            label="Permission Level"
            value={selectedPermissionLevel}
            onChange={(e) => setSelectedPermissionLevel(e.target.value as CalendarPermissionLevel)}
            options={permissionLevels}
          />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button
              variant="outlined"
              onClick={() => {
                setIsAddModalOpen(false);
                setSelectedAdminId('');
                setSelectedPermissionLevel('view');
                setAdminSearch('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleGrantPermission}
              disabled={!selectedAdminId || granting}
            >
              {granting ? 'Granting...' : 'Grant Permission'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Revoke Confirmation */}
      <ConfirmModal
        isOpen={!!revokePermission}
        onClose={() => setRevokePermission(null)}
        onConfirm={handleRevokePermission}
        title="Revoke Permission"
        message={`Are you sure you want to revoke "${revokePermission?.admin?.email}"'s access to this calendar?`}
        confirmText="Revoke"
        confirmVariant="danger"
      />
    </div>
  );
}
