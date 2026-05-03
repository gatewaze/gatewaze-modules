import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  RectangleGroupIcon,
  XMarkIcon,
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
  title: string | null;
  subject: string | null; // mapped from title for display
  edition_date: string;
  status: 'draft' | 'published' | 'archived';
  collection_id: string | null;
  collection_name?: string | null;
  created_at: string;
  updated_at: string;
  block_count?: number;
}

interface NewsletterType {
  id: string;
  name: string;
  slug: string;
  edition_count: number;
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

const statusColors: Record<string, 'neutral' | 'warning' | 'success'> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
};

const columnHelper = createColumnHelper<Edition>();

interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  block_count: number;
}

interface EditorTabProps {
  newsletterId?: string;
  newsletterSlug?: string;
  setupComplete?: boolean;
}

export function EditorTab({ newsletterId, newsletterSlug, setupComplete = true }: EditorTabProps = {}) {
  const navigate = useNavigate();
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'edition_date', desc: true },
  ]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [newsletterTypes, setNewsletterTypes] = useState<NewsletterType[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const loadEditions = useCallback(async () => {
    try {
      setLoading(true);

      // Load editions with block count and collection info
      // Load editions with block count
      let query = supabase
        .from('newsletters_editions')
        .select(`
          *,
          newsletters_edition_blocks(count)
        `)
        .order('edition_date', { ascending: false });

      if (newsletterId) {
        query = query.eq('collection_id', newsletterId);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Load collections separately to avoid PostgREST FK ambiguity
      const { data: collections } = await supabase
        .from('newsletters_template_collections')
        .select('id, name, slug')
        .order('name');

      const collectionsMap = new Map((collections || []).map((c: any) => [c.id, c]));

      const editionsWithCount = (data || []).map((edition: any) => {
        const collection = edition.collection_id ? collectionsMap.get(edition.collection_id) : null;
        return {
          ...edition,
          subject: edition.title,
          collection_name: collection?.name || null,
          block_count: edition.newsletters_edition_blocks?.[0]?.count || 0,
        };
      });

      setEditions(editionsWithCount);

      if (collections) {
        const typesWithCounts = collections.map((c: any) => ({
          ...c,
          edition_count: editionsWithCount.filter((e: any) => e.collection_id === c.id).length,
        }));
        setNewsletterTypes(typesWithCounts);
      }
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

  const handleCreateNew = async () => {
    if (!setupComplete) {
      toast.error('Complete the newsletter setup first (Details tab)');
      return;
    }

    // If we're inside a newsletter, go directly to new edition
    if (newsletterId) {
      const basePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
      navigate(`${basePath}/new?collection=${newsletterId}`);
      return;
    }

    try {
      // Load available templates
      const { data, error } = await supabase
        .from('newsletters_template_collections')
        .select('id, name, description')
        .order('is_default', { ascending: false })
        .order('name');

      if (error) throw error;

      if (!data || data.length === 0) {
        toast.error('Create a newsletter first');
        navigate('/newsletters/new');
        return;
      }

      // If only one template, auto-select it
      if (data.length === 1) {
        navigate(`/newsletters/editor/new?collection=${data[0].id}`);
        return;
      }

      // Multiple templates — fetch block counts and show picker.
      // Reads from templates_block_defs (legacy newsletters_block_templates is gone).
      const withCounts = await Promise.all(
        data.map(async (t) => {
          const { count } = await supabase
            .from('templates_block_defs')
            .select('id', { count: 'exact', head: true })
            .eq('library_id', t.id);
          return { ...t, block_count: count || 0 };
        })
      );

      setTemplates(withCounts);
      setShowTemplatePicker(true);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast.error('Failed to load templates');
    }
  };

  const handleEdit = (id: string) => {
    const basePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
    navigate(`${basePath}/${id}`);
  };

  const handleDuplicate = async (edition: Edition) => {
    try {
      // Create a copy of the edition
      const { data: newEdition, error: createError } = await supabase
        .from('newsletters_editions')
        .insert({
          title: edition.subject ? `${edition.subject} (Copy)` : null,
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
            templates_block_def_id: block.templates_block_def_id,
            block_type: block.block_type,
            content: block.content,
            sort_order: block.sort_order || block.block_order,
          })
          .select()
          .single();

        if (blockError) throw blockError;

        // Copy bricks
        const { data: bricks, error: bricksError } = await supabase
          .from('newsletters_edition_bricks')
          .select('*')
          .eq('block_id', block.id);

        if (bricksError) throw bricksError;

        for (const brick of bricks || []) {
          const { error: brickError } = await supabase
            .from('newsletters_edition_bricks')
            .insert({
              block_id: newBlock.id,
              templates_brick_def_id: brick.templates_brick_def_id,
              brick_type: brick.brick_type,
              content: brick.content,
              sort_order: brick.sort_order || brick.brick_order,
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
      ...(newsletterTypes.length > 1 ? [
        columnHelper.accessor('collection_name' as any, {
          header: 'Newsletter',
          cell: (info: any) => (
            <div className="text-sm text-[var(--gray-11)]">
              {info.getValue() || <span className="text-[var(--gray-a8)]">—</span>}
            </div>
          ),
        }),
      ] : []),
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
    [navigate, loadEditions, newsletterTypes.length]
  );

  const filteredEditions = useMemo(() => {
    if (!selectedType) return editions;
    return editions.filter(e => e.collection_id === selectedType);
  }, [editions, selectedType]);

  const table = useReactTable({
    data: filteredEditions,
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

  const draftCount = filteredEditions.filter((e) => e.status === 'draft').length;
  const readyCount = filteredEditions.filter((e) => e.status === 'ready').length;

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

      {/* Newsletter Type Filter — hide when inside a specific newsletter */}
      {!newsletterId && newsletterTypes.length > 1 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectedType(null)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              selectedType === null
                ? 'bg-[var(--accent-9)] text-white'
                : 'bg-[var(--gray-a3)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)]'
            }`}
          >
            All ({editions.length})
          </button>
          {newsletterTypes.map(type => (
            <button
              key={type.id}
              onClick={() => setSelectedType(type.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                selectedType === type.id
                  ? 'bg-[var(--accent-9)] text-white'
                  : 'bg-[var(--gray-a3)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)]'
              }`}
            >
              {type.name} ({type.edition_count})
            </button>
          ))}
        </div>
      )}

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

      {/* Template Picker Modal */}
      {showTemplatePicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowTemplatePicker(false)}>
          <Card className="w-full max-w-lg p-6 m-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--gray-12)]">Select Template</h2>
              <button onClick={() => setShowTemplatePicker(false)} className="text-[var(--gray-10)] hover:text-[var(--gray-12)]">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-[var(--gray-11)] mb-4">
              Choose which template to use for this new edition
            </p>
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => {
                    setShowTemplatePicker(false);
                    navigate(`/newsletters/editor/new?collection=${template.id}`);
                  }}
                  className="w-full p-4 rounded-lg border border-[var(--gray-6)] hover:border-[var(--accent-8)] hover:bg-[var(--accent-a2)] transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <RectangleGroupIcon className="w-5 h-5 text-[var(--accent-9)]" />
                    <div className="flex-1">
                      <div className="font-medium text-[var(--gray-12)]">{template.name}</div>
                      {template.description && (
                        <div className="text-xs text-[var(--gray-10)] mt-0.5">{template.description}</div>
                      )}
                    </div>
                    <span className="text-xs text-[var(--gray-10)]">{template.block_count} blocks</span>
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Editions Table */}
      <Card className="overflow-hidden">
        <DataTable table={table} loading={loading} onRowDoubleClick={(edition) => handleEdit(edition.id)} />

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
