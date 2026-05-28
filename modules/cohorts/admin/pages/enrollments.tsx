import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  MagnifyingGlassIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  createColumnHelper,
  SortingState,
  ColumnFiltersState,
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
  Input,
  Badge,
} from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { CohortService, CohortEnrollment } from '../lib';

const PAGE_SIZE = 50;

const columnHelper = createColumnHelper<CohortEnrollment>();

export default function CohortsEnrollments() {
  const [searchParams] = useSearchParams();
  const [enrollments, setEnrollments] = useState<CohortEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  useEffect(() => {
    loadEnrollments();
  }, []);

  const loadEnrollments = async () => {
    setLoading(true);
    try {
      const statusFilter = searchParams.get('status');
      const { data, error } = await CohortService.getEnrollments({
        payment_status: statusFilter || undefined,
      });
      if (error) throw error;
      setEnrollments(data);
    } catch (error: any) {
      console.error('Error loading enrollments:', error);
      toast.error('Failed to load enrollments');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      completed: { color: 'success' as const, label: 'Completed', icon: CheckCircleIcon },
      pending: { color: 'warning' as const, label: 'Pending', icon: ClockIcon },
      failed: { color: 'danger' as const, label: 'Failed', icon: XCircleIcon },
      refunded: { color: 'secondary' as const, label: 'Refunded', icon: XCircleIcon },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.color} className="flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('customer_name', {
        header: 'Student Name',
        cell: (info) => (
          <div>
            <div className="font-medium">{info.getValue() || '-'}</div>
            <div className="text-sm text-[var(--gray-11)]">
              {info.row.original.customer_email}
            </div>
          </div>
        ),
      }),
      columnHelper.accessor('cohort_title', {
        header: 'Cohort',
        cell: (info) => (
          <div>
            <div className="font-medium">{info.getValue() || '-'}</div>
            <div className="text-sm text-[var(--gray-11)]">
              ID: {info.row.original.cohort_id}
            </div>
          </div>
        ),
      }),
      columnHelper.accessor('instructor_name', {
        header: 'Instructor',
        cell: (info) => info.getValue() || '-',
      }),
      columnHelper.accessor('customer_company', {
        header: 'Company',
        cell: (info) => info.getValue() || '-',
      }),
      columnHelper.accessor('amount_cents', {
        header: 'Amount',
        cell: (info) => formatCurrency(info.getValue()),
      }),
      columnHelper.accessor('payment_status', {
        header: 'Status',
        cell: (info) => getStatusBadge(info.getValue()),
      }),
      columnHelper.accessor('created_at', {
        header: 'Enrolled',
        cell: (info) => formatDate(info.getValue()),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: enrollments,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
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
    <Page title="Cohort Enrollments">
      <Card className="p-6">
        {/* Header with Search and Actions */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4 flex-1">
            <div className="relative flex-1 max-w-md">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-[var(--gray-a8)]" />
              <Input
                type="text"
                placeholder="Search enrollments..."
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={loadEnrollments}
              disabled={loading}
              className="flex items-center gap-2"
            >
              <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats Summary */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="p-4 bg-[var(--gray-a3)] rounded-lg">
            <div className="text-sm text-[var(--gray-11)]">Total</div>
            <div className="text-2xl font-bold">{enrollments.length}</div>
          </div>
          <div className="p-4 bg-[var(--green-a3)] rounded-lg">
            <div className="text-sm text-[var(--gray-11)]">Completed</div>
            <div className="text-2xl font-bold text-[var(--green-9)]">
              {enrollments.filter((e) => e.payment_status === 'completed').length}
            </div>
          </div>
          <div className="p-4 bg-[var(--amber-a3)] rounded-lg">
            <div className="text-sm text-[var(--gray-11)]">Pending</div>
            <div className="text-2xl font-bold text-[var(--amber-9)]">
              {enrollments.filter((e) => e.payment_status === 'pending').length}
            </div>
          </div>
          <div className="p-4 bg-[var(--accent-a3)] rounded-lg">
            <div className="text-sm text-[var(--gray-11)]">Revenue</div>
            <div className="text-2xl font-bold text-[var(--accent-9)]">
              {formatCurrency(
                enrollments
                  .filter((e) => e.payment_status === 'completed')
                  .reduce((sum, e) => sum + e.amount_cents, 0)
              )}
            </div>
          </div>
        </div>

        {/* Table */}
        <DataTable table={table} loading={loading} />

        {/* Pagination */}
        {!loading && table.getRowModel().rows.length > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <div className="text-sm text-[var(--gray-11)]">
              Showing {table.getRowModel().rows.length} of {enrollments.length} enrollments
            </div>
            <Pagination>
              <PaginationFirst
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              />
              <PaginationPrevious
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              />
              <PaginationItems>
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </PaginationItems>
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
        )}
      </Card>
    </Page>
  );
}
