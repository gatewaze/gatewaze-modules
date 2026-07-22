import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import {
  Cog6ToothIcon,
  PencilSquareIcon,
  PaperAirplaneIcon,
  RectangleGroupIcon,
  DocumentTextIcon,
  ChatBubbleLeftRightIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Badge, WorkspaceLayout } from '@/components/ui';
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
  type BlockTemplate,
  type BrickTemplate,
} from '../../utils';
import { exportEditionHtml } from '../../components/puck/email-blocks/export-edition-html';
import { getViewOnlineUrl } from '../../utils/view-online-url';
import { buildEmailRegistry } from '../../components/puck/email-blocks/declarative/registry';
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
  templates_block_def_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  block_template: DbBlockTemplate;
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

export default function EditionEditorPage() {
  const { id, tab: tabFromUrl, slug: newsletterSlug } = useParams<{ id: string; tab?: string; slug?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const hasBulkEmailing = useHasModule('bulk-emailing');

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
  const activeTab: EditionTab = validTabs.includes(tabFromUrl as EditionTab) ? (tabFromUrl as EditionTab) : defaultTab;

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
        .select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, block_type:key')
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
      const adaptedBlocks = (blocksRes.data ?? []).map((r) => ({
        ...r,
        content: {
          html_template: r.html ?? '',
          rich_text_template: r.rich_text_template ?? null,
          has_bricks: r.has_bricks ?? false,
          schema: r.schema ?? {},
        },
      }));
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
      if (typeof slug === 'string' && slug.length > 0) {
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
        .select('*, block_template:templates_block_defs!templates_block_def_id(id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, block_type:key)')
        .eq('edition_id', id)
        .is('deleted_at', null)   // exclude soft-deleted blocks (migration 069)
        .order('sort_order');
      if (blocksError) throw blocksError;

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
      const bucketUrl = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/storage/v1/object/public/media`;
      setEdition({
        id: editionData.id,
        edition_date: editionData.edition_date,
        subject: editionData.title || '',
        preheader: editionData.preheader || '',
        status: editionData.status,
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
    const t = setTimeout(() => writeDraft(editionId, toDraftPayload(edition), Date.now()), 800);
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

  const handleSave = async (options?: { silent?: boolean }) => {
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
        // Atomic, concurrency-controlled save (migration 069's
        // newsletters_save_edition). ONE RPC does: optimistic version-check →
        // snapshot current blocks into a revision → diff-upsert the canvas
        // blocks/bricks → soft-delete removed ones → bump version. This
        // replaces the old destructive "update edition, delete EVERY block,
        // re-insert one by one" — which was non-atomic (a mid-loop failure
        // lost blocks) and had no concurrency control (a stale tab / second
        // session / any writer silently clobbered newer content — the
        // lost-update that wiped edition 21afd12a). Empty-id template refs map
        // to NULL exactly as before (registry blocks carry no block_def row).
        const payloadBlocks = edition.blocks.map((block) => ({
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
          p_edition_id: edition.id,
          p_expected_version: editionVersionRef.current,
          p_title: edition.subject || 'Untitled',
          p_preheader: edition.preheader || null,
          p_content_category: collection?.content_category || null,
          p_edition_date: edition.edition_date,
          p_blocks: payloadBlocks,
        });
        if (saveErr) {
          // 55006 = version_conflict: the edition changed since we loaded it.
          // Do NOT overwrite — keep the operator's in-memory work and tell them
          // to reload. Throw a marked error so callers know the save failed;
          // the catch below skips its generic toast for this case.
          const isConflict = saveErr.code === '55006' || /version_conflict/i.test(saveErr.message || '');
          if (isConflict) {
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
            writeDraft(edition.id, toDraftPayload(edition), Date.now());
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
        // Saved — this in-memory state is now the clean baseline; drop the local
        // recovery draft and clear any prior session-expired flag.
        loadedSnapshotRef.current = draftFingerprint(toDraftPayload(edition));
        clearDraft(edition.id);
        if (sessionExpired) setSessionExpired(false);
        if (!options?.silent) toast.success('Edition saved');
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

  if (loading) {
    return <Page title="Loading..."><div className="flex items-center justify-center h-64"><LoadingSpinner /></div></Page>;
  }

  if (!edition) {
    return <Page title="Not Found"><div className="p-6 text-center text-[var(--gray-9)]">Edition not found</div></Page>;
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
            collection={collection}
            newsletterSlug={newsletterSlug}
            editionStatus={(edition as { status?: string }).status}
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
      </WorkspaceLayout>
    </Page>
  );
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
