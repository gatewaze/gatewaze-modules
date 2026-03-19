import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  CalendarDaysIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  EyeIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  UsersIcon,
  CalendarIcon,
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
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
  Badge,
  Modal,
  Input,
  Select,
  ConfirmModal,
} from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { CalendarService, Calendar, CreateCalendarInput } from '../services/calendarService';
import { useAuthContext } from '@/app/contexts/auth/context';
import { useForm } from 'react-hook-form';

const PAGE_SIZE = 25;

function timeAgo(dateString: string | undefined): string {
  if (!dateString) return '-';

  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
  };

  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}

function formatTimestamp(dateString: string | undefined): string {
  if (!dateString) return 'No timestamp';

  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

const columnHelper = createColumnHelper<Calendar>();

const visibilityOptions = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
];

interface CalendarFormData {
  name: string;
  description: string;
  visibility: 'public' | 'private' | 'unlisted';
  color: string;
  lumaCalendarId: string;
  externalUrl: string;
}

export default function CalendarsPage() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'createdAt', desc: true }
  ]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCalendar, setEditingCalendar] = useState<Calendar | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteCalendar, setDeleteCalendar] = useState<Calendar | null>(null);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<CalendarFormData>({
    defaultValues: {
      visibility: 'private',
      color: '#3B82F6',
    },
  });

  const loadCalendars = async () => {
    try {
      setLoading(true);
      const result = await CalendarService.getCalendars({ isActive: true });

      if (result.success && result.data) {
        setCalendars(result.data.calendars);
      } else {
        toast.error(result.error || 'Failed to load calendars');
      }
    } catch (error) {
      console.error('Error loading calendars:', error);
      toast.error('Failed to load calendars');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCalendars();
  }, []);

  const handleOpenModal = (calendar?: Calendar) => {
    if (calendar) {
      setEditingCalendar(calendar);
      reset({
        name: calendar.name,
        description: calendar.description || '',
        visibility: calendar.visibility,
        color: calendar.color || '#3B82F6',
        lumaCalendarId: calendar.lumaCalendarId || '',
        externalUrl: calendar.externalUrl || '',
      });
    } else {
      setEditingCalendar(null);
      reset({
        name: '',
        description: '',
        visibility: 'private',
        color: '#3B82F6',
        lumaCalendarId: '',
        externalUrl: '',
      });
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingCalendar(null);
    reset();
  };

  const onSubmit = async (data: CalendarFormData) => {
    try {
      setSubmitting(true);

      if (editingCalendar) {
        const result = await CalendarService.updateCalendar(editingCalendar.id, {
          name: data.name,
          description: data.description || undefined,
          visibility: data.visibility,
          color: data.color || undefined,
          lumaCalendarId: data.lumaCalendarId || undefined,
          externalUrl: data.externalUrl || undefined,
        });

        if (result.success) {
          toast.success('Calendar updated successfully');
          handleCloseModal();
          loadCalendars();
        } else {
          toast.error(result.error || 'Failed to update calendar');
        }
      } else {
        const input: CreateCalendarInput = {
          name: data.name,
          description: data.description || undefined,
          visibility: data.visibility,
          color: data.color || undefined,
          lumaCalendarId: data.lumaCalendarId || undefined,
          externalUrl: data.externalUrl || undefined,
          createdByAdminId: user?.id,
        };

        const result = await CalendarService.createCalendar(input);

        if (result.success) {
          toast.success('Calendar created successfully');
          handleCloseModal();
          loadCalendars();
        } else {
          toast.error(result.error || 'Failed to create calendar');
        }
      }
    } catch (error) {
      console.error('Error saving calendar:', error);
      toast.error('Failed to save calendar');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteCalendar) return;

    try {
      const result = await CalendarService.deleteCalendar(deleteCalendar.id);

      if (result.success) {
        toast.success('Calendar deleted successfully');
        setDeleteCalendar(null);
        loadCalendars();
      } else {
        toast.error(result.error || 'Failed to delete calendar');
      }
    } catch (error) {
      console.error('Error deleting calendar:', error);
      toast.error('Failed to delete calendar');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => {
          const calendar = info.row.original;
          return (
            <div className="flex items-center gap-3">
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: calendar.color || '#3B82F6' }}
              />
              <div>
                <div className="font-medium">
                  {info.getValue()}
                </div>
                {calendar.description && (
                  <div className="text-xs text-[var(--gray-a8)] max-w-xs truncate">
                    {calendar.description}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('calendarId', {
        header: 'ID',
        cell: (info) => (
          <span className="font-mono text-[var(--gray-a8)]">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('eventCount', {
        header: 'Events',
        cell: (info) => (
          <div className="flex items-center gap-1">
            <CalendarIcon className="size-4 text-[var(--gray-a8)]" />
            <span>{info.getValue() ?? 0}</span>
          </div>
        ),
      }),
      columnHelper.accessor('memberCount', {
        header: 'People',
        cell: (info) => (
          <div className="flex items-center gap-1">
            <UsersIcon className="size-4 text-[var(--gray-a8)]" />
            <span>{info.getValue() ?? 0}</span>
          </div>
        ),
      }),
      columnHelper.accessor('visibility', {
        header: 'Visibility',
        cell: (info) => (
          <Badge
            color={
              info.getValue() === 'public' ? 'success' :
              info.getValue() === 'unlisted' ? 'warning' : 'neutral'
            }
          >
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.accessor('isActive', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'success' : 'neutral'}>
            {info.getValue() ? 'Active' : 'Inactive'}
          </Badge>
        ),
      }),
      columnHelper.accessor('createdAt', {
        header: 'Created',
        cell: (info) => (
          <span
            className="text-[var(--gray-a8)] cursor-help whitespace-nowrap"
            title={formatTimestamp(info.getValue())}
          >
            {timeAgo(info.getValue())}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 50,
        cell: (info) => {
          const calendar = info.row.original;
          return (
            <RowActions
              actions={[
                {
                  label: 'View',
                  icon: <EyeIcon className="size-4" />,
                  onClick: () => navigate(`/calendars/${calendar.calendarId}`),
                },
                {
                  label: 'Edit',
                  icon: <PencilIcon className="size-4" />,
                  onClick: () => handleOpenModal(calendar),
                },
                {
                  label: 'Delete',
                  icon: <TrashIcon className="size-4" />,
                  onClick: () => setDeleteCalendar(calendar),
                  color: 'red',
                },
              ]}
            />
          );
        },
      }),
    ],
    [navigate]
  );

  const table = useReactTable({
    data: calendars,
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

  const totalMembers = calendars.reduce((sum, c) => sum + (c.memberCount || 0), 0);
  const totalEvents = calendars.reduce((sum, c) => sum + (c.eventCount || 0), 0);

  return (
    <Page title="Calendars">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Calendars
            </h1>
            <p className="text-[var(--gray-a8)] mt-1">
              Manage calendars and their event collections
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <Button
              onClick={loadCalendars}
              variant="outlined"
              className="gap-2"
              disabled={loading}
            >
              <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={() => handleOpenModal()}
              className="gap-2"
            >
              <PlusIcon className="size-4" />
              New Calendar
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--blue-a3)] rounded-lg">
                <CalendarDaysIcon className="size-6 text-[var(--blue-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Total Calendars</div>
                <div className="text-2xl font-bold mt-1">{calendars.length}</div>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--green-a3)] rounded-lg">
                <CalendarIcon className="size-6 text-[var(--green-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Total Events</div>
                <div className="text-2xl font-bold mt-1">{totalEvents.toLocaleString()}</div>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-[var(--purple-a3)] rounded-lg">
                <UsersIcon className="size-6 text-[var(--purple-9)]" />
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--gray-a8)]">Total Members</div>
                <div className="text-2xl font-bold mt-1">{totalMembers.toLocaleString()}</div>
              </div>
            </div>
          </Card>
        </div>

        {/* Search */}
        <Card className="p-4">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-[var(--gray-a8)]" />
            <Input
              placeholder="Search calendars..."
              value={globalFilter ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGlobalFilter(e.target.value)}
              className="pl-10"
            />
          </div>
        </Card>

        {/* Calendars Table */}
        <Card className="overflow-hidden">
          <DataTable
            table={table}
            loading={loading}
            onRowDoubleClick={(calendar) => navigate(`/calendars/${calendar.slug || calendar.calendar_id}`)}
            emptyState={
              <div>
                <CalendarDaysIcon className="mx-auto h-12 w-12 text-[var(--gray-a6)]" />
                <h3 className="mt-2 text-sm font-medium">No calendars found</h3>
                <p className="mt-1 text-sm text-[var(--gray-a8)]">
                  {globalFilter ? 'Try adjusting your search.' : 'Get started by creating a new calendar.'}
                </p>
                {!globalFilter && (
                  <Button
                    onClick={() => handleOpenModal()}
                    className="mt-4 gap-2"
                  >
                    <PlusIcon className="size-4" />
                    New Calendar
                  </Button>
                )}
              </div>
            }
          />

          {/* Pagination */}
          {!loading && table.getRowModel().rows.length > 0 && (
            <div className="px-6 py-4 border-t border-[var(--gray-a6)]">
              <div className="flex items-center justify-between">
                <div className="text-sm text-[var(--gray-11)]">
                  Showing{' '}
                  <span className="font-medium">
                    {table.getState().pagination.pageIndex * PAGE_SIZE + 1}
                  </span>{' '}
                  to{' '}
                  <span className="font-medium">
                    {Math.min(
                      (table.getState().pagination.pageIndex + 1) * PAGE_SIZE,
                      table.getFilteredRowModel().rows.length
                    )}
                  </span>{' '}
                  of{' '}
                  <span className="font-medium">
                    {table.getFilteredRowModel().rows.length}
                  </span>{' '}
                  results
                </div>
                <Pagination
                  total={table.getPageCount()}
                  value={table.getState().pagination.pageIndex + 1}
                  onChange={(page) => table.setPageIndex(page - 1)}
                >
                  <PaginationFirst
                    onClick={() => table.setPageIndex(0)}
                    disabled={!table.getCanPreviousPage()}
                  />
                  <PaginationPrevious
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                  />
                  <PaginationItems />
                  <PaginationNext
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                  />
                  <PaginationLast
                    onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                    disabled={!table.getCanNextPage()}
                  />
                </Pagination>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingCalendar ? 'Edit Calendar' : 'Create New Calendar'}
        footer={
          <div className="flex gap-3 justify-end">
            <Button
              type="button"
              variant="outlined"
              onClick={handleCloseModal}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit(onSubmit)}
              disabled={submitting}
            >
              {submitting ? 'Saving...' : editingCalendar ? 'Update' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="Enter calendar name"
            {...register('name', { required: 'Name is required' })}
            error={errors.name?.message}
          />

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Description
            </label>
            <textarea
              {...register('description')}
              rows={3}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)] placeholder:text-[var(--gray-a8)]"
              placeholder="Optional description"
            />
          </div>

          <Select
            label="Visibility"
            {...register('visibility')}
            data={visibilityOptions}
          />

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Color
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="color"
                {...register('color')}
                className="w-10 h-10 rounded cursor-pointer"
              />
              <Input
                {...register('color')}
                placeholder="#3B82F6"
                className="flex-1"
              />
            </div>
          </div>

          <Input
            label="Luma Calendar ID"
            placeholder="cal-xxx (optional)"
            {...register('lumaCalendarId')}
          />

          <Input
            label="External URL"
            placeholder="https://... (optional)"
            {...register('externalUrl')}
          />
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={!!deleteCalendar}
        onClose={() => setDeleteCalendar(null)}
        onConfirm={handleDelete}
        title="Delete Calendar"
        message={`Are you sure you want to delete "${deleteCalendar?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmVariant="danger"
      />
    </Page>
  );
}
