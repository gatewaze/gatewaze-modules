import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  FunnelIcon,
  PlusIcon,
  UserGroupIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  PencilIcon,
  TrashIcon,
  EyeIcon,
  DocumentDuplicateIcon,
  ArrowDownTrayIcon,
  ClockIcon,
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
  ConfirmModal,
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import { Input } from '@/components/ui/Form';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';
import { createSegmentService } from '@/lib/segments';
import type { Segment, SegmentStatus, SegmentType } from '@/lib/segments';

const PAGE_SIZE = 20;

const columnHelper = createColumnHelper<Segment>();

function formatTimeAgo(dateString: string | undefined): string {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  const intervals: Record<string, number> = {
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

  return 'Just now';
}

function getStatusBadge(status: SegmentStatus) {
  const colorMap: Record<SegmentStatus, 'success' | 'warning' | 'neutral'> = {
    active: 'success',
    inactive: 'warning',
    archived: 'neutral',
  };
  return (
    <Badge variant="soft" color={colorMap[status]}>
      {status}
    </Badge>
  );
}

function getTypeBadge(type: SegmentType) {
  const colorMap: Record<SegmentType, 'info' | 'primary' | 'secondary'> = {
    dynamic: 'info',
    static: 'primary',
    manual: 'secondary',
  };
  const labels: Record<SegmentType, string> = {
    dynamic: 'Dynamic',
    static: 'Static',
    manual: 'Manual',
  };
  return (
    <Badge variant="outlined" color={colorMap[type]}>
      {labels[type]}
    </Badge>
  );
}

export default function SegmentsPage() {
  const navigate = useNavigate();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalSegments, setTotalSegments] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'created_at', desc: true },
  ]);
  const [recalculatingId, setRecalculatingId] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const segmentService = useMemo(
    () => (supabase ? createSegmentService(supabase) : null),
    []
  );

  const loadSegments = async () => {
    if (!segmentService) return;

    try {
      setLoading(true);
      const result = await segmentService.listSegments({
        page: currentPage,
        page_size: PAGE_SIZE,
        search: globalFilter || undefined,
        status: 'active',
      });
      setSegments(result.data);
      setTotalSegments(result.total);
    } catch (error) {
      console.error('Error loading segments:', error);
      toast.error('Failed to load segments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSegments();
  }, [currentPage, globalFilter, segmentService]);

  const handleRecalculate = async (segment: Segment) => {
    if (!segmentService) return;

    setRecalculatingId(segment.id);
    try {
      await segmentService.recalculateSegment(segment.id);
      toast.success(`Segment "${segment.name}" recalculated`);
      loadSegments();
    } catch (error) {
      console.error('Error recalculating segment:', error);
      toast.error('Failed to recalculate segment');
    } finally {
      setRecalculatingId(null);
    }
  };

  const handleDuplicate = async (segment: Segment) => {
    if (!segmentService) return;

    try {
      const newSegment = await segmentService.duplicateSegment(segment.id);
      toast.success(`Segment duplicated as "${newSegment.name}"`);
      loadSegments();
    } catch (error) {
      console.error('Error duplicating segment:', error);
      toast.error('Failed to duplicate segment');
    }
  };

  const handleDelete = (segment: Segment) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Segment',
      message: `Are you sure you want to delete "${segment.name}"? This action cannot be undone.`,
      onConfirm: async () => {
        if (!segmentService) return;

        try {
          await segmentService.deleteSegment(segment.id);
          toast.success(`Segment "${segment.name}" deleted`);
          loadSegments();
        } catch (error) {
          console.error('Error deleting segment:', error);
          toast.error('Failed to delete segment');
        }
      },
    });
  };

  const handleExport = async (segment: Segment) => {
    if (!segmentService) return;

    try {
      toast.loading('Exporting segment...', { id: 'export' });
      const blob = await segmentService.exportSegmentBlob(segment.id);

      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute(
        'download',
        `segment-${segment.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.csv`
      );
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast.success('Segment exported successfully', { id: 'export' });
    } catch (error) {
      console.error('Error exporting segment:', error);
      toast.error('Failed to export segment', { id: 'export' });
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => (
          <div className="min-w-[200px]">
            <div className="font-medium text-[var(--gray-12)]">
              {info.getValue()}
            </div>
            {info.row.original.description && (
              <div className="text-sm text-[var(--gray-11)] truncate max-w-xs">
                {info.row.original.description}
              </div>
            )}
          </div>
        ),
      }),
      columnHelper.accessor('type', {
        header: 'Type',
        cell: (info) => getTypeBadge(info.getValue()),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => getStatusBadge(info.getValue()),
      }),
      columnHelper.accessor('cached_count', {
        header: 'People',
        cell: (info) => (
          <div className="flex items-center gap-2">
            <UserGroupIcon className="size-4 text-[var(--gray-a8)]" />
            <span className="font-medium tabular-nums">
              {(info.getValue() || 0).toLocaleString()}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('last_calculated_at', {
        header: 'Last Updated',
        cell: (info) => (
          <div
            className="text-sm text-[var(--gray-11)] flex items-center gap-1"
            title={info.getValue() ? new Date(info.getValue()!).toLocaleString() : 'Never'}
          >
            <ClockIcon className="size-4" />
            {formatTimeAgo(info.getValue())}
          </div>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => {
          const segment = info.row.original;
          const isRecalculating = recalculatingId === segment.id;

          return (
            <RowActions
              actions={[
                { label: 'View', icon: <EyeIcon className="size-4" />, onClick: () => navigate(`/segments/${segment.id}`) },
                { label: 'Edit', icon: <PencilIcon className="size-4" />, onClick: () => navigate(`/segments/${segment.id}/edit`) },
                { label: 'Recalculate', icon: <ArrowPathIcon className={`size-4 ${isRecalculating ? 'animate-spin' : ''}`} />, onClick: () => handleRecalculate(segment), disabled: isRecalculating },
                { label: 'Duplicate', icon: <DocumentDuplicateIcon className="size-4" />, onClick: () => handleDuplicate(segment) },
                { label: 'Export CSV', icon: <ArrowDownTrayIcon className="size-4" />, onClick: () => handleExport(segment) },
                { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => handleDelete(segment), color: 'red' },
              ]}
            />
          );
        },
      }),
    ],
    [navigate, recalculatingId]
  );

  const table = useReactTable({
    data: segments,
    columns,
    state: {
      sorting,
      globalFilter,
      pagination: {
        pageIndex: currentPage,
        pageSize: PAGE_SIZE,
      },
    },
    pageCount: Math.ceil(totalSegments / PAGE_SIZE),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
  });

  // Calculate stats
  const totalMembers = segments.reduce((sum, s) => sum + (s.cached_count || 0), 0);
  const dynamicCount = segments.filter((s) => s.type === 'dynamic').length;

  return (
    <Page title="Segments">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Customer Segments
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Create and manage audience segments for targeting and analytics
            </p>
          </div>
          <Button
            color="primary"
            onClick={() => navigate('/segments/create')}
            className="gap-2"
          >
            <PlusIcon className="size-4" />
            Create Segment
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <FunnelIcon className="size-5 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm text-[var(--gray-11)]">Total Segments</div>
                <div className="text-xl font-bold">{totalSegments}</div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <UserGroupIcon className="size-5 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm text-[var(--gray-11)]">Total Members</div>
                <div className="text-xl font-bold">{totalMembers.toLocaleString()}</div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-4">
            <div className="flex items-center gap-3">
              <ArrowPathIcon className="size-5 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm text-[var(--gray-11)]">Dynamic Segments</div>
                <div className="text-xl font-bold">{dynamicCount}</div>
              </div>
            </div>
          </Card>
        </div>

        {/* Search */}
        <Card variant="surface" className="p-4">
          <Input
            placeholder="Search segments by name or description..."
            value={globalFilter ?? ''}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setCurrentPage(0);
            }}
            prefix={<MagnifyingGlassIcon className="size-5 text-[var(--gray-a8)]" />}
          />
        </Card>

        {/* Segments Table */}
        <Card className="overflow-hidden">
          <DataTable table={table} loading={loading} onRowDoubleClick={(segment) => navigate(`/segments/${segment.id}`)} />

          {/* Pagination */}
          {!loading && table.getRowModel().rows.length > 0 && (
            <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
              <div className="flex items-center justify-between">
                <div className="text-sm text-[var(--gray-11)]">
                  Showing{' '}
                  <span className="font-medium">
                    {currentPage * PAGE_SIZE + 1}
                  </span>{' '}
                  to{' '}
                  <span className="font-medium">
                    {Math.min((currentPage + 1) * PAGE_SIZE, totalSegments)}
                  </span>{' '}
                  of <span className="font-medium">{totalSegments}</span> segments
                </div>
                <Pagination
                  total={Math.ceil(totalSegments / PAGE_SIZE)}
                  value={currentPage + 1}
                  onChange={(page) => setCurrentPage(page - 1)}
                >
                  <PaginationFirst
                    onClick={() => setCurrentPage(0)}
                    disabled={currentPage === 0}
                  />
                  <PaginationPrevious
                    onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                    disabled={currentPage === 0}
                  />
                  <PaginationItems />
                  <PaginationNext
                    onClick={() =>
                      setCurrentPage((p) =>
                        Math.min(Math.ceil(totalSegments / PAGE_SIZE) - 1, p + 1)
                      )
                    }
                    disabled={currentPage >= Math.ceil(totalSegments / PAGE_SIZE) - 1}
                  />
                  <PaginationLast
                    onClick={() =>
                      setCurrentPage(Math.ceil(totalSegments / PAGE_SIZE) - 1)
                    }
                    disabled={currentPage >= Math.ceil(totalSegments / PAGE_SIZE) - 1}
                  />
                </Pagination>
              </div>
            </div>
          )}
        </Card>

        {/* Delete Confirmation Modal */}
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          onClose={() => setConfirmModal({ ...confirmModal, isOpen: false })}
          onConfirm={() => {
            confirmModal.onConfirm();
            setConfirmModal({ ...confirmModal, isOpen: false });
          }}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText="Delete"
          confirmColor="red"
        />
      </div>
    </Page>
  );
}
