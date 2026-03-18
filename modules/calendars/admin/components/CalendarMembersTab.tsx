import { useState, useEffect, useMemo } from 'react';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  flexRender,
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
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { LumaUploadStatus } from '@/components/events/LumaUploadStatus';
import { Calendar } from '@/lib/services/calendarService';
import {
  CalendarMembershipService,
  CalendarMember,
} from '@/lib/services/calendarMembershipService';
import { CalendarCsvService } from '@/lib/services/calendarCsvService';
import { useAuthContext } from '@/app/contexts/auth/context';
import { getBrandId } from '@/utils/brandUtils';

interface CalendarMembersTabProps {
  calendar: Calendar;
}

const PAGE_SIZE = 25;

const columnHelper = createColumnHelper<CalendarMember>();

const membershipTypes = [
  { value: 'subscriber', label: 'Subscriber' },
  { value: 'member', label: 'Member' },
  { value: 'vip', label: 'VIP' },
  { value: 'organizer', label: 'Organizer' },
  { value: 'admin', label: 'Admin' },
];

const membershipStatuses = [
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'blocked', label: 'Blocked' },
];

export function CalendarMembersTab({ calendar }: CalendarMembersTabProps) {
  const { user } = useAuthContext();
  const [members, setMembers] = useState<CalendarMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'joinedAt', desc: true }
  ]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [removeMember, setRemoveMember] = useState<CalendarMember | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [uploadKey, setUploadKey] = useState(0); // To refresh LumaUploadStatus after new upload

  // Add member form state
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberType, setNewMemberType] = useState('subscriber');

  useEffect(() => {
    loadMembers();
  }, [calendar.id]);

  const loadMembers = async () => {
    setLoading(true);
    try {
      const result = await CalendarMembershipService.getCalendarMembers(calendar.id);
      if (result.success && result.data) {
        setMembers(result.data.members);
      }
    } catch (error) {
      console.error('Error loading members:', error);
      toast.error('Failed to load people');
    } finally {
      setLoading(false);
    }
  };

  const handleAddMember = async () => {
    if (!newMemberEmail.trim()) {
      toast.error('Email is required');
      return;
    }

    setAddingMember(true);
    try {
      const result = await CalendarMembershipService.addMember({
        calendarId: calendar.id,
        email: newMemberEmail.trim(),
        membershipType: newMemberType as any,
        importSource: 'manual',
      });

      if (result.success) {
        toast.success('Person added successfully');
        setIsAddModalOpen(false);
        setNewMemberEmail('');
        setNewMemberType('subscriber');
        loadMembers();
      } else {
        toast.error(result.error || 'Failed to add person');
      }
    } catch (error) {
      toast.error('Failed to add person');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!removeMember) return;

    try {
      const result = await CalendarMembershipService.removeMember(removeMember.id);

      if (result.success) {
        toast.success('Person removed');
        setRemoveMember(null);
        loadMembers();
      } else {
        toast.error(result.error || 'Failed to remove person');
      }
    } catch (error) {
      toast.error('Failed to remove person');
    }
  };

  const handleImportCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!user?.id) {
      toast.error('You must be logged in to import people');
      return;
    }

    try {
      // Upload for background processing
      const { uploadId, rowCount } = await CalendarCsvService.uploadForBackgroundProcessing(
        file,
        calendar.id,
        user.id
      );

      toast.success(`Started processing ${rowCount} people in background`);
      setIsImportModalOpen(false);

      // Refresh the upload status component
      setUploadKey(prev => prev + 1);
    } catch (error) {
      console.error('Import error:', error);
      toast.error('Failed to upload CSV');
    } finally {
      event.target.value = '';
    }
  };

  const handleExportCsv = async () => {
    try {
      const csv = await CalendarCsvService.exportMembersCsv(calendar.id);

      // Download the CSV
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${calendar.name.replace(/\s+/g, '_')}_members.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('Export downloaded');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export people');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('email', {
        header: 'Email',
        cell: (info) => {
          const member = info.row.original;
          const email = info.getValue() || member.customer?.email;
          return (
            <div>
              <div className="font-medium text-gray-900 dark:text-white">
                {email}
              </div>
              {member.customer && (member.customer.firstName || member.customer.lastName) && (
                <div className="text-xs text-gray-500">
                  {[member.customer.firstName, member.customer.lastName].filter(Boolean).join(' ')}
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('membershipType', {
        header: 'Type',
        cell: (info) => (
          <Badge
            color={
              info.getValue() === 'admin' ? 'error' :
              info.getValue() === 'vip' ? 'warning' :
              info.getValue() === 'organizer' ? 'success' : 'neutral'
            }
            className="capitalize"
          >
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('membershipStatus', {
        header: 'Status',
        cell: (info) => (
          <Badge
            color={
              info.getValue() === 'active' ? 'success' :
              info.getValue() === 'pending' ? 'warning' :
              info.getValue() === 'blocked' ? 'error' : 'neutral'
            }
            className="capitalize"
          >
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('importSource', {
        header: 'Source',
        cell: (info) => (
          <span className="text-sm text-gray-500 capitalize">
            {info.getValue()?.replace(/_/g, ' ') || 'Unknown'}
          </span>
        ),
      }),
      columnHelper.accessor('joinedAt', {
        header: 'Joined',
        cell: (info) => {
          const dateStr = info.getValue();
          if (!dateStr) return '-';
          return new Date(dateStr).toLocaleDateString();
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => (
          <button
            onClick={() => setRemoveMember(info.row.original)}
            className="p-1 text-red-600 hover:text-red-800"
            title="Remove person"
          >
            <TrashIcon className="size-5" />
          </button>
        ),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: members,
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
          <h2 className="text-lg font-semibold">People</h2>
          <p className="text-sm text-gray-500">
            Manage calendar people and subscriptions
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={loadMembers}
            variant="outlined"
            className="gap-2"
            disabled={loading}
          >
            <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            onClick={handleExportCsv}
            variant="outlined"
            className="gap-2"
          >
            <ArrowDownTrayIcon className="size-4" />
            Export
          </Button>
          <Button
            onClick={() => setIsImportModalOpen(true)}
            variant="outlined"
            className="gap-2"
          >
            <ArrowUpTrayIcon className="size-4" />
            Import CSV
          </Button>
          <Button onClick={() => setIsAddModalOpen(true)} className="gap-2">
            <PlusIcon className="size-4" />
            Add Person
          </Button>
        </div>
      </div>

      {/* Upload Status */}
      <LumaUploadStatus
        key={uploadKey}
        brandId={getBrandId()}
        calendarId={calendar.id}
      />

      {/* Search */}
      <Card skin="shadow" className="p-4">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-neutral-400" />
          <input
            type="text"
            placeholder="Search people..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </Card>

      {/* Members Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-6 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider"
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={`flex items-center gap-2 ${
                            header.column.getCanSort() ? 'cursor-pointer select-none' : ''
                          }`}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() && (
                            <span className="flex flex-col">
                              <ChevronUpIcon
                                className={`size-3 ${
                                  header.column.getIsSorted() === 'asc' ? 'text-blue-600' : 'text-gray-400'
                                }`}
                              />
                              <ChevronDownIcon
                                className={`size-3 -mt-1 ${
                                  header.column.getIsSorted() === 'desc' ? 'text-blue-600' : 'text-gray-400'
                                }`}
                              />
                            </span>
                          )}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="text-center py-12">
                    <LoadingSpinner size="medium" />
                  </td>
                </tr>
              ) : table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12">
                    <p className="text-gray-500">No people yet</p>
                    <Button onClick={() => setIsAddModalOpen(true)} className="mt-4 gap-2">
                      <PlusIcon className="size-4" />
                      Add Person
                    </Button>
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-6 py-4">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && table.getRowModel().rows.length > 0 && (
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                Showing {table.getState().pagination.pageIndex * PAGE_SIZE + 1} to{' '}
                {Math.min(
                  (table.getState().pagination.pageIndex + 1) * PAGE_SIZE,
                  table.getFilteredRowModel().rows.length
                )}{' '}
                of {table.getFilteredRowModel().rows.length}
              </div>
              <Pagination
                total={table.getPageCount()}
                value={table.getState().pagination.pageIndex + 1}
                onChange={(page) => table.setPageIndex(page - 1)}
              >
                <PaginationFirst onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} />
                <PaginationPrevious onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} />
                <PaginationItems />
                <PaginationNext onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} />
                <PaginationLast onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()} />
              </Pagination>
            </div>
          </div>
        )}
      </Card>

      {/* Add Person Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Add Person"
      >
        <div className="space-y-4">
          <Input
            label="Email"
            type="email"
            value={newMemberEmail}
            onChange={(e) => setNewMemberEmail(e.target.value)}
            placeholder="person@example.com"
          />

          <Select
            label="Membership Type"
            value={newMemberType}
            onChange={(e) => setNewMemberType(e.target.value)}
            options={membershipTypes}
          />

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="outlined" onClick={() => setIsAddModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddMember} disabled={addingMember}>
              {addingMember ? 'Adding...' : 'Add Person'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Import CSV Modal */}
      <Modal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Import People from CSV"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Upload a CSV file with people data. The file can be in standard format (email, first_name, last_name)
            or Luma calendar members format. Processing happens in the background.
          </p>

          <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-6 text-center">
            <input
              type="file"
              accept=".csv"
              onChange={handleImportCsv}
              className="hidden"
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              className="cursor-pointer"
            >
              <ArrowUpTrayIcon className="size-8 mx-auto text-gray-400 mb-2" />
              <p className="text-sm text-gray-500">
                Click to upload or drag and drop
              </p>
              <p className="text-xs text-gray-400 mt-1">
                CSV files only
              </p>
            </label>
          </div>

          <div className="text-xs text-gray-400">
            <p className="font-medium mb-1">Supported formats:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Standard: email, first_name, last_name, membership_type</li>
              <li>Luma: name, email, user_api_id, first_seen, tags, revenue...</li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* Remove Confirmation */}
      <ConfirmModal
        isOpen={!!removeMember}
        onClose={() => setRemoveMember(null)}
        onConfirm={handleRemoveMember}
        title="Remove Person"
        message={`Are you sure you want to remove "${removeMember?.email || removeMember?.customer?.email}" from this calendar?`}
        confirmText="Remove"
        confirmVariant="danger"
      />
    </div>
  );
}
