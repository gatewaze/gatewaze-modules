/**
 * Pages tab — embedded in /sites/:slug, shows the site's pages and lets
 * the user create / open / archive them.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { DocumentIcon, EyeIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, Modal, Select } from '@/components/ui';
import { DataTable } from '@/components/shared/table/DataTable';
import { RowActions } from '@/components/shared/table/RowActions';
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import {
  PagesService,
  SitesService,
  TemplatesLibrariesService,
  type PageSummary,
  type TemplatesLibrarySummary,
} from '../services/sitesService';
import type { SiteRow } from '../../types';

interface CreatePageForm {
  title: string;
  slug: string;
  full_path: string;
  templates_library_id: string;
  is_homepage: boolean;
}

const columnHelper = createColumnHelper<PageSummary>();

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function SitePagesTab({ site }: { site: SiteRow }) {
  const navigate = useNavigate();
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [libraries, setLibraries] = useState<TemplatesLibrarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalFilter, setGlobalFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<PageSummary | null>(null);

  const form = useForm<CreatePageForm>({
    defaultValues: {
      title: '',
      slug: '',
      full_path: '',
      templates_library_id: site.templates_library_id ?? '',
      is_homepage: false,
    },
  });
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = form;

  // Auto-derive slug + full_path from title
  const watchTitle = watch('title');
  const watchSlug = watch('slug');
  useEffect(() => {
    if (!watchTitle) return;
    const auto = slugify(watchTitle);
    if (!watchSlug || watchSlug === slugify(watchTitle.slice(0, watchTitle.length - 1))) {
      setValue('slug', auto);
      setValue('full_path', `/${auto}`);
    }
  }, [watchTitle, watchSlug, setValue]);

  const load = async () => {
    setLoading(true);
    const [pagesRes, libsRes] = await Promise.all([
      PagesService.listPages(site.id),
      TemplatesLibrariesService.listForSite(site.theme_kind),
    ]);
    if (pagesRes.error) toast.error(`Pages: ${pagesRes.error}`);
    if (libsRes.error) toast.error(`Libraries: ${libsRes.error}`);
    setPages(pagesRes.pages);
    setLibraries(libsRes.libraries);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  const columns = useMemo(
    () => [
      columnHelper.accessor('title', {
        header: 'Title',
        cell: (info) => {
          const p = info.row.original;
          return (
            <div className="flex items-center gap-2">
              <DocumentIcon className="size-4 text-[var(--gray-a8)]" />
              <span className="font-medium">{info.getValue()}</span>
              {p.is_homepage && <Badge color="info">home</Badge>}
            </div>
          );
        },
      }),
      columnHelper.accessor('full_path', {
        header: 'Path',
        cell: (info) => <span className="font-mono text-[var(--gray-a8)]">{info.getValue()}</span>,
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const s = info.getValue();
          const color =
            s === 'published' ? 'success' : s === 'scheduled' ? 'warning' : 'neutral';
          return <Badge color={color}>{s}</Badge>;
        },
      }),
      columnHelper.accessor('version', {
        header: 'Editor v.',
        cell: (info) => <span className="text-[var(--gray-a8)]">{info.getValue()}</span>,
      }),
      columnHelper.accessor('published_version', {
        header: 'Pub v.',
        cell: (info) => {
          const v = info.getValue();
          return v > 0 ? <span>{v}</span> : <span className="text-[var(--gray-a7)]">—</span>;
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 50,
        cell: (info) => {
          const p = info.row.original;
          return (
            <RowActions
              actions={[
                {
                  label: 'Edit',
                  icon: <PencilIcon className="size-4" />,
                  onClick: () => navigate(`/sites/${site.slug}/pages/${p.id}`),
                },
                {
                  label: 'View',
                  icon: <EyeIcon className="size-4" />,
                  onClick: () => navigate(`/sites/${site.slug}/pages/${p.id}`),
                },
                {
                  label: 'Archive',
                  icon: <TrashIcon className="size-4" />,
                  onClick: () => setArchiveTarget(p),
                  color: 'red',
                },
              ]}
            />
          );
        },
      }),
    ],
    [navigate, site.slug],
  );

  const table = useReactTable({
    data: pages,
    columns,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const onCreate = async (data: CreatePageForm) => {
    if (!data.templates_library_id) {
      toast.error('Pick a templates library');
      return;
    }
    setSubmitting(true);
    const { page, error } = await PagesService.createPage({
      siteId: site.id,
      templates_library_id: data.templates_library_id,
      slug: data.slug,
      full_path: data.full_path,
      title: data.title,
      is_homepage: data.is_homepage,
    });
    setSubmitting(false);
    if (error || !page) {
      toast.error(`Create failed: ${error}`);
      return;
    }
    toast.success(`Page "${page.title}" created`);
    setShowCreate(false);
    reset({
      title: '', slug: '', full_path: '',
      templates_library_id: data.templates_library_id,
      is_homepage: false,
    });
    navigate(`/sites/${site.slug}/pages/${page.id}`);
  };

  const onArchive = async () => {
    if (!archiveTarget) return;
    const { error } = await PagesService.archivePage(archiveTarget.id);
    if (error) {
      toast.error(`Archive failed: ${error}`);
      return;
    }
    toast.success('Page archived');
    setArchiveTarget(null);
    load();
  };

  const provisionStarter = async () => {
    setProvisioning(true);
    const { error } = await SitesService.provisionStarterLibrary({
      siteId: site.id,
      siteName: site.name,
      themeKind: site.theme_kind,
    });
    setProvisioning(false);
    if (error) {
      toast.error(`Provision failed: ${error}`);
      return;
    }
    toast.success('Starter library created. You can now add pages.');
    load();
  };

  // Portal site is metadata-only — its pages are file-based routes in the
  // portal Next.js app, not editable through this UI.
  if (site.publishing_target.kind === 'portal' && site.slug === 'portal') {
    return <PortalSitePagesView />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3 p-4">
          <Input
            placeholder="Search pages..."
            value={globalFilter}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGlobalFilter(e.target.value)}
            className="flex-1 max-w-md"
          />
          {libraries.length === 0 ? (
            <Button onClick={provisionStarter} disabled={provisioning}>
              {provisioning ? 'Provisioning...' : '+ Provision starter templates'}
            </Button>
          ) : (
            <Button onClick={() => setShowCreate(true)}>+ New Page</Button>
          )}
        </div>
        {libraries.length === 0 && (
          <div className="px-4 pb-4 text-sm text-[var(--gray-a8)]">
            No <span className="font-mono">templates_libraries</span> with theme_kind=
            <span className="font-mono">{site.theme_kind}</span> are available for this site yet.
            Click "Provision starter templates" to create a default library (one wrapper +
            heading/paragraph block defs) so you can start adding pages. You can swap or extend
            blocks via the templates UI later.
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <DataTable
          table={table}
          loading={loading}
          onRowDoubleClick={(p) => navigate(`/sites/${site.slug}/pages/${p.id}`)}
          emptyState={
            <div>
              <DocumentIcon className="mx-auto h-10 w-10 text-[var(--gray-a6)]" />
              <h3 className="mt-2 text-sm font-medium">No pages yet</h3>
              <p className="mt-1 text-sm text-[var(--gray-a8)]">
                Add your first page to start building this site.
              </p>
            </div>
          }
        />
      </Card>

      <Modal
        isOpen={showCreate}
        onClose={() => { setShowCreate(false); reset(); }}
        title="New Page"
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
            label="Title"
            placeholder="About"
            {...register('title', { required: 'Title is required' })}
            error={errors.title?.message}
          />
          <Input
            label="Slug"
            placeholder="about"
            {...register('slug', {
              required: 'Slug is required',
              pattern: {
                value: /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/,
                message: 'Lowercase letters, digits, hyphens',
              },
            })}
            error={errors.slug?.message}
          />
          <Input
            label="Full path"
            placeholder="/about"
            {...register('full_path', {
              required: 'Path is required',
              pattern: { value: /^\//, message: 'Must start with /' },
            })}
            error={errors.full_path?.message}
          />
          <Select
            label="Templates library"
            {...register('templates_library_id', { required: 'Library is required' })}
            data={[
              { value: '', label: '— pick a library —' },
              ...libraries.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register('is_homepage')} />
            <span>Make this the homepage (path /)</span>
          </label>
        </div>
      </Modal>

      <Modal
        isOpen={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="Archive page?"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outlined" onClick={() => setArchiveTarget(null)}>Cancel</Button>
            <Button color="error" onClick={onArchive}>Archive</Button>
          </div>
        }
      >
        <p className="text-sm">
          Archive <span className="font-medium">{archiveTarget?.title}</span>? Visitors won't see it.
        </p>
      </Modal>
    </div>
  );
}

// Read-only view for the seeded "Portal" site. Lists known top-level routes
// served by the portal Next.js app so operators can see what exists, but
// these pages aren't editable through the sites UI — they're React code.
const PORTAL_ROUTES: Array<{ path: string; label: string }> = [
  { path: '/',           label: 'Home' },
  { path: '/events',     label: 'Events' },
  { path: '/calendars',  label: 'Calendars' },
  { path: '/blog',       label: 'Blog' },
  { path: '/newsletters', label: 'Newsletters' },
  { path: '/recipes',    label: 'Recipes' },
  { path: '/sign-in',    label: 'Sign in' },
  { path: '/profile',    label: 'Profile' },
];

function PortalSitePagesView() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4 space-y-2 text-sm">
          <p className="text-[var(--gray-12)] font-medium">Portal pages are managed in the codebase.</p>
          <p className="text-[var(--gray-a8)]">
            The Portal site represents the platform's built-in admin and member-facing UI.
            Its routes are hand-written React in the portal Next.js app (
            <span className="font-mono">packages/portal/app/...</span>); they aren't created or
            edited through this interface.
          </p>
        </div>
      </Card>
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold text-[var(--gray-12)] mb-2">Known top-level routes</h3>
          <ul className="space-y-1">
            {PORTAL_ROUTES.map((r) => (
              <li key={r.path} className="flex items-center gap-3 text-sm">
                <DocumentIcon className="size-4 text-[var(--gray-a7)] shrink-0" />
                <span className="font-mono text-[var(--gray-12)]">{r.path}</span>
                <span className="text-[var(--gray-a8)]">— {r.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--gray-a8)]">
            Module-contributed pages (e.g. <span className="font-mono">/{'<module>'}/{'<slug>'}</span>) are added
            dynamically by enabled modules and aren't listed here.
          </p>
        </div>
      </Card>
    </div>
  );
}
