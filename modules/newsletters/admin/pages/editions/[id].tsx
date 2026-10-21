import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { builtinWrapperFor } from '../../../lib/plain-email/wrapper.js';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import {
  Cog6ToothIcon,
  PencilSquareIcon,
  PaperAirplaneIcon,
  RectangleGroupIcon,
  DocumentTextIcon,
  ChatBubbleLeftRightIcon,
  ChartBarIcon,
  CheckBadgeIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Badge, WorkspaceLayout } from '@/components/ui';
import { ContentAccessControl } from '@/components/content-access/ContentAccessControl';
import type { Tab } from '@/components/ui/Tabs';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { NewsletterCanvasEditor } from '../../components/puck/NewsletterCanvasEditor';
import { EditionSendingTab } from '../../components/EditionSendingTab';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { useEditionPresence } from '../../hooks/useEditionPresence';
import { stripStorageUrlsInJson, resolveStoragePathsInJson } from '@gatewaze/shared';
import {
  type NewsletterEdition,
  type EditionBlock,
  type BlockTemplate,
  type BrickTemplate,
} from '../../utils';
import { researchBindingOf, withBindingHashes } from '../../lib/research-block';
import { applyResearchReplacements, diffResearchOnly, type SnapshotBlock } from '../../lib/research-conflict';
import { ResearchPanel } from '../../components/ResearchPanel';
import { GDocFillDialog, GDocFillButton } from '../../components/GDocFillDialog';
import { applyGdocMerge, type GdocChange, type GdocChoice } from '../../lib/gdoc-merge';
import { EditionApprovalShell } from '../../components/EditionApprovalShell';
import { useAdminScope } from '@/hooks/usePermissions';
import { researchService } from '../../utils/researchService';
import { exportEditionHtml } from '../../components/puck/email-blocks/export-edition-html';
import { getViewOnlineUrl } from '../../utils/view-online-url';
import { publicSupabaseUrl } from '../../utils/publicSupabaseUrl';
import { buildEmailRegistry } from '../../components/puck/email-blocks/declarative/registry';
import { asEditionSkeleton, buildSkeletonBlocks, type SkeletonBlockDef } from '../../lib/editionSkeleton';
import { emailBlockRegistry } from '../../components/puck/email-blocks';
import type { BlockRenderMeta } from '../../components/puck/email-blocks/EditionEmail';
import {
  readDraft, writeDraft, clearDraft, draftFingerprint,
  type EditionDraftPayload, type StoredDraft,
} from '../../hooks/useEditionDraft';

/** The serialisable slice of an edition we mirror to the local draft. */
function toDraftPayload(ed: NewsletterEdition): EditionDraftPayload {
  return {
    subject: ed.subject ?? '',
    preheader: (ed as { preheader?: string }).preheader ?? '',
    edition_date: ed.edition_date ?? '',
    blocks: (ed.blocks ?? []) as unknown[],
  };
}

/** True when a save failed because the auth session is gone (expired/invalid). */
function isAuthError(err: unknown): boolean {
  const e = err as { code?: string; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 401 || e.code === 'PGRST301' || e.code === '42501') return true;
  return /jwt (expired|invalid)|not authori[sz]ed|invalid.*(token|claim)|auth session (missing|expired)|401/i.test(
    e.message || '',
  );
}

/** Shape of a templates_block_defs row, with `block_type` aliased from `key`. */
interface DbBlockTemplate {
  id: string;
  name: string;
  /** Aliased from templates_block_defs.key in the SELECT. */
  block_type: string;
  description: string | null;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  has_bricks: boolean;
  sort_order: number;
  /** Routing hint for the send-time renderer. `declarative` blocks (body_section,
   * intro_paragraph, email_only_intro etc.) are html-ish source files in the
   * git template repos — they MUST go through the declarative renderer, not
   * mustache substitution, or `<richtext field="x">`/`<Text if>` directives
   * survive into the rendered HTML as raw unknown elements and silently drop
   * their bound content. Was missing from this interface (and from the SELECT
   * below) which is why 7772 chars of body_section description rendered as
   * nothing on the 2026-06-23 send. */
  render_kind?: 'mustache' | 'react-email' | 'declarative' | null;
  component_id?: string | null;
  /** 'research' when `data_source` is a research binding (spec §5.1). */
  source_kind?: string | null;
  data_source?: unknown;
  /** Stamped after load by withBindingHashes; the edit layer records it. */
  binding_hash?: string;
}

interface DbBrickTemplate {
  id: string;
  name: string;
  /** Aliased from templates_brick_defs.key. */
  brick_type: string;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  block_def_id: string;
  sort_order: number;
}

interface DbEditionBlock {
  id: string;
  edition_id: string;
  /** FK to templates_block_defs.id (after PR 16.b). */
  templates_block_def_id: string | null;
  block_type: string;
  content: Record<string, unknown>;
  sort_order: number;
  block_template: DbBlockTemplate | null;
}

/** Edition-level columns the conflict handler compares (see tryAdoptResearchChanges). */
interface ServerEditionMeta {
  title: string | null;
  preheader: string | null;
  edition_date: string | null;
  send_target_at: string | null;
  research_at: string | null;
}

/** timestamptz round-trips in different ISO spellings; compare instants. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Date.parse(a) === Date.parse(b);
}

/** ISO → the value an <input type="datetime-local"> wants (local wall time). */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value → ISO, or null when blank/invalid. */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface DbEditionBrick {
  id: string;
  block_id: string;
  /** FK to templates_brick_defs.id (after PR 16.b). */
  templates_brick_def_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  brick_template: DbBrickTemplate;
}

interface CollectionInfo {
  id: string;
  name: string;
  slug: string;
  accent_color: string | null;
  content_category: string | null;
  list_id: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  metadata: Record<string, unknown>;
  list_name?: string | null;
  subscriber_count?: number;
  view_online_target?: string | null;
  view_online_external_base_url?: string | null;
  /** Declarative wrapper template (latest is_current row in templates_wrappers
   *  for the collection's library, key='default'). Resolved at fetch time. */
  wrapperTemplate?: string | null;
}

type EditionTab = 'details' | 'editor' | 'sending';

/**
 * `approvalMode`: the approver's view (route newsletters/approve/:id). The same
 * loading, saving and conflict handling as the editor, rendered as a
 * full-screen canvas + fields with Approve / Ask for changes, and no way into
 * the rest of the editor.
 */
export default function EditionEditorPage({ approvalMode = false }: { approvalMode?: boolean } = {}) {
  const { id, tab: tabFromUrl, slug: newsletterSlug } = useParams<{ id: string; tab?: string; slug?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const hasBulkEmailing = useHasModule('bulk-emailing');
  const { isSuperAdmin } = useAdminScope();
  // Bumped to remount the canvas after content is replaced from outside it
  // (Google Doc fill): Puck reads `data` only when it mounts.
  const [canvasKey, setCanvasKey] = useState(0);
  const [gdocOpen, setGdocOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edition, setEdition] = useState<NewsletterEdition | null>(null);
  // Optimistic-lock counter: the newsletters_editions.version we loaded. Sent
  // with each save so newsletters_save_edition can reject a stale write (a
  // second tab / session / any writer that changed the edition since we loaded)
  // instead of silently clobbering it. Updated from the RPC result on success.
  const editionVersionRef = useRef<number>(0);
  // Other operators currently in this edition (realtime presence). Drives the
  // "also editing" banner; the optimistic lock is what actually prevents a clobber.
  const presencePeers = useEditionPresence(edition?.id ?? null);
  // Local-draft recovery: a stored draft that differs from the loaded server
  // state (unsaved edits from a prior session), and whether the auth session
  // has expired mid-edit (drives the "signed out" banner). loadedSnapshotRef is
  // the fingerprint of the last clean (server-synced) state — drift means the
  // in-memory edits haven't been persisted.
  const [pendingDraft, setPendingDraft] = useState<StoredDraft | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const loadedSnapshotRef = useRef<string>('');
  const draftCheckedRef = useRef(false);
  // The blocks and edition columns as the SERVER last had them (stored shape:
  // relative storage paths), refreshed on load and after every successful
  // save. On version_conflict the handler diffs a refetch against this: when
  // the only differences are research blocks' research field / edit layer (a
  // run or a research-edit landed), those fields are adopted and the save is
  // retried with the author's dirty state intact (spec §5.2). Anything else
  // falls back to the reload toast.
  const serverBlocksRef = useRef<SnapshotBlock[]>([]);
  const serverMetaRef = useRef<ServerEditionMeta>({ title: null, preheader: null, edition_date: null, send_target_at: null, research_at: null });
  // Latest edition state for callbacks that outlive a render (ResearchPanel).
  const editionRef = useRef<NewsletterEdition | null>(null);
  // newsletters_effective_research_at as the server computes it (GET research route).
  const [effectiveResearchAt, setEffectiveResearchAt] = useState<string | null>(null);
  const [blockTemplates, setBlockTemplates] = useState<(DbBlockTemplate & BlockTemplate)[]>([]);
  const [brickTemplates, setBrickTemplates] = useState<BrickTemplate[]>([]);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [collectionMetadata, setCollectionMetadata] = useState<Record<string, unknown>>({});

  // The set of registry component_ids to surface (production opt-in pattern).
  // MUST be a stable reference: it feeds NewsletterPuckCanvas's `config`
  // useMemo, and a fresh array each render rebuilds the Puck config on every
  // keystroke — remounting every block and dropping inline-editor focus after
  // one character. Memoise on the only inputs that actually change it.
  //   - react-email blocks surface by component_id; declarative (git-authored)
  //     blocks surface by block_type (the combiner registers them under it).
  //   - Slots render their bricks via the registry too, so include brick
  //     component_ids (brick_type === registry key) or they'd be filtered out.
  // Empty → undefined, so the merge helper falls back to the full registry.
  const enabledRegistryComponentIds = useMemo<string[] | undefined>(() => {
    const blockIds = (blockTemplates as Array<{ render_kind?: string; component_id?: string | null; block_type?: string }>)
      .filter((t) => t.render_kind === 'react-email' || t.render_kind === 'declarative')
      .map((t) => t.component_id || t.block_type || '')
      .filter((id): id is string => id.length > 0);
    if (blockIds.length === 0) return undefined;
    const brickIds = (brickTemplates as Array<{ brick_type?: string }>)
      .map((b) => b.brick_type)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
    return [...new Set([...blockIds, ...brickIds])];
  }, [blockTemplates, brickTemplates]);

  // Pin the editor wrapper to the available viewport space below the
  // hero + tab bar. Hard-coding a calc() offset (e.g. `100vh - 220px`)
  // breaks whenever the chrome above changes height; measure the
  // wrapper's top with a ref instead and set its height = viewport
  // bottom - top. Updates on resize. Using ResizeObserver on the
  // wrapper itself catches the case where the hero grows (long
  // subject line wraps to two lines, etc.).
  const editorWrapperRef = useRef<HTMLDivElement | null>(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  useEffect(() => {
    function measure() {
      const el = editorWrapperRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      // Visual viewport when available — handles mobile address bars
      // / iframes that don't reflect their height in window.innerHeight.
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      // Bottom gutter so the panel doesn't touch the viewport edge
      // — feels less like the canvas is being clipped and gives the
      // Puck viewport-controls row + status chrome space to breathe.
      // 8px wasn't enough; the operator reported the editor reading
      // as slightly too tall.
      const bottomGutter = 32;
      const next = Math.max(320, Math.floor(viewportH - top - bottomGutter));
      setEditorHeight((cur) => (cur !== next ? next : cur));
    }
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && editorWrapperRef.current) ro.observe(editorWrapperRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  const validTabs: EditionTab[] = ['editor', 'details', ...(hasBulkEmailing ? ['sending' as EditionTab] : [])];
  const defaultTab: EditionTab = 'editor';
  const activeTab: EditionTab = approvalMode ? 'editor' : validTabs.includes(tabFromUrl as EditionTab) ? (tabFromUrl as EditionTab) : defaultTab;

  const handleTabChange = (tab: string) => {
    const basePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
    navigate(`${basePath}/${id}/${tab}`, { replace: true });
  };

  const loadCollection = useCallback(async (cId: string): Promise<Record<string, unknown> | null> => {
    const { data } = await supabase
      .from('newsletters_template_collections')
      .select('*')
      .eq('id', cId)
      .single();

    if (data) {
      const collInfo: CollectionInfo = { ...data };
      const metadata = {
        ...(data.metadata || {}),
        from_name: data.from_name || null,
        from_email: data.from_email || null,
      };
      setCollectionMetadata(metadata);

      if (data.list_id) {
        try {
          const { data: listData, error: listErr } = await supabase.from('lists').select('name').eq('id', data.list_id).single();
          if (listErr) {
            console.warn('[newsletter] Failed to load list:', listErr.message);
          } else if (listData) {
            collInfo.list_name = listData.name;
            const { count, error: countErr } = await supabase.from('list_subscriptions').select('id', { count: 'exact', head: true }).eq('list_id', data.list_id).eq('subscribed', true);
            if (countErr) console.warn('[newsletter] Failed to count subscribers:', countErr.message);
            collInfo.subscriber_count = count || 0;
          }
        } catch (err) {
          console.warn('[newsletter] Lists module may not be installed:', err);
        }
      }

      // Resolve the declarative wrapper template (templates_wrappers row,
      // key='default', is_current=true) for this newsletter's library. Single
      // source of truth for header/footer chrome across editor preview, email
      // send, and git publish.
      // A built-in wrapper chosen in the publication's metadata takes
      // precedence over the repo's wrappers/default.html (lib/plain-email).
      const builtin = builtinWrapperFor(data.metadata as Record<string, unknown> | null);
      if (builtin) {
        collInfo.wrapperTemplate = builtin;
      } else {
        try {
          const { data: wr } = await supabase
            .from('templates_wrappers')
            .select('html')
            .eq('library_id', cId)
            .eq('key', 'default')
            .eq('is_current', true)
            .maybeSingle();
          collInfo.wrapperTemplate = (wr?.html as string | undefined) ?? null;
        } catch {
          collInfo.wrapperTemplate = null;
        }
      }

      setCollection(collInfo);
      return data.metadata as Record<string, unknown> | null;
    }
    return null;
  }, []);

  const loadTemplates = useCallback(async (filterCollectionId?: string | null) => {
    try {
      // Aliases: templates_block_defs.key → block_type so the consumer-facing
      // shape stays stable. sort_order isn't on templates_block_defs (no
      // library-wide ordering); we fall back to ordering by `key`.
      // is_current=true is required: templates_apply_source soft-deletes
      // pruned rows by flipping is_current to false (it keeps history for the
      // audit trail). Without this filter, every template-repo update that
      // drops a block would leave a stale row in the palette as a phantom.
      let blocksQuery = supabase
        .from('templates_block_defs')
        .select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, source_kind, data_source, block_type:key')
        .eq('is_current', true)
        .order('key');
      // Bricks: filter by parent block_def's library via inner-embed join.
      let bricksQuery = supabase
        .from('templates_brick_defs')
        .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key, render_kind, component_id, templates_block_defs!inner(library_id)')
        .eq('is_current', true)
        .order('sort_order');
      if (filterCollectionId) {
        blocksQuery = blocksQuery.eq('library_id', filterCollectionId);
        bricksQuery = bricksQuery.eq('templates_block_defs.library_id', filterCollectionId);
      }
      const [blocksRes, bricksRes] = await Promise.all([blocksQuery, bricksQuery]);
      if (blocksRes.error) throw blocksRes.error;
      if (bricksRes.error) throw bricksRes.error;
      // The DB rows have flat columns (schema, html, rich_text_template,
      // has_bricks); the canvas-facing BlockTemplate / BrickTemplate
      // shape nests them under `.content` (and renames html →
      // html_template). Adapt at the boundary so NewsletterPuckCanvas's
      // `t.content.schema` etc. resolve. Before any git source was
      // connected the result set was empty and the map never ran, so
      // this latent mismatch only surfaces once real rows exist.
      // Research blocks (source_kind='research') get their binding hash once
      // here; the Puck adapter and the registry read it off the template.
      const adaptedBlocks = await withBindingHashes((blocksRes.data ?? []).map((r) => ({
        ...r,
        content: {
          html_template: r.html ?? '',
          rich_text_template: r.rich_text_template ?? null,
          has_bricks: r.has_bricks ?? false,
          schema: r.schema ?? {},
        },
      })));
      const adaptedBricks = (bricksRes.data ?? []).map((r) => ({
        ...r,
        content: {
          html_template: r.html ?? '',
          rich_text_template: r.rich_text_template ?? null,
          schema: r.schema ?? {},
        },
      }));
      setBlockTemplates(adaptedBlocks);
      setBrickTemplates(adaptedBricks);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast.error('Failed to load templates');
    }
  }, []);

  const loadEdition = useCallback(async () => {
    if (isNew) {
      const collParam = searchParams.get('collection');
      if (!collParam) { toast.error('Please select a template first'); navigate(newsletterSlug ? `/newsletters/${newsletterSlug}` : '/newsletters'); return; }
      setCollectionId(collParam);
      const meta = await loadCollection(collParam);
      // Apply the newsletter-level default edition template if set.
      // The Default Edition Template card on the newsletter detail
      // page persists the chosen slug to
      // newsletters_template_collections.metadata.default_edition_template_slug.
      // We resolve it here so a new edition starts with the same
      // layout edition-after-edition without the operator clicking
      // anything per-edition.
      const slug = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>).default_edition_template_slug : undefined);
      let initialBlocks: NewsletterEdition['blocks'] = [];
      // The template repo's edition.json (stored on the library by the
      // templates ingest) wins over the platform starter: it names the
      // publication's own blocks in the running order its editor uses
      // every week.
      try {
        initialBlocks = await seedFromTemplateSkeleton(collParam);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[edition-new] failed to seed from the template repo skeleton:', e);
      }
      if (initialBlocks.length === 0 && typeof slug === 'string' && slug.length > 0) {
        try {
          const { ALL_STARTERS } = await import('../../components/puck/starter-templates/index.js');
          const starter = ALL_STARTERS.find((s) => s.slug === slug);
          if (starter) {
            initialBlocks = starter.blocks.map((b, idx) => ({
              id: freshUuid(),
              block_template: {
                id: '',
                name: b.type,
                block_type: b.type,
                content: { html_template: '', schema: {}, has_bricks: false },
              },
              content: stampIdsRecursive({ ...b.props }),
              sort_order: (idx + 1) * 1000,
              bricks: [],
            } as never));
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[edition-new] failed to apply default template:', e);
        }
      }
      setEdition({ id: 'new', edition_date: new Date().toISOString().split('T')[0], subject: '', preheader: '', blocks: initialBlocks });
      setLoading(false);
      return;
    }

    try {
      const { data: editionData, error: editionError } = await supabase.from('newsletters_editions').select('*').eq('id', id).single();
      if (editionError) throw editionError;
      // Track the loaded version for optimistic-locked saves (0 if the column
      // isn't present yet — pre-migration environments still save fine).
      editionVersionRef.current = typeof editionData.version === 'number' ? editionData.version : 0;

      if (editionData.collection_id) {
        setCollectionId(editionData.collection_id);
        await loadCollection(editionData.collection_id);
      }

      const { data: blocksData, error: blocksError } = await supabase
        .from('newsletters_edition_blocks')
        .select('*, block_template:templates_block_defs!templates_block_def_id(id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, source_kind, data_source, block_type:key)')
        .eq('edition_id', id)
        .is('deleted_at', null)   // exclude soft-deleted blocks (migration 069)
        .order('sort_order');
      if (blocksError) throw blocksError;

      // Binding hash per research block def (once per def id). The edit layer
      // records the hash it was made against; renderers resolve with it.
      const hashedDefs = await withBindingHashes(
        ((blocksData || []) as DbEditionBlock[]).map((b) => b.block_template).filter((t): t is DbBlockTemplate => !!t),
      );
      const bindingHashById = new Map(hashedDefs.filter((t) => t.binding_hash).map((t) => [t.id, t.binding_hash!]));

      // Server snapshot for the version_conflict handler (stored shape).
      serverBlocksRef.current = ((blocksData || []) as DbEditionBlock[]).map((b) => ({
        id: b.id,
        content: (b.content ?? {}) as Record<string, unknown>,
        sort_order: b.sort_order,
        templates_block_def_id: b.templates_block_def_id ?? null,
      }));
      serverMetaRef.current = {
        title: editionData.title ?? null,
        preheader: editionData.preheader ?? null,
        edition_date: editionData.edition_date ?? null,
        send_target_at: editionData.send_target_at ?? null,
        research_at: editionData.research_at ?? null,
      };

      const blockIds = (blocksData || []).map((b: DbEditionBlock) => b.id);
      let bricksData: DbEditionBrick[] = [];
      if (blockIds.length > 0) {
        const { data: bricks, error: bricksError } = await supabase
          .from('newsletters_edition_bricks')
          .select('*, brick_template:templates_brick_defs!templates_brick_def_id(id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key, render_kind, component_id)')
          .in('block_id', blockIds)
          .is('deleted_at', null)   // exclude soft-deleted bricks (migration 069)
          .order('sort_order');
        if (bricksError) throw bricksError;
        bricksData = bricks || [];
      }

      // loadTemplates already adapts flat DB rows (`schema`, `html`,
      // `has_bricks`) into the canvas-facing `.content` nested shape.
      // The edition's joined `block_template` / `brick_template` come
      // out of `select('*, block_template:templates_block_defs!…(…)')`
      // with the same flat columns and need the same adaptation —
      // otherwise editionToPuckData throws on
      // `b.block_template.content.has_bricks` (undefined.has_bricks)
      // the moment an edition has at least one saved block. The
      // loadTemplates fix (f800d20) missed this twin call site.
      const adaptBlockTemplate = (r: DbBlockTemplate): BlockTemplate => ({
        ...r,
        ...(bindingHashById.has(r.id) ? { binding_hash: bindingHashById.get(r.id)! } : {}),
        content: {
          html_template: r.html ?? '',
          rich_text_template: r.rich_text_template ?? null,
          has_bricks: r.has_bricks ?? false,
          schema: r.schema ?? {},
        },
      } as unknown as BlockTemplate);
      const adaptBrickTemplate = (r: DbBrickTemplate): BrickTemplate => ({
        ...r,
        content: {
          html_template: r.html ?? '',
          rich_text_template: r.rich_text_template ?? null,
          schema: r.schema ?? {},
        },
      } as unknown as BrickTemplate);

      // Content is persisted with RELATIVE storage paths (stripStorageUrlsInJson
      // runs on save, below). Resolve them back to full public URLs for the
      // editor — including `<img src>` inside rich-text HTML — so images render
      // in the canvas. Save strips them again, keeping the DB env-portable.
      // The same resolved content is rendered into the HTML that is sent and
      // published, so it uses the real Supabase URL, not the host-session
      // admin origin.
      const bucketUrl = `${publicSupabaseUrl()}/storage/v1/object/public/media`;
      setEdition({
        id: editionData.id,
        edition_date: editionData.edition_date,
        subject: editionData.title || '',
        preheader: editionData.preheader || '',
        status: editionData.status,
        send_target_at: editionData.send_target_at ?? null,
        research_at: editionData.research_at ?? null,
        blocks: (blocksData || []).map((block: DbEditionBlock) => ({
          id: block.id,
          // Per spec-builder-evaluation §3.6 (extended). When the row has
          // no joined block_template (registry-driven block — saved with
          // templates_block_def_id=NULL), synthesise a BlockTemplate
          // shaped like a Mustache one but with `id: ''` so the editor
          // recognises it as a registry block. The downstream Puck
          // adapter looks up `block_type` (= the registry componentId)
          // against the registry to mount the right JSX component.
          block_template: block.block_template
            ? adaptBlockTemplate(block.block_template)
            : {
                id: '',
                name: block.block_type,
                block_type: block.block_type,
                content: { html_template: '', schema: {}, has_bricks: false },
              },
          content: resolveStoragePathsInJson(block.content || {}, bucketUrl),
          sort_order: block.sort_order,
          bricks: bricksData
            .filter((brick: DbEditionBrick) => brick.block_id === block.id)
            .map((brick: DbEditionBrick) => ({
              id: brick.id,
              brick_template: brick.brick_template ? adaptBrickTemplate(brick.brick_template) : brick.brick_template,
              content: resolveStoragePathsInJson(brick.content || {}, bucketUrl),
              sort_order: brick.sort_order,
            })),
        })),
      });
    } catch (error) {
      console.error('Error loading edition:', error);
      toast.error('Failed to load edition');
      navigate(newsletterSlug ? `/newsletters/${newsletterSlug}` : '/newsletters');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate, searchParams, loadCollection, newsletterSlug]);

  useEffect(() => { loadEdition(); }, [loadEdition]);
  useEffect(() => { if (collectionId) loadTemplates(collectionId); }, [collectionId, loadTemplates]);
  editionRef.current = edition;

  const hasResearchBlocks = useMemo(() => (edition?.blocks ?? []).some((b) => researchBindingOf(b.block_template) !== null), [edition]);
  // Block id → label, for the Sending tab's research send-gate message.
  const blockNames = useMemo(
    () => Object.fromEntries((edition?.blocks ?? []).map((b) => [b.id, b.block_template.name || b.block_template.block_type])),
    [edition?.blocks],
  );

  // The server-derived research time for the Details tab (coalesce(research_at,
  // send_target_at - lead)). Fetched from the research route so the UI and
  // the cron agree; refreshed after each save.
  const refreshEffectiveResearchAt = useCallback(async (editionId: string) => {
    if (!editionId || editionId === 'new') return;
    try {
      const r = await researchService.edition(editionId);
      setEffectiveResearchAt(r.effective_research_at);
    } catch {
      setEffectiveResearchAt(null);
    }
  }, []);
  useEffect(() => {
    if (activeTab === 'details' && edition?.id && edition.id !== 'new') void refreshEffectiveResearchAt(edition.id);
  }, [activeTab, edition?.id, refreshEffectiveResearchAt]);

  /**
   * version_conflict handler, spec §5.2: refetch the edition and its blocks
   * and compare with the server snapshot we hold. When the only differences
   * are research blocks' research layer and/or edit layer, adopt those fields
   * into the in-memory blocks (keeping every other dirty field), adopt the
   * new version, and return the updated edition for a retry. Returns null
   * when anything else changed — the caller then shows the reload toast.
   */
  const tryAdoptResearchChanges = useCallback(async (base?: NewsletterEdition): Promise<NewsletterEdition | null> => {
    const cur = base ?? editionRef.current;
    if (!cur || cur.id === 'new') return null;
    const [{ data: ed }, { data: rows }] = await Promise.all([
      supabase.from('newsletters_editions').select('version, title, preheader, edition_date, send_target_at, research_at').eq('id', cur.id).maybeSingle(),
      supabase.from('newsletters_edition_blocks').select('id, content, sort_order, templates_block_def_id').eq('edition_id', cur.id).is('deleted_at', null).order('sort_order'),
    ]);
    if (!ed || !rows) return null;
    const meta = serverMetaRef.current;
    if ((ed.title ?? null) !== meta.title || (ed.preheader ?? null) !== meta.preheader || (ed.edition_date ?? null) !== meta.edition_date
      || !sameInstant(ed.send_target_at, meta.send_target_at) || !sameInstant(ed.research_at, meta.research_at)) {
      console.info('[edition] version_conflict: edition columns changed elsewhere; not adopting');
      return null;
    }
    const researchFieldByBlock: Record<string, string> = {};
    for (const b of cur.blocks) {
      const binding = researchBindingOf(b.block_template);
      if (binding) researchFieldByBlock[b.id] = binding.output.field;
    }
    const fresh = (rows as SnapshotBlock[]).map((r) => ({ ...r, content: (r.content ?? {}) as Record<string, unknown> }));
    const diff = diffResearchOnly(serverBlocksRef.current, fresh, researchFieldByBlock);
    if (!diff.only_research) {
      console.info('[edition] version_conflict: not research-only —', diff.reason);
      return null;
    }
    const bucketUrl = `${publicSupabaseUrl()}/storage/v1/object/public/media`;
    const next: NewsletterEdition = {
      ...cur,
      blocks: applyResearchReplacements(cur.blocks, diff.replacements, (v) => resolveStoragePathsInJson(v, bucketUrl)),
    };
    serverBlocksRef.current = fresh;
    if (typeof ed.version === 'number') editionVersionRef.current = ed.version;
    setEdition(next);
    return next;
  }, []);

  /** The Research panel wrote the edit layer through its RPC: mirror it in state and the server snapshot, adopt the version. */
  const handleResearchEditsWritten = useCallback((blockId: string, edits: Record<string, unknown>, newVersion: number) => {
    editionVersionRef.current = newVersion;
    serverBlocksRef.current = serverBlocksRef.current.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, research_edits: edits } } : b));
    setEdition((prev) => prev ? {
      ...prev,
      blocks: prev.blocks.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, research_edits: edits } } : b)),
    } : prev);
  }, []);

  const renderBlockSidebarExtra = useCallback((block: EditionBlock) => {
    const cur = editionRef.current;
    if (!cur || !researchBindingOf(block.block_template)) return null;
    return (
      <ResearchPanel
        editionId={cur.id}
        editionStatus={cur.status}
        block={block}
        getVersion={() => editionVersionRef.current}
        onEditsWritten={handleResearchEditsWritten}
        onResearchChanged={async () => (await tryAdoptResearchChanges()) !== null}
      />
    );
  }, [handleResearchEditsWritten, tryAdoptResearchChanges]);

  // Once the edition is loaded, baseline the clean fingerprint and check for a
  // recoverable local draft (unsaved edits a prior session couldn't persist —
  // e.g. after an auth expiry). Runs once per mount.
  useEffect(() => {
    if (loading || !edition || edition.id === 'new' || draftCheckedRef.current) return;
    draftCheckedRef.current = true;
    const serverFp = draftFingerprint(toDraftPayload(edition));
    loadedSnapshotRef.current = serverFp;
    const existing = readDraft(edition.id);
    if (existing && draftFingerprint(existing.payload) !== serverFp) {
      setPendingDraft(existing);
    }
  }, [loading, edition]);

  // Mirror edits to a local draft (debounced). Skipped while a recoverable
  // draft is still pending a decision (don't clobber it) and when nothing has
  // changed since the last server sync.
  useEffect(() => {
    if (!edition || edition.id === 'new' || pendingDraft) return;
    const fp = draftFingerprint(toDraftPayload(edition));
    if (fp === loadedSnapshotRef.current) return;
    const editionId = edition.id;
    // Re-check when the timer fires: a save that finished inside the 800ms
    // (the Google Doc fill saves straight away) has already cleared the draft
    // and moved the clean baseline, so writing now would leave a stale draft
    // and a false "unsaved changes" banner on the next load.
    const t = setTimeout(() => {
      if (draftFingerprint(toDraftPayload(edition)) === loadedSnapshotRef.current) return;
      writeDraft(editionId, toDraftPayload(edition), Date.now());
    }, 800);
    return () => clearTimeout(t);
  }, [edition, pendingDraft]);

  // Auto-create the DB row for a fresh edition as soon as loadEdition
  // finishes building the in-memory state. Without this, the row only
  // exists once the operator clicks "Save Draft" — which means the
  // /editions/new route renders with edition.id === 'new', and any
  // feature that reads from newsletters_editions (AI copilot's
  // generate endpoint, publish-to-git, sends) 404s until the first
  // explicit save. handleSave({ silent: true }) flips edition.id to
  // the real uuid and replaces the URL via history.replaceState, so
  // the page doesn't remount and the operator's typing isn't
  // interrupted.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (
      isNew &&
      edition &&
      edition.id === 'new' &&
      collectionId &&
      !saving &&
      !autoCreatedRef.current
    ) {
      autoCreatedRef.current = true;
      void handleSave({ silent: true });
    }
  }, [isNew, edition, collectionId, saving]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Update path for an existing edition. Atomic, concurrency-controlled save
   * (migration 069's newsletters_save_edition). ONE RPC does: optimistic
   * version-check → snapshot current blocks into a revision → diff-upsert the
   * canvas blocks/bricks → soft-delete removed ones → bump version. This
   * replaces the old destructive "update edition, delete EVERY block,
   * re-insert one by one" — which was non-atomic (a mid-loop failure lost
   * blocks) and had no concurrency control (a stale tab / second session /
   * any writer silently clobbered newer content — the lost-update that wiped
   * edition 21afd12a). Empty-id template refs map to NULL exactly as before
   * (registry blocks carry no block_def row).
   *
   * On version_conflict (55006) with `allowRetry`, tryAdoptResearchChanges
   * refetches: when only research blocks' research field / edit layer moved
   * (a run landed while the author typed), those fields are adopted, the
   * version is adopted, and the save runs once more with everything else
   * intact. Any other change throws the marked conflict error (reload toast).
   */
  const saveExisting = async (ed: NewsletterEdition, options: { silent?: boolean } | undefined, allowRetry: boolean): Promise<void> => {
    const payloadBlocks = ed.blocks.map((block) => ({
      id: block.id,
      block_type: block.block_template.block_type,
      templates_block_def_id:
        block.block_template.id && block.block_template.id !== '' ? block.block_template.id : null,
      content: stripStorageUrlsInJson(block.content),
      sort_order: block.sort_order,
      bricks: block.bricks.map((brick) => ({
        id: brick.id,
        brick_type: brick.brick_template.brick_type,
        templates_brick_def_id:
          brick.brick_template.id && brick.brick_template.id !== '' ? brick.brick_template.id : null,
        content: stripStorageUrlsInJson(brick.content),
        sort_order: brick.sort_order,
      })),
    }));
    const { data: saveResult, error: saveErr } = await supabase.rpc('newsletters_save_edition', {
      p_edition_id: ed.id,
      p_expected_version: editionVersionRef.current,
      p_title: ed.subject || 'Untitled',
      p_preheader: ed.preheader || null,
      p_content_category: collection?.content_category || null,
      p_edition_date: ed.edition_date,
      p_blocks: payloadBlocks,
    });
    if (saveErr) {
      // 55006 = version_conflict: the edition changed since we loaded it.
      const isConflict = saveErr.code === '55006' || /version_conflict/i.test(saveErr.message || '');
      if (isConflict) {
        if (allowRetry) {
          const adopted = await tryAdoptResearchChanges(ed);
          if (adopted) return saveExisting(adopted, options, false);
        }
        // Do NOT overwrite — keep the operator's in-memory work and tell them
        // to reload. Throw a marked error so callers know the save failed;
        // the catch in handleSave skips its generic toast for this case.
        toast.error(
          'This edition was changed elsewhere since you opened it. Reload to get the latest before saving — your current changes were NOT saved.',
          { duration: 12000 },
        );
        throw new Error('__edition_version_conflict__');
      }
      // Auth session died (expired/invalid JWT) — the save didn't persist.
      // Preserve the work locally and surface it loudly; NEVER swallow this,
      // even for a silent autosave (that's how Steve's edits were lost on
      // 2026-07-22).
      if (isAuthError(saveErr)) {
        writeDraft(ed.id, toDraftPayload(ed), Date.now());
        setSessionExpired(true);
        throw new Error('__edition_session_expired__');
      }
      console.error('Save edition error:', saveErr);
      throw saveErr;
    }
    // Advance our optimistic-lock counter to the just-written version so the
    // next save from this session doesn't self-conflict.
    const newVersion = (saveResult as { version?: number } | null)?.version;
    if (typeof newVersion === 'number') editionVersionRef.current = newVersion;

    // send_target_at / research_at (migration 092) are not parameters of
    // newsletters_save_edition, so they go by a direct write guarded on the
    // version the RPC just returned and bumping it, the same optimistic lock.
    // Zero rows matched means another writer got in between: say so rather
    // than overwrite.
    const wantSchedule = { send_target_at: ed.send_target_at ?? null, research_at: ed.research_at ?? null };
    if (!sameInstant(wantSchedule.send_target_at, serverMetaRef.current.send_target_at) || !sameInstant(wantSchedule.research_at, serverMetaRef.current.research_at)) {
      const v = editionVersionRef.current;
      const { data: upd, error: schedErr } = await supabase
        .from('newsletters_editions')
        .update({ ...wantSchedule, version: v + 1, updated_at: new Date().toISOString() })
        .eq('id', ed.id)
        .eq('version', v)
        .select('version');
      if (schedErr) throw schedErr;
      const row = (upd as Array<{ version: number }> | null)?.[0];
      if (!row) {
        toast.error('The send target / research time were not saved: the edition changed elsewhere. Reload and set them again.', { duration: 12000 });
      } else {
        editionVersionRef.current = row.version;
        serverMetaRef.current = { ...serverMetaRef.current, ...wantSchedule };
        void refreshEffectiveResearchAt(ed.id);
      }
    }

    // Saved — the server now holds this state; refresh the conflict snapshot,
    // the clean baseline, drop the local recovery draft and clear any prior
    // session-expired flag.
    serverBlocksRef.current = payloadBlocks.map((b) => ({ id: b.id, content: b.content as Record<string, unknown>, sort_order: b.sort_order, templates_block_def_id: b.templates_block_def_id }));
    serverMetaRef.current = {
      ...serverMetaRef.current,
      title: ed.subject || 'Untitled',
      preheader: ed.preheader || null,
      edition_date: ed.edition_date,
    };
    loadedSnapshotRef.current = draftFingerprint(toDraftPayload(ed));
    clearDraft(ed.id);
    if (sessionExpired) setSessionExpired(false);
    if (!options?.silent) toast.success('Edition saved');
  };

  // `options.edition` saves that state instead of the rendered one, for a
  // caller that has just computed the next edition (Google Doc fill) and
  // cannot wait for a re-render.
  const handleSave = async (options?: { silent?: boolean; edition?: NewsletterEdition }) => {
    // editionRef.current is the latest rendered state (set on every render).
    const edition = options?.edition ?? editionRef.current;
    if (!edition) return;
    setSaving(true);
    try {
      // Branch on the LIVE edition.id, not the route's `isNew` flag.
      // Auto-create uses history.replaceState() to swap /new → /<uuid>
      // without remounting (preserves iframe + selection); React Router
      // doesn't observe replaceState, so useParams keeps returning
      // `new` and `isNew` stays true even after the row exists. The
      // second handleSave call (e.g., from Publish → onSave) would
      // then re-INSERT the same edition + blocks and fail with
      // "duplicate key value violates unique constraint
      // newsletters_edition_blocks_pkey". `edition.id === 'new'` reads
      // the local state which we DO flip to the real uuid after a
      // successful auto-create.
      if (edition.id === 'new') {
        const { data: rows, error: createError } = await supabase
          .from('newsletters_editions')
          .insert({
            edition_date: edition.edition_date,
            title: edition.subject || 'Untitled',
            preheader: edition.preheader || null,
            content_category: collection?.content_category || null,
            status: 'draft',
            collection_id: collectionId,
            send_target_at: edition.send_target_at ?? null,
            research_at: edition.research_at ?? null,
          })
          .select();
        if (createError) throw createError;
        const newEdition = rows?.[0];
        if (!newEdition) throw new Error('Edition created but not returned — try saving again');

        for (const block of edition.blocks) {
          // Registry blocks/bricks (render_kind='react-email') carry a
          // synthesised template with id='' — see the update path below
          // for the full rationale. Normalize empty to NULL on both
          // levels so PG doesn't reject '' as an invalid uuid.
          const tplDefId = block.block_template.id && block.block_template.id !== ''
            ? block.block_template.id
            : null;
          const { data: blockRows, error: blockError } = await supabase
            .from('newsletters_edition_blocks')
            .insert({
              id: block.id,
              edition_id: newEdition.id,
              templates_block_def_id: tplDefId,
              block_type: block.block_template.block_type,
              content: stripStorageUrlsInJson(block.content),
              sort_order: block.sort_order,
            })
            .select();
          if (blockError) throw blockError;
          const newBlock = blockRows?.[0];
          if (newBlock) {
            for (const brick of block.bricks) {
              const brickDefId = brick.brick_template.id && brick.brick_template.id !== ''
                ? brick.brick_template.id
                : null;
              const { error: brickErr } = await supabase.from('newsletters_edition_bricks').insert({
                id: brick.id,
                block_id: newBlock.id,
                templates_brick_def_id: brickDefId,
                brick_type: brick.brick_template.brick_type,
                content: stripStorageUrlsInJson(brick.content),
                sort_order: brick.sort_order,
              });
              if (brickErr) throw brickErr;
            }
          }
        }

        if (options?.silent) {
          // Autosave: update URL without a full navigation so the
          // component tree stays mounted (preserves iframe, embed URL,
          // local state). Flip edition.id so subsequent saves go through
          // the UPDATE path instead of re-inserting.
          const edBasePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
          window.history.replaceState(null, '', `${edBasePath}/${newEdition.id}/editor`);
          setEdition(prev => prev ? { ...prev, id: newEdition.id } : prev);
        } else {
          toast.success('Edition created');
          const edBasePath = newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters/editor';
          navigate(`${edBasePath}/${newEdition.id}/editor`, { replace: true });
        }
      } else {
        await saveExisting(edition, options, true);
      }
    } catch (error) {
      // The version-conflict path already showed a specific toast — don't stack
      // the generic one on top.
      if ((error as Error)?.message === '__edition_version_conflict__') {
        setSaving(false);
        return;
      }
      // Session expired: work is preserved locally + the banner is up. Swallow
      // quietly — the banner is the message (no generic error toast).
      if ((error as Error)?.message === '__edition_session_expired__') {
        setSaving(false);
        return;
      }
      // A different auth-shaped failure (e.g. the create path, or a raw 401) —
      // preserve the draft + surface it rather than silently losing the work.
      if (isAuthError(error) && edition) {
        writeDraft(edition.id, toDraftPayload(edition), Date.now());
        setSessionExpired(true);
        setSaving(false);
        return;
      }
      console.error('Error saving edition:', error);
      if (!options?.silent) toast.error('Failed to save edition');
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const restoreDraft = () => {
    if (!pendingDraft || !edition) return;
    setEdition({
      ...edition,
      subject: pendingDraft.payload.subject,
      preheader: pendingDraft.payload.preheader,
      edition_date: pendingDraft.payload.edition_date,
      blocks: pendingDraft.payload.blocks as NewsletterEdition['blocks'],
    });
    setPendingDraft(null);
    toast.success('Restored your unsaved changes — save to sync them to the server.');
  };
  const discardDraft = () => {
    if (edition) clearDraft(edition.id);
    setPendingDraft(null);
  };
  const handleReLogin = () => {
    // The draft is already persisted locally; a full nav triggers the LFID SSO
    // round-trip. On return, the draft-recovery prompt restores the work.
    if (edition) writeDraft(edition.id, toDraftPayload(edition), Date.now());
    navigate('/login');
  };

  /**
   * Apply the author's choices from the Google Doc fill dialog, then save.
   * Unsaved edits are saved first so research edit layers (written by their
   * own versioned RPC, like the Research panel's) land on blocks that exist
   * and on the current version. Everything else goes through the normal save.
   */
  const applyGdocFill = async (changes: GdocChange[], choices: Record<string, GdocChoice>) => {
    if (!editionRef.current || editionRef.current.id === 'new') throw new Error('Save the edition first.');
    if (draftFingerprint(toDraftPayload(editionRef.current)) !== loadedSnapshotRef.current) {
      await handleSave({ silent: true });
      if (draftFingerprint(toDraftPayload(editionRef.current)) !== loadedSnapshotRef.current) {
        throw new Error('Your unsaved changes could not be saved. Save the edition, then try again.');
      }
    }
    const base = editionRef.current;
    const result = applyGdocMerge(base, changes, choices, blockTemplates as unknown as BlockTemplate[], freshUuid);
    let next = result.edition;
    for (const { blockId, edits } of result.researchEdits) {
      const { data, error } = await supabase.rpc('newsletters_research_edits_write', {
        p_block_id: blockId,
        p_edits: edits,
        p_expected_version: editionVersionRef.current,
      });
      if (error) {
        if (error.code === '55006' || /version_conflict/i.test(error.message || '')) {
          throw new Error('This edition was changed elsewhere. Reload it, then fill from the document again.');
        }
        throw error;
      }
      editionVersionRef.current = typeof data === 'number' ? data : editionVersionRef.current + 1;
      serverBlocksRef.current = serverBlocksRef.current.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, research_edits: edits } } : b));
      next = { ...next, blocks: next.blocks.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, research_edits: edits } } : b)) };
    }
    setEdition(next);
    editionRef.current = next;
    setCanvasKey((k) => k + 1);
    await handleSave({ edition: next, silent: true });
    if (draftFingerprint(toDraftPayload(next)) !== loadedSnapshotRef.current) {
      throw new Error('The content was applied but not saved. Save the edition to keep it.');
    }
    toast.success(`Filled ${result.applied} part${result.applied === 1 ? '' : 's'} of the edition from the document and saved.${result.skipped.length ? ` Not applied: ${result.skipped.join(', ')}.` : ''}`);
  };

  if (loading) {
    return <Page title="Loading..."><div className="flex items-center justify-center h-64"><LoadingSpinner /></div></Page>;
  }

  if (!edition) {
    return <Page title="Not Found"><div className="p-6 text-center text-[var(--gray-9)]">Edition not found</div></Page>;
  }

  // Presence / signed-out / unsaved-draft banners: shown by the editor and
  // by the approval view alike.
  const notices = (
    <>
        {presencePeers.length > 0 && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 14px', fontSize: 13,
              background: '#FEF3C7', color: '#92400E', borderBottom: '1px solid #FDE68A',
            }}
          >
            <span aria-hidden>👀</span>
            <span>
              {presencePeers.length === 1
                ? `${presencePeers[0].name} is also editing this edition`
                : `${presencePeers.length} other people are also editing this edition`}
              {' — your changes are protected, but coordinate to avoid conflicting saves.'}
            </span>
          </div>
        )}
        {sessionExpired && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', fontSize: 13, background: '#FEE2E2', color: '#991B1B', borderBottom: '1px solid #FCA5A5' }}>
            <span aria-hidden>⚠️</span>
            <span style={{ fontWeight: 600 }}>You&rsquo;ve been signed out.</span>
            <span>Your recent changes are saved on this device and will be restored after you sign in again — they were <strong>not</strong> saved to the server.</span>
            <button onClick={handleReLogin} style={{ marginLeft: 'auto', padding: '4px 12px', background: '#991B1B', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>
              Sign in again
            </button>
          </div>
        )}
        {pendingDraft && !sessionExpired && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', fontSize: 13, background: '#FEF3C7', color: '#92400E', borderBottom: '1px solid #FDE68A' }}>
            <span aria-hidden>💾</span>
            <span>Unsaved changes from {new Date(pendingDraft.savedAt).toLocaleString()} were found on this device (they never reached the server).</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={restoreDraft} style={{ padding: '4px 12px', background: '#92400E', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Restore</button>
              <button onClick={discardDraft} style={{ padding: '4px 12px', background: 'transparent', color: '#92400E', border: '1px solid #92400E', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}>Discard</button>
            </span>
          </div>
        )}
    </>
  );

  if (approvalMode) {
    // Save pending edits; true when the server now holds what is on screen.
    const ensureSaved = async (): Promise<boolean> => {
      const cur = editionRef.current;
      if (!cur) return false;
      if (draftFingerprint(toDraftPayload(cur)) !== loadedSnapshotRef.current) {
        await handleSave({ silent: true });
      }
      return !!editionRef.current && draftFingerprint(toDraftPayload(editionRef.current)) === loadedSnapshotRef.current;
    };
    return (
      <EditionApprovalShell
        editionId={edition.id}
        subject={edition.subject || ''}
        editionDate={edition.edition_date}
        newsletterName={collection?.name ?? null}
        saving={saving}
        // The baseline is recorded by an effect after the first render; until
        // then (empty) nothing can have been edited.
        dirty={loadedSnapshotRef.current !== '' && draftFingerprint(toDraftPayload(edition)) !== loadedSnapshotRef.current}
        onSave={async () => { await handleSave(); }}
        ensureSaved={ensureSaved}
        getVersion={() => editionVersionRef.current}
        notices={notices}
      >
        <NewsletterCanvasEditor
          edition={edition}
          blockTemplates={blockTemplates}
          brickTemplates={brickTemplates}
          collectionMetadata={collectionMetadata}
          wrapperTemplate={collection?.wrapperTemplate ?? null}
          viewOnlineUrl={getViewOnlineUrl(
            collection,
            { edition_date: edition.edition_date, subject: edition.subject, title: edition.title },
          )}
          {...(collectionId ? { collectionId } : {})}
          {...(enabledRegistryComponentIds ? { enabledRegistryComponentIds } : {})}
          reviewMode
          hideDefaultActions
          onChange={setEdition}
          onSave={handleSave}
          isSaving={saving}
        />
      </EditionApprovalShell>
    );
  }

  const status = (edition as any).status || 'draft';
  const statusColor = status === 'published' ? 'green' : status === 'archived' ? 'orange' : 'gray';

  const ic = 'size-4';
  const subTabs: Tab[] = [
    { id: 'editor', label: 'Editor', icon: <PencilSquareIcon className={ic} /> },
    { id: 'details', label: 'Details', icon: <Cog6ToothIcon className={ic} /> },
    ...(hasBulkEmailing ? [{ id: 'sending', label: 'Sending', icon: <PaperAirplaneIcon className={ic} /> }] : []),
  ];

  // Primary tab row = this newsletter's sections (mirrors the newsletter
  // detail page), with "Editions" lit since an edition lives under it.
  // Clicking a tab navigates to that section on the newsletter detail page.
  const newsletterTabs: Tab[] = [
    { id: 'details', label: 'Settings', icon: <Cog6ToothIcon className={ic} /> },
    { id: 'template', label: 'Template', icon: <RectangleGroupIcon className={ic} /> },
    ...(isSuperAdmin ? [{ id: 'approval', label: 'Approval', icon: <CheckBadgeIcon className={ic} /> }] : []),
    { id: 'editions', label: 'Editions', icon: <DocumentTextIcon className={ic} /> },
    ...(hasBulkEmailing
      ? [
          { id: 'replies', label: 'Replies', icon: <ChatBubbleLeftRightIcon className={ic} /> },
          { id: 'stats', label: 'Stats', icon: <ChartBarIcon className={ic} /> },
        ]
      : []),
  ];

  const editionDateLabel = new Date(edition.edition_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <Page title={edition.subject || 'Newsletter Edition'}>
      <WorkspaceLayout
        title={collection?.name ? `Newsletters: ${collection.name}` : 'Newsletters'}
        tabs={newsletterTabs}
        activeTabId="editions"
        onTabChange={(t) => navigate(newsletterSlug ? `/newsletters/${newsletterSlug}/${t}` : '/newsletters')}
        breadcrumbs={[
          {
            label: 'Editions',
            to: newsletterSlug ? `/newsletters/${newsletterSlug}/editions` : '/newsletters',
          },
          { label: editionDateLabel },
        ]}
        onBreadcrumbNavigate={(to) => navigate(to)}
        subTabs={subTabs}
        activeSubTabId={activeTab}
        onSubTabChange={handleTabChange}
      >
      {notices}
      {/* Tab Content */}
      {activeTab === 'editor' && (
        <div
          ref={editorWrapperRef}
          // Escape WorkspaceLayout's content padding (px-6 + the page
          // margin-x, plus pt-4/pb-6) so the editor canvas stays full-bleed
          // and reclaims full height. The inner padding below re-insets the
          // canvas to line up with the content gutter. Height is measured
          // dynamically so it adapts to the new chrome above.
          className="-mx-[calc(var(--margin-x)+1.5rem)] -mt-4 -mb-6"
          // The curved-corner panel inside NewsletterPuckCanvas sits
          // inside the same hero-matching horizontal padding as
          // every other admin page chrome — so the panel's left
          // edge lines up with the "Editor" tab text and its right
          // edge lines up with the admin's right margin.
          //
          // Height is measured dynamically (see editorHeight effect
          // above) so the editor fills exactly the viewport space
          // remaining below the hero + tab bar — no page-level
          // scroll. `overflow: hidden` keeps Puck's tall internal
          // panels from leaking out; each Puck pane scrolls on its
          // own inside the curved-corner shell.
          style={{
            height: editorHeight != null ? `${editorHeight}px` : 'calc(100vh - 240px)',
            padding: '1rem calc(var(--margin-x) + 1.5rem)',
            overflow: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <NewsletterCanvasEditor
            key={canvasKey}
            edition={edition}
            blockTemplates={blockTemplates}
            brickTemplates={brickTemplates}
            collectionMetadata={collectionMetadata}
            wrapperTemplate={collection?.wrapperTemplate ?? null}
            viewOnlineUrl={getViewOnlineUrl(
              collection,
              { edition_date: edition.edition_date, subject: edition.subject, title: edition.title },
            )}
            {...(collectionId ? { collectionId } : {})}
            // Per spec-builder-evaluation §3.6 (extended). When the bound
            // library has explicit `render_kind='react-email'` rows, surface
            // ONLY those component_ids (production opt-in pattern). When
            // the library has zero such rows yet, omit the prop entirely
            // — the merge helper then exposes the FULL platform registry
            // as a sensible default so a fresh edition has email-safe
            // blocks available out of the box. Mustache rows still appear
            // alongside whichever registry surface is active.
            {...(enabledRegistryComponentIds ? { enabledRegistryComponentIds } : {})}
            // Research blocks get the Research panel beneath their Puck
            // fields (spec §5.2, §5.4); every other block renders nothing extra.
            blockSidebarExtra={renderBlockSidebarExtra}
            toolbarActions={<GDocFillButton onClick={() => setGdocOpen(true)} disabled={edition.id === 'new' || saving} />}
            onChange={setEdition}
            onSave={handleSave}
            onStatusChange={async (newStatus) => {
              setEdition(prev => prev ? { ...prev, status: newStatus } as any : prev);
              if (!isNew && edition) {
                await supabase.from('newsletters_editions').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', edition.id);
                toast.success(`Status changed to ${newStatus}`);
              }
            }}
            isSaving={saving}
          />
        </div>
      )}

      {activeTab === 'details' && (
        <div className="py-2">
          <div className="max-w-2xl space-y-5">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Edition title / subject
              </label>
              <input
                type="text"
                value={edition.subject ?? ''}
                onChange={(e) => setEdition({ ...edition, subject: e.target.value })}
                placeholder="Edition title — also the email subject line"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The subject line shown in the recipient&apos;s inbox. Also used as the
                edition&apos;s display name in lists.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Edition date
              </label>
              <input
                type="date"
                value={edition.edition_date ?? ''}
                onChange={(e) => setEdition({ ...edition, edition_date: e.target.value })}
                className="px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The date this edition is logically associated with — used for ordering
                and for the public archive page.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                Preheader
              </label>
              <textarea
                value={edition.preheader ?? ''}
                onChange={(e) => setEdition({ ...edition, preheader: e.target.value })}
                placeholder="Preheader — short preview text shown in the inbox next to the subject (recommended ~80 chars)"
                rows={3}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)] resize-y"
              />
              <p className="text-xs text-[var(--gray-9)] mt-1">
                The short snippet most email clients show next to or below the subject.
                Recommended length: ~80 characters.
              </p>
            </div>

            {/* Scheduling (spec §5.3 / §6): the intended send time and the
                research time. research_at blank = derived by the server
                (send target minus the collection's research_lead_hours,
                default 36h); a value pins it. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                  Send target
                </label>
                <input
                  type="datetime-local"
                  value={toLocalInput(edition.send_target_at)}
                  onChange={(e) => setEdition({ ...edition, send_target_at: fromLocalInput(e.target.value) })}
                  className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
                />
                <p className="text-xs text-[var(--gray-9)] mt-1">
                  When this edition is meant to go out. Research blocks are scheduled from it.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-12)] mb-1.5">
                  Research time{' '}
                  <span className="font-normal text-[var(--gray-9)]">({edition.research_at ? 'pinned' : 'derived'})</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="datetime-local"
                    value={toLocalInput(edition.research_at)}
                    onChange={(e) => setEdition({ ...edition, research_at: fromLocalInput(e.target.value) })}
                    className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
                  />
                  {edition.research_at && (
                    <button
                      type="button"
                      onClick={() => setEdition({ ...edition, research_at: null })}
                      className="px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md text-[var(--gray-11)] hover:bg-[var(--gray-a3)]"
                      title="Derive from the send target again"
                    >
                      Derive
                    </button>
                  )}
                </div>
                <p className="text-xs text-[var(--gray-9)] mt-1">
                  {edition.research_at
                    ? 'Pinned: moving the send target will not move this.'
                    : effectiveResearchAt
                      ? `Derived from the saved send target: ${new Date(effectiveResearchAt).toLocaleString()}${sameInstant(edition.send_target_at, serverMetaRef.current.send_target_at) ? '' : ' (updates after you save)'}.`
                      : 'Blank = derived from the send target minus the newsletter’s research lead (36h by default). Set a send target first.'}
                  {hasResearchBlocks ? '' : ' This edition has no research blocks yet.'}
                </p>
              </div>
            </div>

            {edition.id && (
              <ContentAccessControl contentType="newsletter_edition" entityId={edition.id} />
            )}

            <div className="pt-2">
              <button
                type="button"
                onClick={() => handleSave()}
                disabled={saving}
                className="px-4 py-2 bg-[var(--accent-9)] hover:bg-[var(--accent-10)] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors"
              >
                {saving ? 'Saving…' : 'Save details'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sending' && hasBulkEmailing && (
        <div className="py-2">
          <EditionSendingTab
            editionId={edition.id}
            editionDate={edition.edition_date}
            subject={edition.subject || ''}
            preheader={edition.preheader || ''}
            collection={collection}
            newsletterSlug={newsletterSlug}
            editionStatus={(edition as { status?: string }).status}
            // For the send gate's message: block id → the block's label.
            blockNames={blockNames}
            beforeApprovalRequest={async () => { await handleSave({ silent: true }); }}
            getRenderedHtml={edition
              ? async () => {
                  // Build per-block render metadata: react-email blocks
                  // route through the registry's Component, legacy
                  // Mustache blocks fall back to renderTemplate of the
                  // block_template's html_template. Both paths compose
                  // into the same EditionEmail tree and produce one
                  // email-safe HTML document via @react-email/render.
                  const blockMeta = new Map<string, BlockRenderMeta>();
                  for (const block of edition.blocks) {
                    const componentId = block.block_template.component_id || block.block_template.block_type;
                    // Three routes:
                    //  1. react-email — typed component in the static registry
                    //  2. declarative — html-ish git-authored source (body_section,
                    //     intro_paragraph, email_only_intro …); routed through the
                    //     declarative renderer via the per-edition registry, which
                    //     EditionEmail treats as 'react-email' (see
                    //     renderViaEditionEmail.tsx — same path, just authored as HTML).
                    //  3. mustache — legacy {{token}} substitution against html_template.
                    // Pre-fix this fell through to mustache for declarative blocks,
                    // leaving `<richtext field="description">` etc. as raw unparsed
                    // elements that browsers silently drop. Cost: 7k chars of body
                    // text vanishing from the 2026-06-23 send.
                    const dbRenderKind = block.block_template.render_kind;
                    if (emailBlockRegistry.has(componentId) || dbRenderKind === 'react-email' || dbRenderKind === 'declarative') {
                      blockMeta.set(block.id, { render_kind: 'react-email', component_id: componentId });
                    } else {
                      blockMeta.set(block.id, {
                        render_kind: 'mustache',
                        mustache_html: block.block_template.content.html_template ?? '',
                      });
                    }
                  }
                  return exportEditionHtml({
                    edition,
                    format: 'email',
                    blockMeta,
                    wrapperTemplate: collection?.wrapperTemplate ?? null,
                    viewOnlineUrl: getViewOnlineUrl(
                      collection,
                      { edition_date: edition.edition_date, subject: edition.subject, title: edition.title },
                    ) ?? undefined,
                    registry: buildEmailRegistry(blockTemplates, brickTemplates),
                    pretty: false,
                    // getRenderedHtml feeds the send pipeline (test send + real
                    // send). Mark it so EditionEmail lands the {{unsubscribe_url}}
                    // / {{manage_subscriptions_url}} tokens for newsletter-send to
                    // substitute per recipient.
                    forSend: true,
                  });
                }
              : undefined}
          />
        </div>
      )}
      <GDocFillDialog
        isOpen={gdocOpen}
        onClose={() => setGdocOpen(false)}
        edition={edition}
        blockTemplates={blockTemplates as unknown as BlockTemplate[]}
        onApply={applyGdocFill}
      />
      </WorkspaceLayout>
    </Page>
  );
}

/**
 * Blocks a new edition starts with, per the template repo's edition.json
 * (`templates_libraries.new_edition_blocks`, written by the templates
 * ingest). Resolves each key against the library's current block defs and
 * gives every block the content dragging it from the palette would — the
 * declarative registry's schema defaults — with the skeleton's own
 * `content` merged over. Empty when the library declares nothing.
 */
async function seedFromTemplateSkeleton(libraryId: string): Promise<NewsletterEdition['blocks']> {
  const { data: lib } = await supabase
    .from('templates_libraries')
    .select('new_edition_blocks')
    .eq('id', libraryId)
    .maybeSingle<{ new_edition_blocks: unknown }>();
  const skeleton = asEditionSkeleton(lib?.new_edition_blocks);
  if (!skeleton) return [];

  const { data: defs, error } = await supabase
    .from('templates_block_defs')
    .select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, source_kind, data_source, block_type:key')
    .eq('library_id', libraryId)
    .eq('is_current', true);
  if (error) throw error;
  // Seeded research blocks carry their binding hash like loaded ones do.
  const rows = await withBindingHashes((defs ?? []) as unknown as Array<SkeletonBlockDef & { block_type: string; source_kind?: string | null; data_source?: unknown }>);
  const registry = buildEmailRegistry(
    rows.map((r) => ({ ...r, content: { html_template: r.html ?? '', rich_text_template: r.rich_text_template ?? null, has_bricks: r.has_bricks ?? false, schema: r.schema ?? {} } })) as never,
    [],
  );
  const { blocks, missing } = buildSkeletonBlocks({
    skeleton,
    defs: rows,
    defaultsFor: (key) => ({ ...((registry.get(key)?.defaultProps as Record<string, unknown> | undefined) ?? {}) }),
    newId: freshUuid,
  });
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[edition-new] edition.json names blocks this library does not have:', missing.join(', '));
  }
  return blocks as unknown as NewsletterEdition['blocks'];
}

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Walk a starter-template's content + nested children, stamping fresh
 * UUIDs at every level. The saved trees strip ids on generation
 * (`build-barebone-trees.ts`) and the curated starters never had ids;
 * minting fresh ones at apply-time keeps Puck's identity tracking
 * correct when the same starter is applied across multiple editions.
 */
function stampIdsRecursive(content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...content };
  if (Array.isArray(out.children)) {
    out.children = (out.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) => ({
      type: c.type,
      props: stampIdsRecursive({ ...c.props, id: freshUuid() }),
    }));
  }
  return out;
}
