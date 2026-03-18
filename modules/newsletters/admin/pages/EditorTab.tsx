import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
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
  Pagination,
  PaginationFirst,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
  PaginationItems,
} from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 25;

interface Edition {
  id: string;
  subject: string | null;
  edition_date: string;
  status: 'draft' | 'ready' | 'sent';
  created_at: string;
  updated_at: string;
  block_count?: number;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function timeAgo(dateString: string): string {
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

const statusColors: Record<Edition['status'], 'neutral' | 'warning' | 'success'> = {
  draft: 'neutral',
  ready: 'warning',
  sent: 'success',
};

const columnHelper = createColumnHelper<Edition>();

export function EditorTab() {
  const navigate = useNavigate();
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'edition_date', desc: true },
  ]);

  const loadEditions = useCallback(async () => {
    try {
      setLoading(true);

      // Load editions with block count
      const { data, error } = await supabase
        .from('newsletters_editions')
        .select(`
          *,
          newsletter_edition_blocks(count)
        `)
        .order('edition_date', { ascending: false });

      if (error) throw error;

      const editionsWithCount = (data || []).map((edition) => ({
        ...edition,
        block_count: edition.newsletter_edition_blocks?.[0]?.count || 0,
      }));

      setEditions(editionsWithCount);
    } catch (error) {
      console.error('Error loading editions:', error);
      toast.error('Failed to load editions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEditions();
  }, [loadEditions]);

  const handleCreateNew = () => {
    navigate('/newsletters/editor/new');
  };

  const handleEdit = (id: string) => {
    navigate(`/newsletters/editor/${id}`);
  };

  const handleDuplicate = async (edition: Edition) => {
    try {
      // Create a copy of the edition
      const { data: newEdition, error: createError } = await supabase
        .from('newsletters_editions')
        .insert({
          subject: edition.subject ? `${edition.subject} (Copy)` : null,
          edition_date: new Date().toISOString().split('T')[0],
          status: 'draft',
        })
        .select()
        .single();

      if (createError) throw createError;

      // Copy blocks
      const { data: blocks, error: blocksError } = await supabase
        .from('newsletters_edition_blocks')
        .select('*')
        .eq('edition_id', edition.id);

      if (blocksError) throw blocksError;

      for (const block of blocks || []) {
        const { data: newBlock, error: blockError } = await supabase
          .from('newsletters_edition_blocks')
          .insert({
            edition_id: newEdition.id,
            block_template_id: block.block_template_id,
            content: block.content,
            sort_order: block.sort_order,
          })
          .select()
          .single();

        if (blockError) throw blockError;

        // Copy bricks
        const { data: bricks, error: bricksError } = await supabase
          .from('newsletters_edition_bricks')
          .select('*')
          .eq('edition_block_id', block.id);

        if (bricksError) throw bricksError;

        for (const brick of bricks || []) {
          const { error: brickError } = await supabase
            .from('newsletters_edition_bricks')
            .insert({
              edition_block_id: newBlock.id,
              brick_template_id: brick.brick_template_id,
              content: brick.content,
              sort_order: brick.sort_order,
            });

          if (brickError) throw brickError;
        }
      }

      toast.success('Edition duplicated successfully');
      loadEditions();
    } catch (error) {
      console.error('Error duplicating edition:', error);
      toast.error('Failed to duplicate edition');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this edition? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('newsletters_editions')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast.success('Edition deleted');
      loadEditions();
    } catch (error) {
      console.error('Error deleting edition:', error);
      toast.error('Failed to delete edition');
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('edition_date', {
        header: 'Date',
        cell: (info) => (
          <div className="text-sm font-medium text-[var(--gray-12)] whitespace-nowrap">
            {formatDate(info.getValue())}
          </div>
        ),
      }),
      columnHelper.accessor('subject', {
        header: 'Subject',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-12)] max-w-md truncate">
            {info.getValue() || <span className="text-[var(--gray-a8)] italic">No subject</span>}
          </div>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <Badge color={statusColors[info.getValue()]}>
            {info.getValue().charAt(0).toUpperCase() + info.getValue().slice(1)}
          </Badge>
        ),
      }),
      columnHelper.accessor('block_count', {
        header: 'Blocks',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)]">
            {info.getValue() || 0}
          </div>
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
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <RowActions
            actions={[
              {
                label: 'Edit',
                icon: <PencilSquareIcon className="size-4" />,
                onClick: () => handleEdit(info.row.original.id),
              },
              {
                label: 'Duplicate',
                icon: <DocumentDuplicateIcon className="size-4" />,
                onClick: () => handleDuplicate(info.row.original),
              },
              {
                label: 'Delete',
                icon: <TrashIcon className="size-4" />,
                onClick: () => handleDelete(info.row.original.id),
                color: 'red',
              },
            ]}
          />
        ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, loadEditions]
  );

  const table = useReactTable({
    data: editions,
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

  const draftCount = editions.filter((e) => e.status === 'draft').length;
  const readyCount = editions.filter((e) => e.status === 'ready').length;

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="flex justify-between items-center">
        <div className="text-sm text-[var(--gray-11)]">
          Build and manage newsletter editions with blocks and bricks
        </div>
        <div className="flex gap-3 items-center">
          <Button
            onClick={loadEditions}
            variant="outlined"
            className="gap-2"
            disabled={loading}
          >
            <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={handleCreateNew} className="gap-2">
            <PlusIcon className="size-4" />
            New Edition
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card variant="surface" className="p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--accent-a3)] rounded-lg">
              <PencilSquareIcon className="size-6 text-[var(--accent-9)]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--gray-11)]">Total Editions</div>
              <div className="text-2xl font-bold mt-1">{editions.length}</div>
            </div>
          </div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--amber-a3)] rounded-lg">
              <PencilSquareIcon className="size-6 text-[var(--amber-9)]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--gray-11)]">Drafts</div>
              <div className="text-2xl font-bold mt-1">{draftCount}</div>
            </div>
          </div>
        </Card>
        <Card variant="surface" className="p-6">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-[var(--green-a3)] rounded-lg">
              <PencilSquareIcon className="size-6 text-[var(--green-9)]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[var(--gray-11)]">Ready to Send</div>
              <div className="text-2xl font-bold mt-1">{readyCount}</div>
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
            placeholder="Search editions..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-[var(--color-background)] border border-[var(--gray-a6)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-9)] text-[var(--gray-12)]"
          />
        </div>
      </Card>

      {/* Editions Table */}
      <Card className="overflow-hidden">
        <DataTable table={table} loading={loading} onRowDoubleClick={(edition) => handleEdit(edition.id)} />

        {/* Pagination */}
        {!loading && table.getRowModel().rows.length > 0 && (
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
                <span className="font-medium">{table.getFilteredRowModel().rows.length}</span>{' '}
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
