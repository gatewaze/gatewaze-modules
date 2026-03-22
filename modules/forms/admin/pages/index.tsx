import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ClipboardDocumentListIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  PlusIcon,
  EyeIcon,
  TrashIcon,
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
import { Input } from '@/components/ui/Form';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 25;

interface FormRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  submission_count: number;
}

function timeAgo(dateString: string | undefined): string {
  if (!dateString) return '-';
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  const intervals: [string, number][] = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, secs] of intervals) {
    const interval = Math.floor(seconds / secs);
    if (interval >= 1) return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

const columnHelper = createColumnHelper<FormRow>();

export default function FormsListPage() {
  const navigate = useNavigate();
  const [forms, setForms] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'updated_at', desc: true }]);

  const loadForms = async () => {
    try {
      setLoading(true);

      const { data: formsData, error } = await supabase
        .from('forms')
        .select('*')
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('Error fetching forms:', error);
        toast.error('Failed to load forms');
        return;
      }

      const formsWithCounts = await Promise.all(
        (formsData || []).map(async (form) => {
          const { count } = await supabase
            .from('forms_submissions')
            .select('*', { count: 'exact', head: true })
            .eq('form_id', form.id);

          return { ...form, submission_count: count || 0 };
        })
      );

      setForms(formsWithCounts);
    } catch (error) {
      console.error('Error loading forms:', error);
      toast.error('Failed to load forms');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadForms();
  }, []);

  const handleCreateForm = async () => {
    const slug = 'form-' + Date.now().toString(36);

    // Build default fields from people attributes settings
    const fields: Array<{ id: string; type: string; label: string; placeholder?: string; required?: boolean; options?: string[] }> = [
      { id: 'email', type: 'email', label: 'Email', placeholder: 'your@email.com', required: true },
    ];

    try {
      const { data: settingsRow } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('key', 'people_attributes')
        .maybeSingle();

      const attrs: Array<{ key: string; label: string; enabled: boolean; required: boolean; type?: string; options?: string[] }> =
        settingsRow?.value ? JSON.parse(settingsRow.value) : [
          { key: 'first_name', label: 'First Name', enabled: true, required: true, type: 'string' },
          { key: 'last_name', label: 'Last Name', enabled: true, required: true, type: 'string' },
        ];

      for (const attr of attrs) {
        if (!attr.enabled || !attr.required) continue;
        // Map people attribute types to form field types
        let fieldType = 'text';
        if (attr.type === 'text') fieldType = 'textarea';
        else if (attr.type === 'select') fieldType = 'select';
        else if (attr.type === 'multi-select') fieldType = 'checkbox';

        const field: typeof fields[number] = {
          id: attr.key,
          type: fieldType,
          label: attr.label,
          required: true,
        };
        if (attr.options?.length) field.options = attr.options;
        fields.push(field);
      }
    } catch {
      // Fall back to just email + name fields
      fields.push(
        { id: 'first_name', type: 'text', label: 'First Name', required: true },
        { id: 'last_name', type: 'text', label: 'Last Name', required: true },
      );
    }

    const { data, error } = await supabase
      .from('forms')
      .insert({ slug, name: 'Untitled Form', fields })
      .select('id')
      .single();

    if (error) {
      toast.error('Failed to create form');
      return;
    }

    navigate(`/forms/${data.id}`);
  };

  const handleDeleteForm = async (form: FormRow) => {
    if (!confirm(`Delete "${form.name}"? This will also delete all submissions.`)) return;

    const { error } = await supabase.from('forms').delete().eq('id', form.id);
    if (error) {
      toast.error('Failed to delete form');
      return;
    }

    toast.success('Form deleted');
    loadForms();
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => (
          <div className="text-sm font-medium text-[var(--gray-12)] max-w-xs truncate" title={info.getValue()}>
            {info.getValue()}
          </div>
        ),
      }),
      columnHelper.accessor('slug', {
        header: 'Slug',
        cell: (info) => (
          <div className="text-sm font-mono text-[var(--gray-11)]">{info.getValue()}</div>
        ),
      }),
      columnHelper.accessor('submission_count', {
        header: 'Submissions',
        cell: (info) => (
          <Badge color={info.getValue() > 0 ? 'success' : 'neutral'}>
            {info.getValue().toLocaleString()}
          </Badge>
        ),
      }),
      columnHelper.accessor('is_active', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() ? 'success' : 'neutral'}>
            {info.getValue() ? 'Active' : 'Inactive'}
          </Badge>
        ),
      }),
      columnHelper.accessor('updated_at', {
        header: 'Last Updated',
        cell: (info) => (
          <div className="text-sm text-[var(--gray-11)] whitespace-nowrap">
            {timeAgo(info.getValue())}
          </div>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => {
          const form = info.row.original;
          return (
            <RowActions
              actions={[
                { label: 'Edit', icon: <EyeIcon className="size-4" />, onClick: () => navigate(`/forms/${form.id}`) },
                { label: 'Delete', icon: <TrashIcon className="size-4" />, onClick: () => handleDeleteForm(form), variant: 'danger' },
              ]}
            />
          );
        },
      }),
    ],
    [navigate]
  );

  const table = useReactTable({
    data: forms,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const totalSubmissions = forms.reduce((sum, f) => sum + f.submission_count, 0);

  return (
    <Page title="Forms">
      <div className="p-6 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Forms</h1>
            <p className="text-[var(--gray-11)] mt-1">Create and manage custom forms</p>
          </div>
          <div className="flex gap-3 items-center">
            <Button onClick={loadForms} variant="outlined" className="gap-2" disabled={loading}>
              <ArrowPathIcon className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={handleCreateForm} className="gap-2">
              <PlusIcon className="size-4" />
              New Form
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Forms</div>
                <div className="text-2xl font-bold mt-1">{forms.length}</div>
              </div>
            </div>
          </Card>
          <Card variant="surface" className="p-6">
            <div className="flex items-center gap-3">
              <ClipboardDocumentListIcon className="size-6 text-[var(--accent-9)]" />
              <div>
                <div className="text-sm font-medium text-[var(--gray-11)]">Total Submissions</div>
                <div className="text-2xl font-bold mt-1">{totalSubmissions.toLocaleString()}</div>
              </div>
            </div>
          </Card>
        </div>

        <Card variant="surface" className="p-4">
          <Input
            placeholder="Search forms..."
            value={globalFilter ?? ''}
            onChange={(e) => setGlobalFilter(e.target.value)}
            prefix={<MagnifyingGlassIcon className="size-5 text-[var(--gray-a8)]" />}
          />
        </Card>

        <Card className="overflow-hidden">
          <DataTable table={table} loading={loading} onRowDoubleClick={(form) => navigate(`/forms/${form.id}`)} />

          {!loading && table.getRowModel().rows.length > 0 && (
            <div className="px-6 py-4 bg-[var(--gray-a3)] border-t border-[var(--gray-a6)]">
              <div className="flex items-center justify-between">
                <div className="text-sm text-[var(--gray-11)]">
                  Showing{' '}
                  <span className="font-medium">{table.getState().pagination.pageIndex * PAGE_SIZE + 1}</span>
                  {' '}to{' '}
                  <span className="font-medium">
                    {Math.min((table.getState().pagination.pageIndex + 1) * PAGE_SIZE, table.getFilteredRowModel().rows.length)}
                  </span>
                  {' '}of{' '}
                  <span className="font-medium">{table.getFilteredRowModel().rows.length}</span> results
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
      </div>
    </Page>
  );
}
