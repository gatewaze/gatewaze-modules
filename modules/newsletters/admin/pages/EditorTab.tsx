import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  DocumentDuplicateIcon,
  CloudArrowUpIcon,
  ArrowUturnLeftIcon,
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
  getExpandedRowModel,
  createColumnHelper,
  SortingState,
  ExpandedState,
  type Row,
} from '@tanstack/react-table';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
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
import { exportEditionHtml } from '../components/puck/email-blocks/export-edition-html';
import { buildEmailRegistry } from '../components/puck/email-blocks/declarative/registry';

const PAGE_SIZE = 25;

interface Edition {
  id: string;
  title: string | null;
  subject: string | null; // mapped from title for display
  edition_date: string;
  status: 'draft' | 'published' | 'archived';
  publish_state?: string | null;
  collection_id: string | null;
  collection_name?: string | null;
  created_at: string;
  updated_at: string;
  block_count?: number;
  // Trend vs the chronologically-previous edition: 'up' | 'down' | null.
  // sent compares raw counts (list size); clicks/opens compare rates.
  sentTrend?: 'up' | 'down' | null;
  clicksTrend?: 'up' | 'down' | null;
  opensTrend?: 'up' | 'down' | null;
  engagement?: EditionEngagement | null;
}

interface EditionEngagement {
  sent: number;
  delivered: number;
  unique_opens: number;      // raw total opens (all-time)
  unique_clicks: number;     // raw total clicks
  human_opens: number | null;   // per-edition human (hybrid); null if undetermined
  human_clicks: number | null;
  machine_opens: number | null;
  machine_clicks: number | null;
  human_source: 'signals-v1' | 'customer.io' | 'estimate' | null;
  bounced: number;        // system suppression (bounce/drop)
  unsubscribed: number;   // genuine opt-out (global or topic)
  cio_human_opens: number;   // Customer.io reference (0 for pre-2025 editions)
  cio_machine_opens: number;
  cio_human_clicks: number;
}

interface DetectionSourceRow {
  detection_source: string;
  human_openers: number;
  machine_openers: number;
  human_clickers: number;
  reconciled_human_openers: number;
  rescued_by_click: number;
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

function fmtNum(n: number): string {
  return n.toLocaleString();
}

// Inline spinner shown in metric cells while engagement is still loading.
const CellSpin = () => (
  <span className="inline-block size-3.5 border-2 border-[var(--gray-a5)] border-t-[var(--gray-9)] rounded-full animate-spin align-middle" />
);

type Trend = 'up' | 'down' | null | undefined;
const trendColor = (dir: Trend, fallback: string) =>
  dir === 'up' ? 'text-[var(--green-11)]' : dir === 'down' ? 'text-[var(--red-11)]' : fallback;
function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

// Fixed-width arrow slot so the percentage and count segments line up vertically
// across rows regardless of whether a given row has an up/down/flat trend.
const ArrowSlot = ({ dir }: { dir: Trend }) => (
  <span className="inline-block w-3 text-left text-xs">
    {dir === 'up' ? <span className="text-[var(--green-9)]">↑</span>
      : dir === 'down' ? <span className="text-[var(--red-9)]">↓</span> : null}
  </span>
);

// Metric cell: percentage (+trend arrow) and the raw count as two right-aligned
// segments with fixed widths, so both line up as their own visual columns.
const MetricCell = ({ pctText, dir, count, dimPct }: { pctText: string; dir: Trend; count: string; dimPct?: boolean }) => (
  <div className="flex items-center justify-end text-sm whitespace-nowrap">
    <span className={`font-bold ${trendColor(dir, dimPct ? 'text-[var(--gray-10)]' : 'text-[var(--gray-12)]')}`}>{pctText}</span>
    <ArrowSlot dir={dir} />
    <span className="w-10 text-right text-[11px] text-[var(--gray-12)]">{count}</span>
  </div>
);
const RightDash = () => <div className="flex justify-end text-sm text-[var(--gray-a8)]">—</div>;
const rightHeader = (label: string) => () => <div className="grow text-right">{label}</div>;

// Expanded-row detail: raw delivery, the per-edition human/machine split, and a
// source comparison. The top-level table shows the clean human numbers; this is
// the full/raw picture.
function EngagementDetail({ edition }: { edition: Edition }) {
  const e = edition.engagement;
  if (!e) {
    return <div className="px-6 py-4 text-sm text-[var(--gray-a8)]">Loading engagement…</div>;
  }
  if (e.sent === 0) {
    return <div className="px-6 py-4 text-sm text-[var(--gray-a8)]">No send/engagement data recorded for this edition.</div>;
  }
  const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex flex-col">
      <span className="text-xs text-[var(--gray-10)]">{label}</span>
      <span className="text-lg font-semibold text-[var(--gray-12)]">{value}</span>
      {sub && <span className="text-xs text-[var(--gray-10)]">{sub}</span>}
    </div>
  );
  const measured = e.human_source === 'signals-v1';
  const sourceLabel = measured ? 'signals-v1 (ours, per-event detection)'
    : 'estimate (calibrated from the editions we have scored)';
  return (
    <div className="bg-[var(--gray-a2)] px-6 py-4 border-t border-[var(--gray-a4)]">
      {/* Edition meta (moved out of the table columns) */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-4 text-xs text-[var(--gray-10)]">
        <span>
          Git:{' '}
          {edition.publish_state === 'published'
            ? <Badge color="success" size="1">In git</Badge>
            : <span className="text-[var(--gray-a8)]">not published</span>}
        </span>
        <span>Blocks: <span className="text-[var(--gray-12)] font-medium">{edition.block_count ?? 0}</span></span>
        <span title={new Date(edition.updated_at).toLocaleString()}>
          Last updated: <span className="text-[var(--gray-12)]">{timeAgo(edition.updated_at)}</span>
        </span>
      </div>
      {/* Side-by-side: stats panel (left) + detection-source table (right) */}
      <div className="grid lg:grid-cols-5 gap-5 items-start">
        <div className="lg:col-span-3 rounded-lg border border-[var(--gray-a4)] bg-[var(--color-panel-solid)] p-4">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
            <Stat label="Sent" value={fmtNum(e.sent)} />
            <Stat label="Delivered" value={fmtNum(e.delivered)} sub={pct(e.delivered, e.sent) + ' of sent'} />
            <Stat label="Bounced" value={fmtNum(e.bounced)} sub={pct(e.bounced, e.sent)} />
            <Stat label="Opens (raw)" value={fmtNum(e.unique_opens)} sub={pct(e.unique_opens, e.delivered) + ' open rate'} />
            <Stat label="Clicks (raw)" value={fmtNum(e.unique_clicks)} sub={pct(e.unique_clicks, e.delivered) + ' CTR'} />
          </div>
          <div className="mt-4 pt-4 border-t border-[var(--gray-a4)]">
            <div className="text-xs font-medium text-[var(--gray-11)] mb-3">
              Human engagement · {sourceLabel}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat label="Human clicks" value={e.human_clicks == null ? '—' : (measured ? '' : '~') + fmtNum(e.human_clicks)} sub={e.human_clicks == null ? undefined : pct(e.human_clicks, e.delivered) + ' human CTR'} />
              <Stat label="Machine clicks" value={e.machine_clicks == null ? '—' : fmtNum(e.machine_clicks)} sub="scanners / bots" />
              <Stat label="Human opens (est.)" value={e.human_opens == null ? '—' : '~' + fmtNum(e.human_opens)} sub={e.human_opens == null ? undefined : pct(e.human_opens, e.delivered) + ' of delivered'} />
              <Stat label="Machine opens" value={e.machine_opens == null ? '—' : fmtNum(e.machine_opens)} sub="incl. Apple MPP" />
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-[var(--gray-a4)]">
            <div className="text-xs font-medium text-[var(--gray-11)] mb-3">
              List churn · why the sent count moves week-to-week
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Stat label="Unsubscribed" value={fmtNum(e.unsubscribed)} sub={pct(e.unsubscribed, e.sent) + ' · opt-out'} />
              <Stat label="Bounced / suppressed" value={fmtNum(e.bounced)} sub={pct(e.bounced, e.sent) + ' · delivery failure'} />
              <Stat label="Total removed" value={fmtNum(e.unsubscribed + e.bounced)} sub={pct(e.unsubscribed + e.bounced, e.sent) + ' of sent'} />
            </div>
          </div>
        </div>
        <div className="lg:col-span-2">
          <DetectionSourceComparison editionId={edition.id} eng={e} />
        </div>
      </div>
    </div>
  );
}

// Per-edition comparison of human-open estimators. Our figures are primary;
// Customer.io is shown only as a reference (and is blank before its human
// metric launched in 2025). Loaded lazily when the row expands.
function DetectionSourceComparison({ editionId, eng }: { editionId: string; eng: EditionEngagement }) {
  const [rows, setRows] = useState<DetectionSourceRow[] | null>(null);
  useEffect(() => {
    let active = true;
    supabase.rpc('edition_detection_comparison', { p_edition_id: editionId }).then(({ data }: { data: any[] | null }) => {
      if (active) setRows((data || []).map((r) => ({
        detection_source: r.detection_source,
        human_openers: Number(r.human_openers),
        machine_openers: Number(r.machine_openers),
        human_clickers: Number(r.human_clickers),
        reconciled_human_openers: Number(r.reconciled_human_openers),
        rescued_by_click: Number(r.rescued_by_click),
      })));
    });
    return () => { active = false; };
  }, [editionId]);

  const openers = eng.unique_opens;
  const cioHasHuman = eng.cio_human_opens > 0;

  const numCell = (v: number, sub?: string) => (
    <td className="px-3 py-1.5 text-right whitespace-nowrap text-[var(--gray-11)]">
      {fmtNum(v)}{sub != null && <span className="text-xs text-[var(--gray-a8)] ml-1">{sub}</span>}
    </td>
  );
  return (
    <div className="rounded-lg border border-[var(--gray-a4)] bg-[var(--color-panel-solid)] overflow-hidden">
      <div className="px-3 py-2 text-xs font-medium text-[var(--gray-11)] bg-[var(--gray-a2)] border-b border-[var(--gray-a4)]">
        Detection sources · {fmtNum(openers)} openers
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-[var(--gray-10)] border-b border-[var(--gray-a3)]">
            <th className="px-3 py-1.5 font-medium text-left">Source</th>
            <th className="px-3 py-1.5 font-medium text-right">Human opens</th>
            <th className="px-3 py-1.5 font-medium text-right">Machine</th>
            <th className="px-3 py-1.5 font-medium text-right">Human clicks</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).filter((r) => r.detection_source === 'bot-detector-signals').map((r) => {
            const o = r.human_openers + r.machine_openers;
            return (
              <tr key={r.detection_source} className="border-b border-[var(--gray-a3)] last:border-0">
                <td className="px-3 py-1.5 text-[var(--gray-12)]">signals-v1</td>
                {numCell(r.human_openers, pct(r.human_openers, o))}
                {numCell(r.machine_openers, pct(r.machine_openers, o))}
                {numCell(r.human_clickers)}
              </tr>
            );
          })}
          <tr className="border-b border-[var(--gray-a3)] last:border-0">
            <td className="px-3 py-1.5 text-[var(--gray-11)]">Customer.io</td>
            {cioHasHuman ? (
              <>
                {numCell(eng.cio_human_opens, pct(eng.cio_human_opens, eng.cio_human_opens + eng.cio_machine_opens))}
                {numCell(eng.cio_machine_opens)}
                {numCell(eng.cio_human_clicks)}
              </>
            ) : (
              <td className="px-3 py-1.5 text-right text-[var(--gray-a8)]" colSpan={3}>no CIO data (pre-2025)</td>
            )}
          </tr>
        </tbody>
      </table>
      <div className="px-3 py-2 text-xs text-[var(--gray-9)] border-t border-[var(--gray-a4)] leading-relaxed">
        <strong>Clicks</strong> are reliable (MPP never clicks; ~27% stripped as scanners). <strong>Opens</strong> are an estimate — Apple MPP hides the real read. All figures are our own; Customer.io is a frozen historical reference (we&apos;re leaving it), and its open number was a generous estimate, not a measurement.
      </div>
    </div>
  );
}

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
  const [expanded, setExpanded] = useState<ExpandedState>({});

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

      // Engagement aggregates — progressive + batched. The aggregate RPC scans a
      // lot of send-log rows; one call for all editions exceeds PostgREST's
      // statement timeout, so chunk it (each small batch is fast) and merge as
      // each returns. Newest editions first so the visible page fills in first.
      const editionIds = editionsWithCount.map((e: any) => e.id);
      const CHUNK = 10;
      for (let i = 0; i < editionIds.length; i += CHUNK) {
        const chunk = editionIds.slice(i, i + CHUNK);
        supabase
          .rpc('newsletter_edition_engagement', { p_edition_ids: chunk })
          .then(({ data: eng }: { data: any[] | null }) => {
            if (!eng) return;
            const byId = new Map(eng.map((r: any) => [r.edition_id, r]));
            setEditions((prev) => prev.map((e) => (byId.has(e.id) ? { ...e, engagement: byId.get(e.id) } : e)));
          });
      }

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
      toast.error('Complete the newsletter setup first (Settings tab)');
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

  // Render the edition the same way the editor's Publish does (declarative/
  // react-email via the registry) and POST the HTML to publish-to-git. The
  // endpoint commits it + promotes status to 'published'. Rendering runs here
  // (admin) because the email-blocks barrel doesn't resolve in the API.
  const handlePublishEdition = async (edition: Edition) => {
    const tid = toast.loading('Publishing…');
    try {
      const collectionId = edition.collection_id;
      const { data: coll } = await supabase
        .from('newsletters_template_collections')
        .select('config')
        .eq('id', collectionId)
        .maybeSingle();
      const wrapper = (coll?.config as { wrapper?: unknown } | null)?.wrapper ?? null;

      const [blocksRes, bricksRes] = await Promise.all([
        supabase
          .from('templates_block_defs')
          .select('id, key, name, schema, html, rich_text_template, has_bricks, render_kind, component_id, block_type:key')
          .eq('library_id', collectionId)
          .order('key'),
        supabase
          .from('templates_brick_defs')
          .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key, render_kind, component_id, templates_block_defs!inner(library_id)')
          .eq('templates_block_defs.library_id', collectionId)
          .order('sort_order'),
      ]);
      const adapt = (r: any) => ({ ...r, content: { html_template: r.html ?? '', rich_text_template: r.rich_text_template ?? null, has_bricks: r.has_bricks ?? false, schema: r.schema ?? {} } });
      const registry = buildEmailRegistry((blocksRes.data ?? []).map(adapt) as never, (bricksRes.data ?? []).map(adapt) as never);

      const { data: rawBlocks } = await supabase
        .from('newsletters_edition_blocks')
        .select('*, block_template:templates_block_defs!templates_block_def_id(id, key, name, schema, html, rich_text_template, has_bricks, block_type:key)')
        .eq('edition_id', edition.id)
        .order('sort_order');
      const blocks = (rawBlocks ?? []).map((b: any) => ({
        ...b,
        block_template: b.block_template
          ? { ...b.block_template, content: { html_template: b.block_template.html ?? '', rich_text_template: b.block_template.rich_text_template ?? null, has_bricks: b.block_template.has_bricks ?? false, schema: b.block_template.schema ?? {} } }
          : b.block_template,
      }));

      const blockMeta = new Map<string, { render_kind: 'react-email' | 'mustache'; component_id?: string; mustache_html?: string }>();
      for (const block of blocks) {
        const key = block.block_template?.block_type;
        blockMeta.set(block.id, registry.has(key)
          ? { render_kind: 'react-email', component_id: key }
          : { render_kind: 'mustache', mustache_html: block.block_template?.content?.html_template ?? '' });
      }

      const html = await exportEditionHtml({
        edition: { id: edition.id, edition_date: edition.edition_date, blocks } as never,
        format: 'email',
        blockMeta: blockMeta as never,
        wrapper: wrapper as never,
        registry,
        hideViewOnline: true,
        pretty: false,
      });
      const blockRender = blocks.map((b: any) => {
        const m = blockMeta.get(b.id);
        return { id: b.id, render_kind: m?.render_kind ?? 'mustache', component_id: m?.component_id ?? b.block_type };
      });

      const apiUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '';
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${apiUrl}/api/admin/newsletters/editions/${edition.id}/publish-to-git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ html, blockRender }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`publish-to-git ${res.status}: ${body.slice(0, 200)}`);
      }
      toast.success('Published to git', { id: tid });
      loadEditions();
    } catch (error) {
      console.error('[newsletters] publish failed:', error);
      toast.error(`Publish failed: ${error instanceof Error ? error.message : String(error)}`, { id: tid, duration: 10000 });
    }
  };

  // Move a published edition back to draft: hide from the portal (status) and
  // remove it from the git archive + RSS feed.
  const handleMakeDraft = async (edition: Edition) => {
    const tid = toast.loading('Making draft…');
    try {
      await supabase.from('newsletters_editions').update({ status: 'draft', updated_at: new Date().toISOString() }).eq('id', edition.id);
      const apiUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? '';
      const { data: { session } } = await supabase.auth.getSession();
      await fetch(`${apiUrl}/api/admin/newsletters/editions/${edition.id}/unpublish-from-git`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      toast.success('Moved to draft', { id: tid });
      loadEditions();
    } catch (error) {
      console.error('[newsletters] make-draft failed:', error);
      toast.error('Failed to make draft', { id: tid });
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'expander',
        header: '',
        size: 44,
        cell: ({ row }) => (
          <button
            onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
            className="p-1 text-[var(--gray-10)] hover:text-[var(--gray-12)]"
            aria-label={row.getIsExpanded() ? 'Collapse' : 'Expand'}
          >
            <ChevronRightIcon
              className="size-4 transition-transform"
              style={{ transform: row.getIsExpanded() ? 'rotate(90deg)' : 'none' }}
            />
          </button>
        ),
      }),
      columnHelper.accessor('edition_date', {
        header: 'Date',
        size: 120,
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
      // Hide the Newsletter column when scoped to one newsletter (we're already
      // inside it): either opened via a newsletter route or filtered to a type.
      ...(newsletterTypes.length > 1 && !newsletterId && !selectedType ? [
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
        size: 110,
        cell: (info) => (
          <Badge color={statusColors[info.getValue()]}>
            {info.getValue().charAt(0).toUpperCase() + info.getValue().slice(1)}
          </Badge>
        ),
      }),
      columnHelper.accessor((row) => row.engagement?.sent ?? -1, {
        id: 'sent',
        header: rightHeader('Sent'),
        size: 95,
        cell: (info) => {
          const eng = info.row.original.engagement;
          if (!eng) return <div className="flex justify-end"><CellSpin /></div>;
          if (eng.sent === 0) return <RightDash />;
          const t = info.row.original.sentTrend;
          return (
            <div className="flex items-center justify-end text-sm whitespace-nowrap">
              <span className={`font-bold ${trendColor(t, 'text-[var(--gray-12)]')}`}>{fmtNum(eng.sent)}</span>
              <ArrowSlot dir={t} />
            </div>
          );
        },
      }),
      // Secondary: human opens — always an estimate (MPP makes opens unreliable).
      columnHelper.accessor((row) => row.engagement?.human_opens ?? -1, {
        id: 'human_opens',
        header: rightHeader('Opens (human)'),
        size: 160,
        cell: (info) => {
          const eng = info.row.original.engagement;
          if (!eng) return <div className="flex justify-end"><CellSpin /></div>;
          if (eng.sent === 0 || eng.human_opens == null) return <RightDash />;
          const t = info.row.original.opensTrend;
          return (
            <div title={`Estimated human opens — MPP hides most real opens (${eng.human_source})`}>
              <MetricCell pctText={`~${pct(eng.human_opens, eng.delivered)}`} dir={t} count={fmtNum(eng.human_opens)} dimPct />
            </div>
          );
        },
      }),
      // Primary engagement metric: human clicks (reliable, MPP-proof).
      columnHelper.accessor((row) => row.engagement?.human_clicks ?? -1, {
        id: 'human_clicks',
        header: rightHeader('Clicks (human)'),
        size: 150,
        cell: (info) => {
          const eng = info.row.original.engagement;
          if (!eng) return <div className="flex justify-end"><CellSpin /></div>;
          if (eng.sent === 0 || eng.human_clicks == null) return <RightDash />;
          const est = eng.human_source === 'estimate';
          const t = info.row.original.clicksTrend;
          return (
            <div title={est ? 'Estimated (clicks × measured human-click rate)' : 'Measured (clicks minus detected scanners)'}>
              <MetricCell pctText={pct(eng.human_clicks, eng.delivered)} dir={t} count={fmtNum(eng.human_clicks)} />
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        size: 56,
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
                label: info.row.original.publish_state === 'published' ? 'Re-publish' : 'Publish',
                icon: <CloudArrowUpIcon className="size-4" />,
                onClick: () => handlePublishEdition(info.row.original),
              },
              ...(info.row.original.publish_state === 'published'
                ? [{
                    label: 'Make Draft',
                    icon: <ArrowUturnLeftIcon className="size-4" />,
                    onClick: () => handleMakeDraft(info.row.original),
                  }]
                : []),
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
    [navigate, loadEditions, newsletterTypes.length, newsletterId, selectedType]
  );

  const filteredEditions = useMemo(() => {
    const base = selectedType ? editions.filter(e => e.collection_id === selectedType) : editions;
    // `editions` is date-desc, so the next index is the chronologically-PREVIOUS
    // (older) edition. Compare engagement RATES (per delivered) so list-size
    // growth doesn't dominate, and annotate each edition with up/down trend.
    const rate = (e: Edition, key: 'human_clicks' | 'human_opens'): number | null => {
      const eng = e.engagement;
      if (!eng || !eng.delivered || eng[key] == null) return null;
      return (eng[key] as number) / eng.delivered;
    };
    const trend = (cur: number | null, prev: number | null): 'up' | 'down' | null => {
      if (cur == null || prev == null) return null;
      if (cur > prev) return 'up';
      if (cur < prev) return 'down';
      return null;
    };
    return base.map((e, i) => {
      const older = base[i + 1];
      const sentOf = (x?: Edition) => (x?.engagement?.sent ? x.engagement.sent : null);
      return {
        ...e,
        sentTrend: trend(sentOf(e), older ? sentOf(older) : null),
        clicksTrend: trend(rate(e, 'human_clicks'), older ? rate(older, 'human_clicks') : null),
        opensTrend: trend(rate(e, 'human_opens'), older ? rate(older, 'human_opens') : null),
      };
    });
  }, [editions, selectedType]);

  const table = useReactTable({
    data: filteredEditions,
    columns,
    state: {
      sorting,
      globalFilter,
      expanded,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    initialState: {
      pagination: {
        pageSize: PAGE_SIZE,
      },
    },
  });


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
        <DataTable
          table={table}
          loading={loading}
          onRowDoubleClick={(edition) => handleEdit(edition.id)}
          renderSubComponent={(row: Row<Edition>) => <EngagementDetail edition={row.original} />}
        />

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
