/**
 * Sites listing — /sites
 *
 * Lists all non-archived sites. Click a row to drill into the site detail
 * page; "New Site" opens a modal that captures slug + name + theme_kind
 * (immutable post-create — see migration 006_sites_theme_kinds for the
 * trigger that enforces this).
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  GlobeAltIcon,
  EyeIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
} from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { SitesService, type SiteSummary } from '../services/sitesService';
import { useForm } from 'react-hook-form';

interface CreateSiteForm {
  name: string;
  slug: string;
  description: string;
}

const columnHelper = createColumnHelper<SiteSummary>();

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export default function SitesListPage() {
  const navigate = useNavigate();
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<SiteSummary | null>(null);

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<CreateSiteForm>({
    defaultValues: { name: '', slug: '', description: '' },
  });

  // Auto-derive slug from name (until the user edits slug manually).
  const watchName = watch('name');
  const watchSlug = watch('slug');
  useEffect(() => {
    if (!watchName) return;
    const auto = slugify(watchName);
    // only auto-update if slug is empty or matches the previous auto-slug
    if (!watchSlug || watchSlug === slugify(watchName.slice(0, watchName.length - 1))) {
      setValue('slug', auto);
    }
  }, [watchName, watchSlug, setValue]);

  const loadSites = async () => {
    setLoading(true);
    const { sites, error } = await SitesService.listSites();
    if (error) toast.error(`Failed to load sites: ${error}`);
    setSites(sites);
    setLoading(false);
  };

  useEffect(() => { loadSites(); }, []);

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => {
          const site = info.row.original;
          return (
            <div className="flex items-center gap-3">
              <GlobeAltIcon className="size-5 text-[var(--accent-9)] shrink-0" />
              <div>
                <div className="font-medium">{info.getValue()}</div>
                {site.description && (
                  <div className="text-xs text-[var(--gray-a8)] max-w-xs truncate">
                    {site.description}
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('slug', {
        header: 'Slug',
        cell: (info) => (
          <span className="font-mono text-[var(--gray-a8)]">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('publishing_target', {
        header: 'Publish to',
        cell: (info) => {
          const t = info.getValue();
          const label =
            t.kind === 'external' && t.publisherId
              ? t.publisherId.replace(/^sites-publisher-/, '')
              : t.kind;
          return <span className="text-sm text-[var(--gray-12)]">{label}</span>;
        },
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <Badge color={info.getValue() === 'active' ? 'success' : 'neutral'}>
            {info.getValue()}
          </Badge>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 50,
        cell: (info) => {
          const site = info.row.original;
          return (
            <RowActions
              actions={[
                {
                  label: 'View',
                  icon: <EyeIcon className="size-4" />,
                  onClick: () => navigate(`/sites/${site.slug}`),
                },
                {
                  label: 'Archive',
                  icon: <TrashIcon className="size-4" />,
                  onClick: () => setArchiveTarget(site),
                  color: 'red',
                },
              ]}
            />
          );
        },
      }),
    ],
    [navigate],
  );

  const table = useReactTable({
    data: sites,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const onCreate = async (data: CreateSiteForm) => {
    setSubmitting(true);
    const { site, error } = await SitesService.createSite({
      slug: data.slug,
      name: data.name,
      description: data.description || undefined,
      theme_kind: 'website',
    });
    setSubmitting(false);
    if (error || !site) {
      toast.error(`Failed: ${error}`);
      return;
    }
    toast.success(`Site "${site.name}" created`);
    setShowCreate(false);
    reset();
    navigate(`/sites/${site.slug}`);
  };

  const onArchive = async () => {
    if (!archiveTarget) return;
    const { error } = await SitesService.archiveSite(archiveTarget.id);
    if (error) {
      toast.error(`Failed to archive: ${error}`);
      return;
    }
    toast.success('Site archived');
    setArchiveTarget(null);
    loadSites();
  };

  return (
    <Page title="Sites">
      <div className="space-y-4">
        <Card>
          <div className="flex items-center gap-3 p-4">
            <Input
              placeholder="Search sites..."
              value={globalFilter}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGlobalFilter(e.target.value)}
              className="flex-1 max-w-md"
            />
            <Button onClick={() => setShowCreate(true)}>+ New Site</Button>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <DataTable
            table={table}
            loading={loading}
            onRowDoubleClick={(site) => navigate(`/sites/${site.slug}`)}
            emptyState={
              <div>
                <GlobeAltIcon className="mx-auto h-12 w-12 text-[var(--gray-a6)]" />
                <h3 className="mt-2 text-sm font-medium">No sites yet</h3>
                <p className="mt-1 text-sm text-[var(--gray-a8)]">
                  Create your first site to get started.
                </p>
                <div className="mt-3">
                  <Button onClick={() => setShowCreate(true)}>+ New Site</Button>
                </div>
              </div>
            }
          />
        </Card>
      </div>

      {/* Create Site Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => { setShowCreate(false); reset(); }}
        title="New Site"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outlined" onClick={() => { setShowCreate(false); reset(); }} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit(onCreate)} disabled={submitting}>
              {submitting ? 'Creating...' : 'Create'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            placeholder="My Site"
            {...register('name', { required: 'Name is required' })}
            error={errors.name?.message}
          />
          <Input
            label="Slug"
            placeholder="my-site"
            {...register('slug', {
              required: 'Slug is required',
              pattern: {
                value: /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/,
                message: 'Lowercase letters, digits, hyphens; must start + end with alphanumeric',
              },
            })}
            error={errors.slug?.message}
          />
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Description (optional)
            </label>
            <textarea
              {...register('description')}
              rows={2}
              className="w-full px-3 py-2 bg-transparent border border-[var(--gray-a5)] rounded-lg focus:outline-none focus:border-[var(--accent-9)] text-[var(--gray-12)]"
              placeholder="Short summary"
            />
          </div>
        </div>
      </Modal>

      {/* Archive confirmation */}
      <Modal
        isOpen={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="Archive site?"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outlined" onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button color="error" onClick={onArchive}>Archive</Button>
          </div>
        }
      >
        <p className="text-sm">
          Archive <span className="font-medium">{archiveTarget?.name}</span>? Pages remain
          in the database but are hidden from active listings. You can reactivate later.
        </p>
      </Modal>

      {loading && <LoadingSpinner />}
    </Page>
  );
}
