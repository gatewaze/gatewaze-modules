import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  NewspaperIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
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
} from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';

const PAGE_SIZE = 25;

interface Newsletter {
  id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  date: string;
  published: boolean;
  created_at: string;
  updated_at: string;
}

// Helper function to format date
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Helper function to format time ago
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

const columnHelper = createColumnHelper<Newsletter>();

export function EditionsTab() {
  const [newsletters, setNewsletters] = useState<Newsletter[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'date', desc: true }
  ]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const loadNewsletters = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('newsletters')
        .select('*')
        .order('date', { ascending: false });

      if (error) throw error;
      setNewsletters(data || []);

      // Get the most recent updated_at as last synced time
      if (data && data.length > 0) {
        const mostRecent = data.reduce((latest, item) => {
          return new Date(item.updated_at) > new Date(latest.updated_at) ? item : latest;
        });
        setLastSyncedAt(mostRecent.updated_at);
      }
    } catch (error) {
      console.error('Error loading newsletters:', error);
      toast.error('Failed to load newsletters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNewsletters();
  }, [loadNewsletters]);

  const handleSync = async () => {
    try {
      setSyncing(true);
      toast.info('Syncing newsletters from Google Sheets...');

      const { url } = getSupabaseConfig();
      const response = await fetch(`${url}/functions/v1/sync-newsletters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Sync failed');
      }

      const result = await response.json();
      toast.success(`Synced ${result.count} newsletters successfully`);
      await loadNewsletters();
    } catch (error) {
      console.error('Error syncing newsletters:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to sync newsletters');
    } finally {
      setSyncing(false);
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('date', {
        header: 'Date',
        cell: (info) => (
          <div className="text-sm font-medium text-[var(--gray-12)] whitespace-nowrap">
            {formatDate(info.getValue())}
          </div>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Title',
        cell: (info) => {
          const newsletter = info.row.original;
          return (
            <div className="flex items-start gap-3 max-w-md">
              {newsletter.image_url && (
                <img
                  src={newsletter.image_url}
                  alt=""
                  className="w-12 h-12 rounded object-cover flex-shrink-0"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--gray-12)] line-clamp-2">
                  {info.getValue()}
                </div>
                {newsletter.description && (
                  <div className="text-xs text-[var(--gray-11)] line-clamp-2 mt-1">
                    {newsletter.description}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('url', {
        header: 'Link',
        cell: (info) => (
          <a
            href={info.getValue()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-[var(--accent-9)] hover:text-[var(--accent-11)]"
          >
            Open
            <ArrowTopRightOnSquareIcon className="size-4" />
          </a>
        ),
      }),
      columnHelper.accessor('published', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'success' : 'neutral'}>
            {info.getValue() ? 'Published' : 'Draft'}
          </Badge>
        ),
      }),
      columnHelper.accessor('updated_at', {
        header: 'Last Updated',
        cell: (info) => (
          <div
            className="text-sm text-[var(--gray-11)] cursor-help whitespace-nowrap"
            title={new Date(info.getValue()).toLocaleString()}
          >
            {timeAgo(info.getValue())}
          </div>
        ),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: newsletters,
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

  const publishedCount = newsletters.filter(n => n.published).length;

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="flex justify-between items-center">
        <div className="text-sm text-[var(--gray-11)]">
          Newsletter editions synced from Google Sheets
        </div>
        <div className="flex gap-3 items-center">
          {lastSyncedAt && (
            <span className="text-sm text-[var(--gray-11)]">
              Last synced: {timeAgo(lastSyncedAt)}
            </span>
          )}
          <Button
            onClick={loadNewsletters}
            variant="outlined"
            className="gap-2"
            disabled={loading}
          >
            <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            onClick={handleSync}
            className="gap-2"
            disabled={syncing}
          >
            <ArrowPathIcon className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from Google Sheets'}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card variant="surface" className="p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--accent-a3)] rounded-lg">
              <NewspaperIcon className="size-6 text-[var(--accent-9)]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--gray-11)]">Total Editions</div>
              <div className="text-2xl font-bold mt-1">{newsletters.length}</div>
            </div>
          </div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--green-a3)] rounded-lg">
              <NewspaperIcon className="size-6 text-[var(--green-9)]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--gray-11)]">Published</div>
              <div className="text-2xl font-bold mt-1">{publishedCount}</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Search */}
      <Card variant="surface" className="p-4">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-[var(--gray-a8)]" />
          <input
            type="text"
            placeholder="Search newsletters..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-[var(--color-background)] border border-[var(--gray-a6)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-9)] text-[var(--gray-12)]"
          />
        </div>
      </Card>

      {/* Newsletters Table */}
      <Card className="overflow-hidden">
        <DataTable table={table} loading={loading} />

        {/* Pagination */}
        {!loading && table.getRowModel().rows.length > 0 && (
          <div className="px-6 py-4 border-t border-[var(--gray-a5)]">
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
  );
}
