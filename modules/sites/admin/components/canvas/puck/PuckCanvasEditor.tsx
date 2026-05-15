/**
 * PuckCanvasEditor — top-level <Puck/> mount for blocks-mode pages.
 *
 * Per spec-builder-evaluation §3.1 / §3.5. Phase B scope: load the page
 * tree + library, build a Config, mount Puck with an iframe, and on save
 * diff the new PuckData against the loaded snapshot to produce CanvasOps
 * which we submit through the existing canvas-service.applyOps path.
 *
 * The render seam (renderHost.renderBlock) currently emits a structural
 * placeholder — Phase B+ replaces it with the real renderPage pipeline
 * (one block, server-side, theme CSS in the iframe). For now the
 * placeholder is enough to validate the load → diff → save round-trip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Data as PuckCoreData } from '@puckeditor/core';
import { CanvasShell } from './CanvasShell.js';
import { toast } from 'sonner';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useCanvasLock } from '../useCanvasLock.js';
import {
  CanvasService,
  type PageTreeView,
  type BlockDefSummary,
  type BrickDefView,
} from '../canvas-service.js';
import {
  buildPuckConfig,
  type BuildConfigResult,
} from './PuckConfigAdapter.js';
import { pageBlocksToPuckData, diffToOps } from './puck-data-adapter.js';
import { renderBlockClient, type BlockTemplateLookup } from './render-block-client.js';
import { extractThemeCss } from './extract-theme-css.js';
import { HostMediaPickerModal } from './HostMediaPickerModal.js';
import { PersonalizationHostProvider, type PersonalizationHost } from './fields/personalization-host-context.js';
import { VariantEditor } from '../../VariantEditor.js';
import { useHasModule } from '@/hooks/useModuleFeature';
import {
  RefetchRequired,
  type PageBlockTree,
  type PuckData,
  type PuckRenderHost,
  type ThemeKind,
  type BlockDefRow,
  type BrickDefRow,
  type WrapperRow,
} from './types.js';
import type { CanvasOp, OpEnvelope } from '../../../../lib/canvas-render/types.js';

interface PuckCanvasEditorProps {
  pageId: string;
  siteSlug: string;
  /**
   * Theme kind for this site. Defaults to 'website'; flip to 'email' when
   * editing newsletter editions through the same library — the dual-config
   * email renderer kicks in. Per spec §3.6.
   */
  themeKind?: ThemeKind;
}

interface LoadedState {
  tree: PageBlockTree;
  baselineVersion: number;
  config: BuildConfigResult;
  initialData: PuckData;
  /** Kept so the personalization side panel can resolve a block's schema by id. */
  blockDefs: ReadonlyArray<BlockDefRow>;
  brickDefs: ReadonlyArray<BrickDefRow>;
}

export function PuckCanvasEditor({ pageId, siteSlug, themeKind = 'website' }: PuckCanvasEditorProps) {
  const lock = useCanvasLock(pageId);
  const hasEditorAi = useHasModule('editor-ai-copilot');

  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaPicker, setMediaPicker] = useState<{ open: boolean; cb: ((url: string) => void) | null }>({ open: false, cb: null });
  const [variantTarget, setVariantTarget] = useState<{ blockInstanceId: string; propName: string } | null>(null);

  // Personalization host — bridges the Personalize button (inside Puck)
  // to the VariantEditor mount (outside Puck).
  const personalizationHost: PersonalizationHost = useMemo(
    () => ({
      openVariantEditor: ({ blockInstanceId, propName }) => {
        setVariantTarget({ blockInstanceId, propName });
      },
    }),
    [],
  );

  // Mutable ref to the current baseline tree — diff always runs against this,
  // not against an older closure capture.
  const baselineRef = useRef<PageBlockTree | null>(null);
  const baselineVersionRef = useRef<number>(0);
  const fingerprintRef = useRef<string | null>(null);

  // Resolve library_id + site_id for the site once at mount. site_id is
  // used by the host-media picker modal (which scopes by host_kind/host_id).
  useEffect(() => {
    let cancelled = false;
    void resolveSiteIds(siteSlug).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setLibraryId(res.libraryId);
        setSiteId(res.siteId);
      } else {
        setLoadError(res.error);
      }
    });
    return () => { cancelled = true; };
  }, [siteSlug]);

  // Load page tree + block_defs + brick_defs.
  useEffect(() => {
    if (!libraryId) return;
    let cancelled = false;
    setLoadError(null);

    void Promise.all([
      CanvasService.loadPageTree(pageId),
      CanvasService.listBlockDefs(libraryId),
      CanvasService.listBrickDefs(libraryId),
      // Fetch the legacy-rendered HTML once so we can extract the theme
      // CSS + external font/sheet links and inject them into the Puck
      // iframe via root.render. Per spec-builder-evaluation §3.5.
      CanvasService.render(pageId, null),
    ]).then(([pageRes, blocksRes, bricksRes, renderRes]) => {
      if (cancelled) return;
      if (!pageRes.ok) { setLoadError(pageRes.error.message); return; }
      if (!blocksRes.ok) { setLoadError(blocksRes.error.message); return; }
      if (!bricksRes.ok) { setLoadError(bricksRes.error.message); return; }
      // Render endpoint failure is non-fatal — fall back to no theme.
      const themeCss = renderRes.ok === true
        ? extractThemeCss(renderRes.html)
        : { inline: '', externalLinks: [] as string[] };

      const tree = pageTreeViewToBlockTree(pageRes.tree);
      const blockDefs = blocksRes.blockDefs.map(blockDefSummaryToRow);
      const brickDefs = bricksRes.brickDefs.map(brickDefViewToRow);
      const wrappers: WrapperRow[] = tree.page.wrapper_key
        ? [{ id: 'wrapper-current', key: tree.page.wrapper_key, is_current: true }]
        : [];

      // Build a single template lookup table covering both blocks AND
      // bricks — Puck calls renderBlock for either kind.
      const templateLookup: BlockTemplateLookup = {
        byKey: new Map([
          ...blockDefs.map((d) => [d.key, { html: d.html, schema: d.schema }] as const),
          ...brickDefs.map((b) => [b.key, { html: b.html, schema: b.schema }] as const),
        ]),
      };

      const renderHost: PuckRenderHost = {
        renderBlock: ({ blockDefKey, variantKey, content }) => {
          const result = renderBlockClient({
            blockDefKey,
            content,
            variantKey,
            lookup: templateLookup,
          });
          return (
            <div
              className="puck-block-rendered"
              data-block-key={blockDefKey}
              dangerouslySetInnerHTML={{ __html: result.html }}
            />
          );
        },
        showMediaPicker: (cb) => {
          setMediaPicker({ open: true, cb });
        },
      };

      const config = buildPuckConfig({
        libraryId,
        blockDefs,
        brickDefs,
        wrappers,
        themeKind,
        renderHost,
        themeCss,
      });

      baselineRef.current = tree;
      baselineVersionRef.current = pageRes.tree.page.version;
      fingerprintRef.current = config.fingerprint;
      setLoaded({
        tree,
        baselineVersion: pageRes.tree.page.version,
        config,
        initialData: pageBlocksToPuckData(tree),
        blockDefs,
        brickDefs,
      });

      if (config.warnings.length > 0) {
        // Phase B: surface unmapped formats in console + dev banner. Phase E
        // surfaces via the puck-readiness audit endpoint.
        // eslint-disable-next-line no-console
        console.warn('[puck] field-format warnings:', config.warnings);
      }
    });

    return () => { cancelled = true; };
  }, [libraryId, pageId, themeKind]);

  // Save handler — wired to <Puck onPublish={...}/> below.
  const handlePublish = useCallback(async (data: PuckCoreData) => {
    const baseline = baselineRef.current;
    if (!baseline || !loaded) return;
    if (lock.kind !== 'held') {
      toast.error("You don't currently hold the editor lock.");
      return;
    }

    setSaving(true);
    try {
      // Build the diff input.
      const knownBlockDefKeys = new Set(Object.keys(loaded.config.config.components));
      const knownBrickDefKeysByBlock = buildBrickKeyIndex(loaded.config.config.components);

      let ops: ReadonlyArray<CanvasOp>;
      try {
        ops = diffToOps({
          prev: baseline,
          next: data as unknown as PuckData,
          knownBlockDefKeys,
          knownBrickDefKeysByBlock,
        });
      } catch (e) {
        if (e instanceof RefetchRequired) {
          toast.warning('Page changed — refreshing.');
          await refetchAndRebase(pageId, libraryId, themeKind, setLoaded, baselineRef, baselineVersionRef);
          return;
        }
        throw e;
      }

      if (ops.length === 0) {
        toast.success('Nothing to save.');
        return;
      }

      const envelope: OpEnvelope = {
        ops,
        baseVersion: baselineVersionRef.current,
        clientToken: lock.clientToken,
        idempotencyKey: makeIdempotencyKey(),
      };
      const res = await CanvasService.applyOps(pageId, envelope);
      if (!res.ok) {
        toast.error(`Save failed: ${res.error.message}`);
        return;
      }
      // Successful save — refetch to refresh baseline (server-assigned IDs
      // for any inserts plus the new version).
      await refetchAndRebase(pageId, libraryId, themeKind, setLoaded, baselineRef, baselineVersionRef);
      toast.success(`Saved (${ops.length} change${ops.length === 1 ? '' : 's'}).`);
    } finally {
      setSaving(false);
    }
  }, [pageId, libraryId, themeKind, lock, loaded]);

  if (loadError) {
    return (
      <div className="puck-canvas-error" role="alert">
        <p>Failed to load editor: {loadError}</p>
      </div>
    );
  }
  if (!loaded || lock.kind === 'idle' || lock.kind === 'acquiring') {
    return <LoadingSpinner />;
  }
  if (lock.kind === 'conflict') {
    return (
      <div className="puck-canvas-locked" role="alert">
        <p>This page is being edited by another user.</p>
      </div>
    );
  }
  if (lock.kind === 'error') {
    return (
      <div className="puck-canvas-error" role="alert">
        <p>Lock error: {lock.message}</p>
      </div>
    );
  }

  // Empty-state guard: if the library has zero blocks for the requested
  // channel, the user can't insert anything — surface this clearly
  // rather than dropping them into a blank canvas. Per spec §4.1
  // puck-readiness audit (this is the editor-side counterpart).
  const componentCount = Object.keys(loaded.config.config.components).length;
  if (componentCount === 0) {
    return (
      <div className="puck-canvas-empty" role="status">
        <h3>No {themeKind} blocks in this library</h3>
        <p>
          {themeKind === 'email'
            ? 'This site has no email-flavored blocks yet. Connect an email theme repo (e.g. gatewaze-template-email) on the Source tab to populate the library.'
            : 'This site has no website blocks yet. Connect a theme repo (e.g. gatewaze-template-site) on the Source tab to populate the library.'}
        </p>
      </div>
    );
  }

  // Toolbar above the canvas — placeholder for site-specific actions.
  // The newsletter editor renders Save Draft / Substack / Beehiiv /
  // Publish here; sites will surface its own actions (publish-to-git,
  // version-snapshot, etc.) in a follow-up. The empty toolbar still
  // takes up vertical space so the panel below sits consistently with
  // the newsletter editor's layout.
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
      {saving && <span style={{ fontSize: 12, color: 'var(--gray-9)' }}>Saving…</span>}
    </div>
  );

  return (
    <PersonalizationHostProvider host={personalizationHost}>
      <div className={`puck-canvas-root puck-canvas-${themeKind}`} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <CanvasShell
          hostKind="site"
          // hostId = site id (resolved by resolveSiteIds). Fall back to
          // an empty string while it's still loading — but the loaded
          // guard above means we only render this branch once siteId is
          // populated, so the fallback is effectively unreachable.
          hostId={siteId ?? ''}
          targetId={pageId}
          aiEnabled={hasEditorAi}
          config={loaded.config.config as never}
          data={loaded.initialData as never}
          onPublish={handlePublish as never}
          toolbar={toolbar}
          // Sites uses Puck's default viewports for `website` theme (360 /
          // 768 / 1280 / full); only override to 600 when the library is
          // email-flavoured (rare, but supported when a site links an
          // email theme repo for transactional sends).
          {...(themeKind === 'email'
            ? { viewports: [{ width: 600, height: 'auto' as const, label: 'Email' }] }
            : {})}
        />
        {siteId && (
          <HostMediaPickerModal
            open={mediaPicker.open}
            hostKind="site"
            hostId={siteId}
            onSelect={(url) => mediaPicker.cb?.(url)}
            onClose={() => setMediaPicker({ open: false, cb: null })}
          />
        )}
        {variantTarget && siteId && (
          <VariantEditor
            pageId={pageId}
            siteId={siteId}
            fieldPath={`${variantTarget.blockInstanceId}.${variantTarget.propName}`}
            fieldLabel={`${describeBlock(variantTarget.blockInstanceId, loaded)} → ${variantTarget.propName}`}
            fieldSchema={resolveBlockPropSchema(variantTarget.blockInstanceId, variantTarget.propName, loaded)}
            onClose={() => setVariantTarget(null)}
          />
        )}
      </div>
    </PersonalizationHostProvider>
  );
}

/**
 * Resolve a block instance's prop JSON-Schema from the loaded library.
 * Returns null when the block can't be found (race) or the prop name
 * isn't in the schema (stale variant for a since-renamed field).
 */
function resolveBlockPropSchema(
  blockInstanceId: string,
  propName: string,
  loaded: LoadedState,
): import('../../../schema-editor/walk-schema.js').SchemaNode | null {
  const block =
    loaded.tree.topLevel.find((b) => b.id === blockInstanceId) ??
    null;
  const brick =
    block ?? loaded.tree.bricks.find((b) => b.id === blockInstanceId) ?? null;
  if (!block && !brick) return null;
  const defKey = block?.block_def_key ?? (brick as { brick_def_key?: string } | null)?.brick_def_key;
  if (!defKey) return null;
  const def =
    loaded.blockDefs.find((d) => d.key === defKey) ??
    loaded.brickDefs.find((d) => d.key === defKey) ??
    null;
  const schema = def?.schema as
    | { properties?: Record<string, import('../../../schema-editor/walk-schema.js').SchemaNode> }
    | undefined;
  return schema?.properties?.[propName] ?? null;
}

function describeBlock(blockInstanceId: string, loaded: LoadedState): string {
  const block = loaded.tree.topLevel.find((b) => b.id === blockInstanceId);
  if (block) return block.block_def_key;
  const brick = loaded.tree.bricks.find((b) => b.id === blockInstanceId);
  if (brick) return (brick as { brick_def_key?: string }).brick_def_key ?? 'brick';
  return 'block';
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ResolveSiteIdsOk { ok: true; libraryId: string; siteId: string }
interface ResolveSiteIdsErr { ok: false; error: string }

async function resolveSiteIds(siteSlug: string): Promise<ResolveSiteIdsOk | ResolveSiteIdsErr> {
  // Slug → site_id → library_id. PostgREST direct (matches the legacy
  // editor's pattern). We need both: library_id for blocks lookup,
  // site_id for the host-media picker.
  const { supabase } = await import('@/lib/supabase');
  const { data, error } = await supabase
    .from('sites')
    .select('id, templates_libraries!inner(id)')
    .eq('slug', siteSlug)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  type Row = { id: string; templates_libraries: { id: string } | null };
  const row = data as Row | null;
  if (!row) return { ok: false, error: 'site not found' };
  if (!row.templates_libraries?.id) return { ok: false, error: 'site has no library bound' };
  return { ok: true, libraryId: row.templates_libraries.id, siteId: row.id };
}

function pageTreeViewToBlockTree(view: PageTreeView): PageBlockTree {
  return {
    page: {
      id: view.page.id,
      wrapper_key: view.page.wrapper_key,
      root_meta: view.page.root_meta,
      wysiwyg_locked: view.page.wysiwyg_locked,
    },
    topLevel: view.topLevel.map((b) => ({
      id: b.id,
      block_def_id: b.block_def_id,
      block_def_key: b.block_def_key,
      parent_brick_id: b.parent_brick_id,
      sort_order: b.sort_order,
      variant_key: b.variant_key,
      has_bricks: b.has_bricks,
      content: b.content,
    })),
    bricks: view.bricks.map((br) => ({
      id: br.id,
      page_block_id: br.page_block_id,
      brick_def_id: br.brick_def_id,
      brick_def_key: br.brick_def_key,
      sort_order: br.sort_order,
      variant_key: br.variant_key,
      content: br.content,
    })),
  };
}

function blockDefSummaryToRow(d: BlockDefSummary): BlockDefRow {
  return {
    id: d.id,
    key: d.key,
    name: d.name,
    description: d.description,
    schema: d.schema,
    html: d.html,
    has_bricks: d.has_bricks,
    is_current: true,
    thumbnail_url: d.thumbnail_url,
  };
}

function brickDefViewToRow(b: BrickDefView): BrickDefRow {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    parent_block_def_key: b.parent_block_def_key,
    parent_block_def_id: b.parent_block_def_id,
    schema: b.schema,
    html: b.html,
    is_current: true,
  };
}

/**
 * Walk the Puck Config to build a map of "for parent block X, which brick
 * keys are allowed in its slot". Used by the diff's invariant guard.
 */
function buildBrickKeyIndex(components: Record<string, unknown>): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const [blockKey, comp] of Object.entries(components)) {
    const fields = (comp as { fields?: Record<string, { type?: string; allow?: ReadonlyArray<string> }> }).fields;
    if (!fields) continue;
    const childrenField = fields.children;
    if (childrenField?.type === 'slot' && Array.isArray(childrenField.allow)) {
      out.set(blockKey, new Set(childrenField.allow));
    }
  }
  return out;
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}

async function refetchAndRebase(
  pageId: string,
  libraryId: string | null,
  themeKind: ThemeKind,
  setLoaded: React.Dispatch<React.SetStateAction<LoadedState | null>>,
  baselineRef: React.MutableRefObject<PageBlockTree | null>,
  baselineVersionRef: React.MutableRefObject<number>,
): Promise<void> {
  if (!libraryId) return;
  const [pageRes] = await Promise.all([CanvasService.loadPageTree(pageId)]);
  if (!pageRes.ok) {
    toast.error(`Refetch failed: ${pageRes.error.message}`);
    return;
  }
  const tree = pageTreeViewToBlockTree(pageRes.tree);
  baselineRef.current = tree;
  baselineVersionRef.current = pageRes.tree.page.version;
  // The user keeps editing the in-memory PuckData; we update only the
  // baseline. Phase B+ may replace this with a more sophisticated rebase
  // (e.g., reapply the user's pending edits over the new snapshot).
  // For the v1 scaffold, the user resaves and the diff produces a fresh
  // op stream against the fresh baseline.
  setLoaded((prev: LoadedState | null) =>
    prev ? { ...prev, tree, baselineVersion: pageRes.tree.page.version, initialData: pageBlocksToPuckData(tree) } : prev,
  );
  // Mark themeKind as referenced so the linter doesn't trip — the value
  // is honoured on the next config rebuild (handled by the parent
  // useEffect when libraryId changes; we don't rebuild config here).
  void themeKind;
}
