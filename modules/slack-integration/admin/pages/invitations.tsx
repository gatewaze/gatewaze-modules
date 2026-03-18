import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  EnvelopeIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { getApiConfig } from '@/config/brands';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
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
} from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';

const PAGE_SIZE = 50;

interface SlackInvitation {
  id: number;
  email: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  invited_at: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

interface QueueStats {
  account: string;
  total_requests: number;
  pending_count: number;
  completed_count: number;
  failed_count: number;
  last_invitation_at: string | null;
}

const columnHelper = createColumnHelper<SlackInvitation>();

function formatDate(dateString: string | null): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }: { status: SlackInvitation['status'] }) {
  const config = {
    pending: { color: 'info' as const, icon: ClockIcon, label: 'Pending' },
    processing: { color: 'warning' as const, icon: ArrowPathIcon, label: 'Processing' },
    completed: { color: 'success' as const, icon: CheckCircleIcon, label: 'Completed' },
    failed: { color: 'error' as const, icon: XCircleIcon, label: 'Failed' },
  };

  const { color, icon: Icon, label } = config[status];

  return (
    <Badge variant="soft" color={color} className="inline-flex items-center gap-1.5">
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Badge>
  );
}

export default function SlackInvitationsPage() {
  const navigate = useNavigate();
  const [invitations, setInvitations] = useState<SlackInvitation[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');

  const apiConfig = getApiConfig();
  const apiUrl = apiConfig.baseUrl;

  const fetchData = async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);

    try {
      // Fetch invitations from Supabase
      const { supabase } = await import('@/lib/supabase');

      const { data: invitationsData, error: invitationsError } = await supabase
        .from('integrations_slack_invitation_queue')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (invitationsError) throw invitationsError;
      setInvitations(invitationsData || []);

      // Fetch stats from API
      const statsResponse = await fetch(`${apiUrl}/api/slack/queue-stats`);
      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        if (statsData.success && statsData.stats?.[0]) {
          setStats(statsData.stats[0]);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error('Failed to fetch invitation data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, []);

  const columns = [
    columnHelper.accessor('id', {
      header: 'ID',
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-11)]">
          #{info.getValue()}
        </span>
      ),
      size: 60,
    }),
    columnHelper.accessor('email', {
      header: 'Email',
      cell: (info) => (
        <div className="flex items-center gap-2">
          <EnvelopeIcon className="w-4 h-4 text-[var(--gray-a8)]" />
          <span className="font-medium">{info.getValue()}</span>
        </div>
      ),
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      cell: (info) => <StatusBadge status={info.getValue()} />,
      size: 120,
    }),
    columnHelper.accessor('retry_count', {
      header: 'Retries',
      cell: (info) => {
        const count = info.getValue();
        return count > 0 ? (
          <Badge variant="outlined" color="warning" className="font-mono">
            {count}
          </Badge>
        ) : (
          <span className="text-[var(--gray-a8)] text-sm">-</span>
        );
      },
      size: 80,
    }),
    columnHelper.accessor('created_at', {
      header: 'Requested',
      cell: (info) => (
        <span className="text-sm text-[var(--gray-11)]">
          {formatDate(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor('invited_at', {
      header: 'Completed',
      cell: (info) => (
        <span className="text-sm text-[var(--gray-11)]">
          {formatDate(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor('error_message', {
      header: 'Error',
      cell: (info) => {
        const error = info.getValue();
        return error ? (
          <span className="text-xs text-[var(--red-11)] line-clamp-2" title={error}>
            {error}
          </span>
        ) : (
          <span className="text-[var(--gray-a8)] text-sm">-</span>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: invitations,
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

  if (loading) {
    return (
      <Page>
        <div className="flex items-center justify-center min-h-[400px]">
          <Spinner size="lg" />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Slack Invitations">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Slack Invitations
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Monitor and manage workspace invitation requests
            </p>
          </div>
          <Button
            variant="outlined"
            color="primary"
            onClick={() => fetchData(true)}
            isIcon
            disabled={refreshing}
          >
            <ArrowPathIcon className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="space-y-6">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <Card skin="bordered" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wider">
                    Total
                  </p>
                  <p className="text-3xl font-bold text-[var(--gray-12)] mt-1">
                    {stats.total_requests}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-[var(--accent-a3)] flex items-center justify-center">
                  <ChartBarIcon className="w-6 h-6 text-[var(--accent-9)]" />
                </div>
              </div>
            </Card>

            <Card skin="bordered" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wider">
                    Pending
                  </p>
                  <p className="text-3xl font-bold text-[var(--gray-12)] mt-1">
                    {stats.pending_count}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-[var(--amber-a3)] flex items-center justify-center">
                  <ClockIcon className="w-6 h-6 text-[var(--amber-9)]" />
                </div>
              </div>
            </Card>

            <Card skin="bordered" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wider">
                    Processing
                  </p>
                  <p className="text-3xl font-bold text-[var(--gray-12)] mt-1">
                    {invitations.filter(i => i.status === 'processing').length}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-[var(--orange-a3)] flex items-center justify-center">
                  <ArrowPathIcon className="w-6 h-6 text-[var(--orange-9)] animate-spin" />
                </div>
              </div>
            </Card>

            <Card skin="bordered" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wider">
                    Completed
                  </p>
                  <p className="text-3xl font-bold text-[var(--gray-12)] mt-1">
                    {stats.completed_count}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-[var(--green-a3)] flex items-center justify-center">
                  <CheckCircleIcon className="w-6 h-6 text-[var(--green-9)]" />
                </div>
              </div>
            </Card>

            <Card skin="bordered" className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wider">
                    Failed
                  </p>
                  <p className="text-3xl font-bold text-[var(--gray-12)] mt-1">
                    {stats.failed_count}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-[var(--red-a3)] flex items-center justify-center">
                  <XCircleIcon className="w-6 h-6 text-[var(--red-9)]" />
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* Search */}
        <Card variant="surface" className="p-4">
          <div className="relative">
            <input
              type="text"
              placeholder="Search invitations by email..."
              value={globalFilter ?? ''}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="w-full px-4 py-2 bg-[var(--color-background)] border border-[var(--gray-a6)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-9)] text-[var(--gray-12)]"
            />
          </div>
        </Card>

        {/* Invitations Table */}
        <Card className="overflow-hidden">
          <DataTable table={table} loading={loading} />

          {/* Pagination */}
          {!loading && table.getRowModel().rows.length > 0 && table.getPageCount() > 1 && (
            <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
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
      </div>
    </Page>
  );
}
