/**
 * Newsletter edition editor — Puck-powered alternative to EditionCanvas.
 *
 * Per spec-builder-evaluation §3.6: ONE editor across email + website
 * channels. This component is a controlled wrapper that reuses the
 * sites-module Puck adapter (PuckConfigAdapter, render-block-client)
 * with newsletter-shaped data via a small bidirectional adapter
 * (`editionToPuckData` / `puckDataToEdition`).
 *
 * Why not refactor PuckCanvasEditor directly? The sites component is
 * uncontrolled (loads from server, manages locks, diffs against a
 * baseline). Newsletter editions are CONTROLLED — parent owns the
 * NewsletterEdition state and persistence. A controlled wrapper is
 * cleaner than threading two persistence strategies into one
 * component.
 *
 * Phase D++ scope: edit / save round-trip via parent. Per-edition lock
 * semantics, real-time collab, undo/redo come later (current
 * EditionCanvas doesn't have them either).
 */

import { useEffect, useMemo, useRef, useState, type FC, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Puck,
  type Config,
  ActionBar,
  blocksPlugin,
  outlinePlugin,
  fieldsPlugin,
  createUsePuck,
} from '@puckeditor/core';
import {
  PencilSquareIcon,
  CodeBracketIcon,
  SunIcon,
  MoonIcon,
  ArrowDownTrayIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline';
import {
  buildPuckConfig,
  type PuckRenderHost,
} from '../../../../sites/admin/components/canvas/puck/PuckConfigAdapter.js';
import { renderBlockClient, type BlockTemplateLookup } from '../../../../sites/admin/components/canvas/puck/render-block-client.js';
import type {
  BlockDefRow,
  BrickDefRow,
} from '../../../../sites/admin/components/canvas/puck/types.js';
import type {
  NewsletterEdition,
  BlockTemplate,
  BrickTemplate,
} from '../../utils/types.js';
import { editionToPuckData, puckDataToEdition } from './edition-puck-adapter.js';
import { emailBlockRegistry } from './email-blocks/index.js';
import { mergeRegistryIntoConfig } from './email-blocks/merge-into-config.js';
import { exportEditionHtml } from './email-blocks/export-edition-html.js';
import { getCanvasPuckPlugins } from '../../../../sites/admin/components/canvas/puck/canvas-puck-plugin-registry.js';
import { CanvasPluginHostContext } from '../../../../sites/admin/components/canvas/puck/canvas-plugin-host-context.js';
import { buildAiBlockDefs } from './email-blocks/build-ai-block-defs.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { useHasModule } from '@/hooks/useModuleFeature';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';
import { NewsletterEditingProvider } from './NewsletterEditingContext.js';
import { UserBlocksProvider, useUserBlocks } from './user-blocks/UserBlocksContext.js';
import { SaveAsBlockAction } from './user-blocks/SaveAsBlockAction.js';
import { MyBlocksPanel } from './user-blocks/MyBlocksPanel.js';

interface NewsletterPuckCanvasProps {
  edition: NewsletterEdition;
  blockTemplates: ReadonlyArray<BlockTemplate>;
  brickTemplates: ReadonlyArray<BrickTemplate>;
  onChange: (next: NewsletterEdition) => void;
  onSave?: (options?: { silent?: boolean }) => Promise<void> | void;
  isSaving?: boolean;
  /**
   * react-email registry components to enable for this edition. Maps
   * `templates_block_defs.component_id` values that the parent loader
   * found in the bound library. When undefined, all registry entries
   * are exposed (useful for development; production wires the parent
   * loader to filter by what's actually in the library). Per
   * spec-builder-evaluation §3.6 (extended).
   */
  enabledRegistryComponentIds?: ReadonlyArray<string>;
  /**
   * Per-newsletter overrides forwarded to inline custom Puck fields via
   * NewsletterEditingContext — currently consumed only by the Helix AI
   * field on the HelixAiContent block (`helix_project_id` override) but
   * intentionally generic so future module-level integrations can read
   * the same shape without re-plumbing.
   */
  collectionMetadata?: Record<string, unknown>;
  /**
   * Newsletter collection id — used to scope user-saved blocks. When
   * absent, scoping falls back to the edition id (so user blocks
   * effectively become per-edition rather than per-newsletter).
   */
  collectionId?: string;
}

export const NewsletterPuckCanvas: FC<NewsletterPuckCanvasProps> = (props) => {
  // Per-newsletter scope for user-saved blocks. v1 uses localStorage
  // keyed on this id (see user-blocks/storage.ts); a follow-up can
  // swap the storage to the newsletter collection's metadata column
  // without changing call sites.
  const userBlocksScope = props.collectionId ?? props.edition.id;
  return (
    <UserBlocksProvider scopeId={userBlocksScope}>
      <NewsletterPuckCanvasInner {...props} />
    </UserBlocksProvider>
  );
};

const NewsletterPuckCanvasInner: FC<NewsletterPuckCanvasProps> = ({
  edition,
  blockTemplates,
  brickTemplates,
  onChange,
  onSave,
  isSaving,
  enabledRegistryComponentIds,
  collectionMetadata,
  collectionId,
}) => {
  // Default false so the Publish button renders enabled when the
  // parent doesn't thread the saving state through.
  const isSavingNow = isSaving ?? false;
  // Adapt newsletter templates → sites' BlockDefRow / BrickDefRow shape
  // so we can reuse the existing Puck Config builder. Memoised — these
  // change rarely (only when the library reloads).
  const { blockDefs, brickDefs, lookup } = useMemo(() => {
    const bd: BlockDefRow[] = blockTemplates.map((t) => ({
      id: t.id,
      key: t.block_type,
      name: t.name,
      schema: (t.content.schema ?? {}) as Record<string, unknown>,
      html: t.content.html_template ?? '',
      has_bricks: t.content.has_bricks ?? false,
      is_current: true,
      // Newsletter blocks are always email-channel.
      theme_kind: 'email',
    }));
    const br: BrickDefRow[] = brickTemplates.map((t) => ({
      id: t.id,
      key: t.brick_type,
      name: t.name,
      // No parent linkage in the newsletter shape — bricks are
      // declared per-template. We allow any brick in any has_bricks
      // block by setting a synthetic parent key shared by all blocks.
      parent_block_def_key: '*',
      parent_block_def_id: '*',
      schema: (t.content.schema ?? {}) as Record<string, unknown>,
      html: t.content.html_template ?? '',
      is_current: true,
      theme_kind: 'email',
    }));
    const tplLookup: BlockTemplateLookup = {
      byKey: new Map([
        ...bd.map((d) => [d.key, { html: d.html, schema: d.schema }] as const),
        ...br.map((b) => [b.key, { html: b.html, schema: b.schema }] as const),
      ]),
    };
    return { blockDefs: bd, brickDefs: br, lookup: tplLookup };
  }, [blockTemplates, brickTemplates]);

  const renderHost: PuckRenderHost = useMemo(
    () => ({
      renderBlock: ({ blockDefKey, content, variantKey }): ReactElement => {
        const result = renderBlockClient({ blockDefKey, content, variantKey, lookup });
        return (
          <div
            className="puck-block-rendered"
            data-block-key={blockDefKey}
            dangerouslySetInnerHTML={{ __html: result.html }}
          />
        );
      },
      // Newsletter editor doesn't have host-media for inline images yet —
      // image fields fall back to a URL prompt, matching the legacy
      // newsletter behaviour. Phase D++ may wire this to the existing
      // edition image-upload utility.
      showMediaPicker: (cb) => {
        const url = window.prompt('Image URL');
        if (url) cb(url);
      },
    }),
    [lookup],
  );

  const config = useMemo(() => {
    const base = buildPuckConfig({
      libraryId: edition.id, // edition id ⇒ per-edition Config namespace
      blockDefs,
      brickDefs,
      wrappers: [],
      themeKind: 'email',
      renderHost,
    });
    // Layer the react-email registry on top — those entries' `render`
    // returns real email-safe JSX (via @react-email/components) instead
    // of going through the Mustache + iframe-string path.
    const enabledSet = enabledRegistryComponentIds
      ? new Set(enabledRegistryComponentIds)
      : undefined;
    const merged = mergeRegistryIntoConfig({
      base: base.config,
      registry: emailBlockRegistry,
      ...(enabledSet ? { enabledComponentIds: enabledSet } : {}),
    });
    // Replace the canvas root.render with a newsletter-specific shell
    // that:
    //   - injects baseline CSS into the Puck iframe (font-family,
    //     html/body reset, the 600px-max white "email card" with a
    //     subtle shadow, padding around it)
    //   - reads `previewMode` from Puck's metadata at render time so
    //     a light↔dark toggle is picked up without rebuilding the
    //     Config (rebuilding would re-mount Puck and lose selection).
    //   - wraps the canvas children in `<div class="gw-email-card">`
    //     so the inserted blocks visually sit inside the email frame
    //     the operator is composing.
    const cfg = merged.config as Config;
    const finalConfig: Config = {
      ...cfg,
      root: {
        ...((cfg.root ?? {}) as Record<string, unknown>),
        render: NewsletterCanvasRoot as never,
      },
    } as Config;
    return { ...base, config: finalConfig, registryCollisions: merged.collisions };
  }, [edition.id, blockDefs, brickDefs, renderHost, enabledRegistryComponentIds]);

  const [data, setData] = useState(() => editionToPuckData(edition, emailBlockRegistry));
  const [previewMode, setPreviewMode] = useState<'light' | 'dark'>('light');
  const [exportBusy, setExportBusy] = useState<null | 'email' | 'substack' | 'beehiiv'>(null);
  // Toggles between the WYSIWYG Puck canvas and a read-only HTML view
  // (the same email-safe markup the recipient would see). Useful for
  // operators who want to inspect / copy the source without leaving
  // the editor. State lives here so flipping doesn't unmount Puck —
  // we keep the WYSIWYG node rendered but visually hidden and overlay
  // a code panel on top of it; that way switching back doesn't lose
  // selection / undo history / scroll position.
  const [view, setView] = useState<'wysiwyg' | 'html'>('wysiwyg');
  const [htmlSource, setHtmlSource] = useState<string>('');
  const [htmlBuilding, setHtmlBuilding] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);

  // Publish flow:
  //   1. Confirm with the operator (the act is recipient-visible).
  //   2. Save the edition to the database first so the publish-to-
  //      git endpoint can find a row whose blocks match what's on
  //      screen.
  //   3. POST to /api/admin/newsletters/editions/:id/publish-to-git,
  //      which renders the edition into editions/<id>.html +
  //      editions/<id>.json on the publish branch of the per-
  //      newsletter internal git repo.
  // Status flips to 'published' server-side as part of the endpoint
  // (not done here) — until Publish is clicked the edition stays
  // as 'draft'.
  const handlePublish = async () => {
    if (publishBusy || !edition) return;
    if (typeof window !== 'undefined' && !window.confirm(
      `Publish "${edition.subject || 'this edition'}"?\n\nThis will write the edition to the newsletter's git repository and mark it as published. Recipients on subsequent sends will see this content.`,
    )) {
      return;
    }
    setPublishBusy(true);
    try {
      if (onSave) {
        await onSave({ silent: true });
      }
      const { url } = getSupabaseConfig();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch(`/api/admin/newsletters/editions/${edition.id}/publish-to-git`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `publish-to-git ${res.status}`);
      }
      toast.success('Edition published.');
      // The supabase URL var goes unused once the fetch is direct —
      // referenced here so the import doesn't get dropped if a
      // future caller routes through the supabase functions
      // namespace instead.
      void url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setPublishBusy(false);
    }
  };
  // The Substack / Beehiiv copy buttons only make sense when the
  // corresponding output-adapter module is installed (those modules
  // own the per-platform render variants we copy to clipboard).
  // The HTML download button is always available — every newsletter
  // has email-safe HTML to download regardless of which third-party
  // platforms the operator publishes to.
  const hasSubstackOutput = useHasModule('newsletters-output-substack');
  const hasBeehiivOutput = useHasModule('newsletters-output-beehiiv');
  const hasEditorAi = useHasModule('editor-ai-copilot');

  const userBlocks = useUserBlocks();

  // Layer the saved user-blocks into the Puck Config as synthetic
  // components under a "My blocks" category so they appear in the
  // left drawer alongside the platform's blocks. Each synthetic
  // renders null in the canvas — when the operator drops one, the
  // onChange handler below rewrites the inserted node into its real
  // saved subtree (with fresh ids stamped recursively), so the
  // synthetic never persists in the edition's data.
  //
  // This avoids needing publish-side awareness of the synthetic
  // type: the saved tree's outer `type` is always a real registry
  // componentId (Section / Container / Hero / …), so once expanded
  // the edition is indistinguishable from one composed by hand.
  const configWithUserBlocks = useMemo(() => {
    if (userBlocks.blocks.length === 0) return config;
    const cfg = config.config as Config;
    const components = { ...(cfg.components ?? {}) } as Record<string, Config['components'][string]>;
    const myBlocksIds: string[] = [];
    for (const ub of userBlocks.blocks) {
      const id = `user::${ub.id}`;
      myBlocksIds.push(id);
      components[id] = {
        label: ub.label,
        fields: {},
        defaultProps: {},
        // Render nothing — the synthetic is replaced via onChange the
        // moment it lands in the data tree. If the replace doesn't
        // happen for some reason (race / stale data), null is a
        // benign no-op.
        render: () => null,
      } as Config['components'][string];
    }
    const categoriesRaw = (cfg as { categories?: Record<string, { components?: string[]; title?: string; defaultExpanded?: boolean }> }).categories ?? {};
    const categories = {
      ...categoriesRaw,
      myBlocks: { components: myBlocksIds, title: 'My blocks', defaultExpanded: true },
    };
    return { ...config, config: { ...cfg, components, categories } as Config };
  }, [config, userBlocks.blocks]);

  // Re-sync from upstream when the parent edition changes by id
  // (e.g. user navigates to a different edition).
  useEffect(() => {
    setData(editionToPuckData(edition, emailBlockRegistry));
  }, [edition.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function buildBlockMeta() {
    const blockMeta = new Map<string, import('./email-blocks/EditionEmail.js').BlockRenderMeta>();
    for (const block of edition.blocks) {
      const isRegistry = emailBlockRegistry.has(block.block_template.block_type);
      blockMeta.set(
        block.id,
        isRegistry
          ? { render_kind: 'react-email', component_id: block.block_template.block_type }
          : { render_kind: 'mustache', mustache_html: block.block_template.content.html_template ?? '' },
      );
    }
    return blockMeta;
  }

  const handleExport = async (format: 'email' | 'substack' | 'beehiiv') => {
    setExportBusy(format);
    try {
      const blockMeta = buildBlockMeta();
      const html = await exportEditionHtml({ edition, format, blockMeta, pretty: true });

      if (format === 'email') {
        // Email HTML → download a .html file (recipient-safe full doc).
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${edition.id}-${edition.edition_date}.html`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Downloaded email HTML.');
      } else {
        // Substack / Beehiiv: those platforms accept rich-text paste.
        // Copy directly to clipboard as HTML so the destination editor
        // ingests headings/bold/links rather than escaped source.
        await copyHtmlToClipboard(html);
        toast.success(
          `${format === 'substack' ? 'Substack' : 'Beehiiv'} rich-text copied to clipboard. Paste into your editor.`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[newsletter-puck] export failed:', e);
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExportBusy(null);
    }
  };

  // The AI plugin (editor-ai-copilot) needs the available block defs
  // to constrain its output. For newsletters those come from BOTH the
  // DB-backed Mustache templates AND the react-email registry; the
  // copilot's default DB query against `templates_block_defs` returns
  // nothing because email registry blocks have no DB rows. We compute
  // the merged set here and supply it via the host context — the
  // copilot will skip its DB query when this is present.
  const aiBlockDefs = useMemo(
    () =>
      buildAiBlockDefs({
        blockTemplates,
        registry: emailBlockRegistry,
        ...(enabledRegistryComponentIds
          ? { enabledRegistryComponentIds: new Set(enabledRegistryComponentIds) }
          : {}),
      }) as unknown as ReadonlyArray<Record<string, unknown>>,
    [blockTemplates, enabledRegistryComponentIds],
  );

  return (
    <CanvasPluginHostContext.Provider
      value={{
        hostKind: 'newsletter',
        // hostId = newsletter (collection) id when known, otherwise
        // fall back to the edition id so the AI endpoint still has a
        // stable identifier to hang per-newsletter quota / context off.
        hostId: collectionId ?? edition.id,
        targetId: edition.id,
        // Disable AI on unsaved editions — the generate endpoint
        // looks up the edition row in newsletters_editions to build
        // its prompt context (library, blocks, preheader), and would
        // 404 with `newsletter_edition_not_found` otherwise. Save
        // the draft first, then come back to the AI tab.
        enabled: hasEditorAi && edition.id !== 'new',
        disabledReason: edition.id === 'new'
          ? 'Save the edition first, then come back to use AI to generate content.'
          : undefined,
        blockDefs: aiBlockDefs,
      }}
    >
    <NewsletterEditingProvider
      value={{
        collectionMetadata: collectionMetadata ?? {},
        collectionId,
        onSaveEdition: onSave ? (async () => { await onSave({ silent: true }); }) : undefined,
      }}
    >
    <div
      className={`newsletter-puck-canvas puck-canvas-email puck-preview-${previewMode}`}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {/* Map Puck's internal CSS variables onto the admin's Radix
          theme tokens — see PUCK_RADIX_THEME_CSS for details. */}
      <style dangerouslySetInnerHTML={{ __html: PUCK_RADIX_THEME_CSS }} />

      {/* Page-level actions row. Sits ABOVE the curved-corner panel.
          The Editor / HTML view toggle is left-aligned (it switches
          which body the panel renders — feels like a navigation
          choice). The four output actions (download HTML, copy for
          Substack / Beehiiv, Publish) are right-aligned. The
          Light / Dark preview backdrop has moved INTO Puck's
          viewport-controls row via a portal — it's a sibling to
          the Desktop / Mobile switcher because they're both
          canvas-rendering settings. */}
      <div
        className="newsletter-puck-page-actions"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div role="group" aria-label="View mode" style={toolbarSegment()}>
          <button
            type="button"
            onClick={() => setView('wysiwyg')}
            style={toolbarIconBtn(view === 'wysiwyg')}
            aria-pressed={view === 'wysiwyg'}
            aria-label="Visual editor"
            title="Visual editor"
          >
            <PencilSquareIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={async () => {
              setHtmlBuilding(true);
              try {
                const html = await exportEditionHtml({
                  edition,
                  format: 'email',
                  blockMeta: buildBlockMeta(),
                  pretty: true,
                });
                setHtmlSource(html);
                setView('html');
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[newsletter-puck] html-view render failed:', e);
                setHtmlSource(`<!-- failed to render: ${e instanceof Error ? e.message : String(e)} -->`);
                setView('html');
              } finally {
                setHtmlBuilding(false);
              }
            }}
            style={toolbarIconBtn(view === 'html', htmlBuilding)}
            aria-pressed={view === 'html'}
            aria-label="View HTML source"
            title="View the rendered email HTML source"
          >
            <CodeBracketIcon className="w-4 h-4" />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Output destinations grouped in a single connected segment
              (same visual treatment as the Light/Dark + view toggles)
              because they're all "send the edition somewhere" actions
              — the segment gives a clear shared affordance. */}
          <div role="group" aria-label="Output destination" style={toolbarSegment()}>
            <button
              type="button"
              onClick={() => handleExport('email')}
              disabled={exportBusy !== null}
              style={segmentTextBtn(false, exportBusy === 'email')}
              title="Download as email-safe HTML (full document)"
            >
              <ArrowDownTrayIcon className="w-4 h-4 shrink-0" />
              <span>{exportBusy === 'email' ? 'Exporting…' : 'HTML'}</span>
            </button>
            {hasSubstackOutput && (
              <button
                type="button"
                onClick={() => handleExport('substack')}
                disabled={exportBusy !== null}
                style={segmentTextBtn(false, exportBusy === 'substack')}
                title="Render as Substack rich text and copy to clipboard"
              >
                <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                <span>{exportBusy === 'substack' ? 'Copying…' : 'Substack'}</span>
              </button>
            )}
            {hasBeehiivOutput && (
              <button
                type="button"
                onClick={() => handleExport('beehiiv')}
                disabled={exportBusy !== null}
                style={segmentTextBtn(false, exportBusy === 'beehiiv')}
                title="Render as Beehiiv rich text and copy to clipboard"
              >
                <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                <span>{exportBusy === 'beehiiv' ? 'Copying…' : 'Beehiiv'}</span>
              </button>
            )}
          </div>

          {/* Save — persists the edition's draft to the database
              only. No git write, no recipient-visible change. The
              edition's status stays 'draft' until Publish is hit. */}
          <button
            type="button"
            onClick={async () => {
              if (!onSave) return;
              try {
                await onSave({ silent: true });
                toast.success('Draft saved.');
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Save failed');
              }
            }}
            disabled={isSavingNow}
            style={saveBtnStyle(isSavingNow)}
          >
            <span>{isSavingNow ? 'Saving…' : 'Save Draft'}</span>
          </button>

          {/* Publish — confirm with the operator first, then save +
              POST to the publish-to-git endpoint. The endpoint
              writes editions/<id>.html and editions/<id>.json into
              the publish branch of the per-newsletter git repo, so
              this is the action that makes the edition visible to
              recipients downstream. */}
          <button
            type="button"
            onClick={() => handlePublish()}
            disabled={publishBusy}
            style={publishBtnStyle(publishBusy)}
          >
            <GlobeAltIcon className="w-4 h-4 shrink-0" />
            <span>{publishBusy ? 'Publishing…' : 'Publish'}</span>
          </button>
        </div>
      </div>

      {/* MyBlocksPanel now only opens for the "Save current selection
          as block" flow — operators browse + insert via the Puck
          drawer's "My blocks" category (synthesised above). The save
          flow is fired by the in-canvas "★ Save block" action button
          which sets pendingSave; we open the modal in 'save' mode
          when that happens. */}
      <MyBlocksPanel
        open={userBlocks.pendingSave !== null}
        mode="save"
        edition={edition}
        registry={emailBlockRegistry}
        onApply={onChange}
        onClose={() => {
          userBlocks.clearPendingSave();
        }}
      />

      {/* Curved-corner panel that contains the editor itself. Mirrors
          the look of the admin's table panels (border + radius + a
          subtle shadow). The internal toolbar (view-toggle + light/
          dark) sits above the editor inside the panel since it
          affects what the panel displays — not the page as a
          whole. */}
      <div
        className="newsletter-puck-panel"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-surface, #fff)',
          border: '1px solid var(--gray-a5, #e5e7eb)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
        }}
      >
        {/* Light / Dark preview-iframe backdrop toggle is rendered
            inside Puck's ViewportControls row (next to the
            Desktop / Mobile switcher) via a portal. The portal sits
            here so it mounts after Puck has rendered its chrome. */}
        <ViewportLightDarkPortal previewMode={previewMode} setPreviewMode={setPreviewMode} />

        {/* HTML source view — appears when the operator clicks the
            <> button on the toolbar. Puck stays mounted underneath
            (display:none) so undo history + selection state survive
            the toggle. */}
        {view === 'html' && (
          <div
            className="newsletter-puck-html-view"
            style={{
              background: '#0e0f12',
              color: '#e5e7eb',
              padding: 0,
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #23262d' }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>Rendered email HTML — read-only.</span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(htmlSource);
                    toast.success('HTML copied to clipboard.');
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Copy failed');
                  }
                }}
                style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #2a2d34', background: '#1f2227', color: '#e5e7eb', cursor: 'pointer', fontSize: 12 }}
              >
                Copy
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: '12px 16px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                flex: 1,
              }}
            >
              {htmlSource}
            </pre>
          </div>
        )}

        <div style={{ display: view === 'wysiwyg' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <Puck
        config={configWithUserBlocks.config as never}
        data={data as never}
        // Inherit height from our flex-sized wrapper instead of
        // Puck's default `100dvh` (which forced the editor to be
        // the full viewport, ignoring our wrapper sizing). Combined
        // with the `_PuckLayout { height: 100% !important }` rule
        // in PUCK_RADIX_THEME_CSS, this lets the inner grid actually
        // resolve to a concrete pixel height; without the height
        // prop on the outer .Puck div, the inner 100% had nothing
        // to inherit from and Puck collapsed to its content
        // (cropping at the icon bar).
        height="100%"
        // `metadata` propagates to the canvas root.render and to every
        // component as `puck.metadata`. We only need previewMode there
        // — the canvas root reads it to switch light/dark backdrop +
        // card chrome dynamically.
        metadata={{ previewMode }}
        viewports={[
          // Puck v0.21 ships built-in Monitor / Smartphone / Tablet
          // glyphs and renders them in the viewport-switcher row above
          // the canvas. Without `icon`, Puck falls back to its generic
          // device shape (which read identically for desktop vs mobile
          // — the visual difference between the two icons was
          // imperceptible in the live editor).
          { width: 600, height: 'auto' as const, label: 'Desktop', icon: 'Monitor' },
          { width: 375, height: 'auto' as const, label: 'Mobile', icon: 'Smartphone' },
        ]}
        iframe={{ enabled: true }}
        plugins={[
          // Plugin order = sidebar tab order. Puck always prepends
          // blocksPlugin() + outlinePlugin() internally; when a user
          // plugin shares a name with one of those defaults, Puck's
          // tab registration walks `delete details[name]; details[name]
          // = …` — i.e. the second occurrence pushes the entry to the
          // END of the insertion order. We exploit that here to put
          // contributed plugins (e.g. AI) FIRST: spread them before
          // the explicit blocks/outline/fields entries, then re-pass
          // the defaults so they get bumped past the contributed tabs.
          ...getCanvasPuckPlugins(),
          blocksPlugin(),
          outlinePlugin(),
          fieldsPlugin({ desktopSideBar: 'left' }),
        ]}
        overrides={{
          // Inject "Save block" alongside Puck's default
          // delete/duplicate buttons in the contextual action bar that
          // appears around the selected component. The previous draft
          // returned a bare fragment which dropped the <ActionBar>
          // chrome (the dark pill container, padding, white text);
          // the icons rendered naked on the canvas. Rebuild the
          // default DefaultActionBar shape — <ActionBar> wrapper +
          // two <ActionBar.Group> sections (parentAction+label,
          // children+SaveAsBlockAction) — so the result matches the
          // puckeditor.com reference.
          actionBar: ({ children, parentAction, label }) => (
            <ActionBar>
              <ActionBar.Group>
                {parentAction}
                {label ? <ActionBar.Label label={label} /> : null}
              </ActionBar.Group>
              <ActionBar.Group>
                {children}
                <SaveAsBlockAction />
              </ActionBar.Group>
            </ActionBar>
          ),
          // Hide Puck's native Publish button — we render our own
          // outside the curved panel as a page-level action,
          // alongside the export buttons. Returning null here makes
          // the actions slot in Puck's header empty.
          headerActions: () => null,
        }}
        onChange={(nextData) => {
          // Convert + emit upstream. Cast through unknown because Puck's
          // `Data` type widens props to its own shape; ours is a subset.
          let nextPuck = nextData as unknown as ReturnType<typeof editionToPuckData>;

          // Drawer-inserted "My blocks" components arrive with
          // type='user::<id>' and an empty props object. Walk the tree
          // and replace each one with the saved tree (real registry
          // type + recursively-stamped fresh ids). This is the moment
          // the synthetic ceases to exist — every downstream consumer
          // (puckDataToEdition, the publish renderer, the EditionEmail
          // composer) sees only the expanded type.
          const expanded = expandUserBlockSynthetics(nextPuck, userBlocks.blocks);
          if (expanded !== nextPuck) {
            nextPuck = expanded;
          }

          setData(nextPuck);
          try {
            const nextEdition = puckDataToEdition({
              base: edition,
              data: nextPuck,
              blockTemplates,
              brickTemplates,
              registry: emailBlockRegistry,
            });
            onChange(nextEdition);
          } catch (e) {
            // Catalogue mismatch — keep the editor state but don't
            // propagate. The parent will surface a refresh prompt.
            // eslint-disable-next-line no-console
            console.warn('[newsletter-puck] adapter rejected change:', e);
          }
        }}
        onPublish={async () => {
          if (onSave) await onSave();
        }}
      />
        </div>
      </div>
    </div>
    </NewsletterEditingProvider>
    </CanvasPluginHostContext.Provider>
  );
};

export default NewsletterPuckCanvas;

// ---------------------------------------------------------------------------
// User-block synthetic expansion. The drawer's "My blocks" category
// inserts a placeholder of type `user::<saved-block-id>`; this helper
// walks Puck's content tree (recursing into slot children) and
// replaces any such placeholder with the saved tree's real
// componentId + props. Fresh ids are stamped at every level so the
// same saved block can be inserted multiple times in one session
// without colliding on Puck's identity tracking. Returns the same
// reference when nothing changes so React's setData skips re-renders.
// ---------------------------------------------------------------------------

interface UserBlockLite {
  id: string;
  tree: { type: string; props: Record<string, unknown> };
}

function expandUserBlockSynthetics(
  data: ReturnType<typeof editionToPuckData>,
  userBlocks: ReadonlyArray<UserBlockLite>,
): ReturnType<typeof editionToPuckData> {
  if (userBlocks.length === 0) return data;
  let mutated = false;

  function freshUuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
  }

  function stampIdsRecursive(node: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
    const props: Record<string, unknown> = { ...node.props, id: freshUuid() };
    if (Array.isArray(props.children)) {
      props.children = (props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
        stampIdsRecursive(c),
      );
    }
    return { type: node.type, props };
  }

  function expandOne(entry: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
    if (typeof entry.type === 'string' && entry.type.startsWith('user::')) {
      const slug = entry.type.slice(6);
      const ub = userBlocks.find((b) => b.id === slug);
      if (ub) {
        mutated = true;
        return stampIdsRecursive(ub.tree);
      }
    }
    // Recurse into nested children (slot containers like Section / Row /
    // Column / Container store their tree under props.children).
    if (Array.isArray(entry.props.children)) {
      const nextChildren = (entry.props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
        expandOne(c),
      );
      if (nextChildren.some((c, i) => c !== (entry.props.children as unknown[])[i])) {
        return { type: entry.type, props: { ...entry.props, children: nextChildren } };
      }
    }
    return entry;
  }

  const nextContent = data.content.map((b) => expandOne(b as never)) as typeof data.content;
  if (!mutated) return data;
  return { ...data, content: nextContent };
}

// ---------------------------------------------------------------------------
// Canvas root — replaces Puck's default root.render. Wraps children in
// an email-shape "card" so the iframe shows what the operator is
// actually composing (centered 600px max-width, white card on a
// light/dark backdrop, paddings + shadow + base typography).
// previewMode comes through Puck's metadata so the canvas re-renders
// when the toolbar toggle flips, without us having to rebuild the
// whole Puck Config (which would lose selection).
// ---------------------------------------------------------------------------

interface RootProps {
  children?: ReactNode;
  puck?: {
    metadata?: {
      previewMode?: 'light' | 'dark';
    };
  };
}

// Module-level Puck hook — `createUsePuck()` returns a selector-aware
// hook (the parameterless `usePuck` re-renders on every state change
// and prints a dev warning). Reading `selectedItem` lets us subscribe
// to selection changes without re-rendering for unrelated state.
const usePuckSelected = createUsePuck();

// Watches the Puck selection and switches the left sidebar to the
// Fields tab whenever a new block is selected. This replaces an
// earlier doc-level click listener that didn't work because Puck's
// DraggableComponent click handler calls e.stopPropagation() — the
// click never reached the document, so we never knew a selection
// had happened. Subscribing to selectedItem in-context bypasses the
// event pipeline entirely and works for every selection path: click,
// inline-text focus, breadcrumb, programmatic, undo/redo.
function FieldsAutoSwitcher(): null {
  const selectedId = usePuckSelected((s) => s.selectedItem?.props?.id ?? null);
  const dispatch = usePuckSelected((s) => s.dispatch);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedId && selectedId !== lastIdRef.current) {
      dispatch({
        type: 'setUi',
        ui: { plugin: { current: 'fields' }, leftSideBarVisible: true },
      });
    }
    lastIdRef.current = selectedId;
  }, [selectedId, dispatch]);

  return null;
}

function NewsletterCanvasRoot(props: RootProps) {
  const mode = props.puck?.metadata?.previewMode ?? 'light';
  const css = mode === 'dark' ? CANVAS_DARK_CSS : CANVAS_LIGHT_CSS;
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // wrapperRef lives inside the Puck iframe, so ownerDocument here
    // is the iframe document — that's where Puck's actionBar overlay
    // is portaled. Used to strip the native browser title="..."
    // tooltip on every default action-bar button (Duplicate / Delete
    // / Select parent), which is unstyleable and clashes with the
    // editor chrome. Re-run on every DOM mutation because the action
    // bar is portaled in/out around selection changes.
    const doc = wrapper.ownerDocument;
    if (!doc) return;
    const stripTitles = () => {
      doc.querySelectorAll<HTMLElement>('[class*="ActionBarAction"][title]').forEach((el) => {
        el.removeAttribute('title');
      });
    };
    stripTitles();
    const obs = new MutationObserver(stripTitles);
    obs.observe(doc.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  return (
    <>
      <style data-newsletter-canvas-css dangerouslySetInnerHTML={{ __html: BASE_CANVAS_CSS + css }} />
      <FieldsAutoSwitcher />
      <div ref={wrapperRef} className="gw-email-card">{props.children}</div>
    </>
  );
}

const BASE_CANVAS_CSS = `
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
    transition: background-color 0.15s ease;
  }
  body {
    padding: 32px 16px;
    box-sizing: border-box;
  }
  .gw-email-card {
    max-width: 600px;
    margin: 0 auto;
    border-radius: 6px;
    overflow: hidden;
    transition: background-color 0.15s ease, box-shadow 0.15s ease;
  }
  /* Reset table defaults for react-email components so authored padding
     / backgroundColor styles render predictably in the editor iframe. */
  table {
    border-collapse: collapse;
    border-spacing: 0;
  }
  /* Make sure embedded Img blocks behave like email-safe images. */
  img {
    max-width: 100%;
    height: auto;
    display: block;
  }

  /* ==========================================================
     Email-client default reset.

     Puck's CopyHostStyles ports the admin's Tailwind preflight
     (and any other parent stylesheet) into this iframe. Email
     clients DON'T have Tailwind preflight — they apply user-agent
     defaults. Without this counter-reset every <h1>/<h2>/<h3>,
     <ul>/<ol>, <a>, <blockquote> etc. inherits the admin reset
     and renders flat in the canvas, even though the same markup
     composes correctly when sent.

     Inline styles on blocks always win in cascade, so this only
     affects elements that DON'T have an explicit style — exactly
     the same as how a real recipient's mail client would render
     them. The goal: edit-time canvas matches recipient view byte
     for visible byte.

     Using em units for size so the cascade stays proportional
     (the Heading block's explicit px values still override these).
     ========================================================== */

  h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; line-height: 1.25; }
  h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0; line-height: 1.25; }
  h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0; line-height: 1.25; }
  h4 { font-size: 1em; font-weight: bold; margin: 1.33em 0; }
  h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0; }
  h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0; }

  p { margin: 1em 0; }

  /* Default link colour matches the typical Outlook / Gmail blue.
     Most email designs override per-link via inline color, so this
     is just the "no inline style" fallback. */
  a { color: #0563C1; text-decoration: underline; cursor: pointer; }

  b, strong { font-weight: bold; }
  em, i { font-style: italic; }
  small { font-size: 80%; }

  ul, ol { margin: 1em 0; padding-left: 40px; }
  ul { list-style: disc outside; }
  ol { list-style: decimal outside; }
  ul ul, ol ul { list-style: circle outside; }
  ul ul ul, ol ol ul { list-style: square outside; }
  li { display: list-item; }

  blockquote { margin: 1em 40px; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 1em 0; }

  /* Tailwind preflight sets box-sizing: border-box on all elements.
     Email clients use content-box for tables (the historical default).
     react-email's table-based layouts assume content-box widths;
     border-box subtly shifts cell widths when padding is applied,
     which makes hero/CTA cards render narrower in the canvas than
     in the inbox. Restore content-box for table-layout elements. */
  table, tr, td, th, tbody, thead, tfoot {
    box-sizing: content-box;
  }

  /* Inline-edit chrome — these rules ALSO live in the iframe-side
     CSS (this file) because Puck renders the DraggableComponent
     overlays + InlineTextField spans inside the canvas iframe.
     Parent-document <style> tags don't reach them. */

  /* Push Puck's selection / hover outline OUTSIDE the block's edge
     so the contentEditable text doesn't overlap with the chrome. */
  [class*="DraggableComponent-overlay"] {
    outline-offset: 4px !important;
  }

  /* Drop the browser default contentEditable focus ring on the
     InlineTextField span. */
  [class*="InlineTextField"]:focus,
  [class*="InlineTextField"]:focus-visible {
    outline: none !important;
  }

  /* When an InlineTextField has focus, hide the block's selection
     outline entirely. The :has() selector finds the
     DraggableComponent ancestor, then the descendant combinator
     hits the overlay element. As soon as focus leaves, the outline
     reappears so the operator can see what's selected. */
  [class*="DraggableComponent"]:has([class*="InlineTextField"]:focus) [class*="DraggableComponent-overlay"] {
    outline: none !important;
  }
  /* :focus-within fallback for older Safari (Safari pre-15.4 lacks
     :has support). Slightly broader scope but the visual outcome is
     the same: typing in any text input descendant hides the block
     outline. */
  [class*="DraggableComponent"]:focus-within [class*="DraggableComponent-overlay"] {
    outline: none !important;
  }
`;

const CANVAS_LIGHT_CSS = `
  body { background-color: #fafbfc; color: #14171E; }
  .gw-email-card { background-color: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06); }
`;

const CANVAS_DARK_CSS = `
  body { background-color: #0e0f12; color: #e5e7eb; }
  .gw-email-card { background-color: #1a1c20; box-shadow: 0 0 0 1px rgba(255,255,255,0.06); }
`;

// ---------------------------------------------------------------------------
// Toolbar helpers — small inline-style factories so the dark/light theme
// toggle threads consistently through every button without adding a
// stylesheet. Style polishing can later move these to a CSS file.
// ---------------------------------------------------------------------------

// Puck's azure (accent) + grey scales remapped to Radix tokens. Puck
// uses 01 (darkest) → 12 (lightest); Radix uses 1 (lightest) → 12
// (darkest), hence the inverted mapping. The scoped `.newsletter-
// puck-canvas` class keeps this isolated to the newsletter editor.
const PUCK_RADIX_THEME_CSS = `
.newsletter-puck-canvas {
  --puck-color-azure-01: var(--accent-12);
  --puck-color-azure-02: var(--accent-11);
  --puck-color-azure-03: var(--accent-10);
  --puck-color-azure-04: var(--accent-9);
  --puck-color-azure-05: var(--accent-8);
  --puck-color-azure-06: var(--accent-7);
  --puck-color-azure-07: var(--accent-6);
  --puck-color-azure-08: var(--accent-5);
  --puck-color-azure-09: var(--accent-4);
  --puck-color-azure-10: var(--accent-3);
  --puck-color-azure-11: var(--accent-2);
  --puck-color-azure-12: var(--accent-1);

  --puck-color-grey-01: var(--gray-12);
  --puck-color-grey-02: var(--gray-11);
  --puck-color-grey-03: var(--gray-10);
  --puck-color-grey-04: var(--gray-9);
  --puck-color-grey-05: var(--gray-8);
  --puck-color-grey-06: var(--gray-7);
  --puck-color-grey-07: var(--gray-6);
  --puck-color-grey-08: var(--gray-5);
  --puck-color-grey-09: var(--gray-4);
  --puck-color-grey-10: var(--gray-3);
  --puck-color-grey-11: var(--gray-2);
  --puck-color-grey-12: var(--gray-1);

  --puck-color-red-04: var(--red-9, #ac1f35);
  --puck-color-red-05: var(--red-8, #bf5366);
  --puck-color-red-09: var(--red-4, #f3c8d2);

  --puck-color-green-04: var(--green-9, #0c680c);
  --puck-color-green-09: var(--green-4, #b8e8bf);
}

/* Hide Puck's entire native header row — the bar that contains the
   sidebar visibility toggles, undo/redo, and (formerly) the page
   title + Publish button. Per operator request: looks closer to the
   puckeditor.com aesthetic without that secondary chrome. The
   actions we still need (Publish, exports, view toggle) live in our
   own page-level toolbar above the curved panel; undo/redo can come
   back in a follow-up via the same portal pattern as Light/Dark if
   needed. */
.newsletter-puck-canvas [class*="PuckLayout-header"] {
  display: none !important;
}

/* Puck's left tab strip ships with padding-top: 32px on .Nav-list
   to push the first plugin button below the (now-hidden) header row.
   With our header hidden the 32px gap read as a stray empty zone,
   but zero padding made the first tab's blue active-state indicator
   sit flush against the panel's top edge. 8px is just enough to
   tuck the indicator inside the curved corner of the panel. */
.newsletter-puck-canvas [class*="Nav-list"] {
  padding-top: 8px !important;
}

/* Puck's ViewportControls-actionsInner has overflow: hidden. Our
   ViewportLightDarkPortal portals Sun + Moon buttons into that row
   so they sit next to Desktop / Mobile / Zoom; without this rule
   the buttons get visually clipped when the row's flex layout runs
   out of width. */
.newsletter-puck-canvas [class*="ViewportControls-actionsInner"] {
  overflow: visible !important;
}

/* Puck's outer PuckLayout wrapper ships with height: 100dvh, which
   forces the editor to be the FULL viewport height regardless of how
   tall its actual container (our editorHeight-constrained wrapper)
   is. The wrapper's overflow: hidden clips Puck visually, but
   internally Puck's grid still allocates a 100dvh row to the
   Sidebar — so when the operator scrolls the Fields drawer, scroll
   events bubble through a Sidebar that thinks it has more vertical
   space than it does, and the whole layout (icon menu included)
   appears to scroll together.

   Force PuckLayout to inherit the wrapper's height, and tell its
   internal scrollable areas to contain their scroll instead of
   chaining up to ancestors. The "_PuckLayout_" attribute selector
   (with the trailing underscore) matches only the outer class, not
   the _PuckLayout-inner_ / _PuckLayout--mounted_ variants. */
.newsletter-puck-canvas [class*="_PuckLayout_"] {
  height: 100% !important;
}
.newsletter-puck-canvas [class*="_Sidebar_"],
.newsletter-puck-canvas [class*="_Nav_"],
.newsletter-puck-canvas [class*="_PuckPluginTab_"] {
  overscroll-behavior: contain;
}

/* The previous draft used padding on PuckLayout-nav and Sidebar--
   right to push their contents inward to align with the hero text.
   Now that the editor lives inside a curved-corner panel, the panel
   itself defines the inset — padding inside Puck would create a
   visible gutter against the panel's rounded border, which looks
   worse than flush chrome. Removed. */

/* Puck draws a 2px selection / hover outline on the DraggableComponent
   overlay with outline-offset: -2px, so the outline sits INSIDE the
   block's edge and overlaps text being inline-edited. Shift the
   outline OUTSIDE the block (positive offset) so the contentEditable
   span has visual breathing room from the selection chrome. */
.newsletter-puck-canvas [class*="DraggableComponent-overlay"] {
  outline-offset: 4px !important;
}

/* Puck's InlineTextField span gets the browser's default focus ring
   (a thick blue outline) when contentEditable is active. The Puck
   selection chrome is already visually communicating "this is
   editable", so the browser ring is redundant — drop it. */
.newsletter-puck-canvas [class*="InlineTextField"]:focus,
.newsletter-puck-canvas [class*="InlineTextField"]:focus-visible {
  outline: none !important;
}

/* While the operator is actively typing in an InlineTextField, hide
   Puck's block selection outline entirely. Two competing borders
   (block selection + the InlineTextField active-state ring) made
   the canvas look noisy during edit. The :has() selector targets
   the DraggableComponent ancestor when an InlineTextField inside
   it has focus. */
.newsletter-puck-canvas [class*="DraggableComponent"]:has([class*="InlineTextField"]:focus) [class*="DraggableComponent-overlay"] {
  outline: none !important;
}
`;

function toolbarSegment(): React.CSSProperties {
  return {
    display: 'inline-flex',
    border: '1px solid var(--gray-a6, #ccc)',
    borderRadius: 4,
    overflow: 'hidden',
    background: 'var(--color-surface, #fff)',
  };
}

// ---------------------------------------------------------------------------
// ViewportLightDarkPortal — the Light / Dark backdrop toggle is a
// canvas-rendering setting (it changes the iframe's body background
// to simulate a light vs dark mail-client). Visually it belongs next
// to the Desktop / Mobile viewport switcher Puck draws inside its
// `_ViewportControls-actionsInner_*` row. Puck doesn't expose an
// override for that row, so we render via a React portal: poll for
// the element on mount (it appears after Puck initialises its
// chrome) and inject our buttons there once we find it.
// ---------------------------------------------------------------------------

function ViewportLightDarkPortal({
  previewMode,
  setPreviewMode,
}: {
  previewMode: 'light' | 'dark';
  setPreviewMode: (mode: 'light' | 'dark') => void;
}): ReactElement | null {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(() => {
    function find(): HTMLElement | null {
      // Target the actionsInner flex row that holds Desktop / Mobile
      // / Zoom controls so our Sun + Moon buttons sit alongside them.
      // The inner has `overflow: hidden` in Puck's default CSS — the
      // PUCK_RADIX_THEME_CSS block below relaxes that to `visible`
      // so our portal children aren't clipped.
      const candidates = document.querySelectorAll<HTMLElement>(
        '.newsletter-puck-canvas [class*="ViewportControls-actionsInner"]',
      );
      return candidates[candidates.length - 1] ?? null;
    }

    // Initial probe; the row may not exist yet on first render.
    setTarget(find());

    // MutationObserver catches both the initial mount of Puck's
    // ViewportControls and any future replacement (e.g., when Puck
    // re-renders the row). The previous rAF-polling version stopped
    // as soon as it found ONE node — if that node was later detached
    // (Puck re-rendered the controls), the portal silently broke and
    // the Light/Dark buttons disappeared.
    const obs = new MutationObserver(() => {
      const next = find();
      setTarget((prev) => {
        if (next === prev) return prev;
        // If the previous target was detached, swap to the new one.
        if (prev && !prev.isConnected) return next;
        // Otherwise stick with prev unless a different node appeared.
        return next ?? prev;
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  if (!target) return null;

  return createPortal(
    <div role="group" aria-label="Preview background" style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 8 }}>
      <button
        type="button"
        onClick={() => setPreviewMode('light')}
        style={portalIconBtn(previewMode === 'light')}
        aria-pressed={previewMode === 'light'}
        aria-label="Light background preview"
        title="Preview against a light mail-client background"
      >
        <SunIcon className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => setPreviewMode('dark')}
        style={portalIconBtn(previewMode === 'dark')}
        aria-pressed={previewMode === 'dark'}
        aria-label="Dark background preview"
        title="Preview against a dark mail-client background"
      >
        <MoonIcon className="w-4 h-4" />
      </button>
    </div>,
    target,
  );
}

function portalIconBtn(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    border: 'none',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: 'pointer',
    borderRadius: 4,
  };
}

// Shared button height across every toolbar control so HTML /
// Substack / Beehiiv / Publish (and the icon-only segments) all line
// up cleanly. Tweak here once if the toolbar density changes.
const TOOLBAR_BTN_HEIGHT = 32;

function toolbarIconBtn(active: boolean, busy = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: TOOLBAR_BTN_HEIGHT,
    border: 'none',
    borderRight: '1px solid var(--gray-a4, #eee)',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  };
}

function segmentTextBtn(active: boolean, busy = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    height: TOOLBAR_BTN_HEIGHT,
    border: 'none',
    borderRight: '1px solid var(--gray-a4, #eee)',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

function saveBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    height: TOOLBAR_BTN_HEIGHT,
    border: '1px solid var(--gray-a6, #ccc)',
    borderRadius: 6,
    background: 'var(--color-surface, #fff)',
    color: 'var(--gray-12, #14171E)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

function publishBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 14px',
    height: TOOLBAR_BTN_HEIGHT,
    border: '1px solid var(--accent-9, #14171E)',
    borderRadius: 6,
    background: 'var(--accent-9, #14171E)',
    color: 'var(--accent-contrast, #fff)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    fontWeight: 500,
    opacity: busy ? 0.7 : 1,
    whiteSpace: 'nowrap',
  };
}

/**
 * Copy an HTML string to the clipboard as **rich content** (so paste
 * targets like Substack / Beehiiv ingest formatting), with a plain-
 * text fallback. Uses the modern Clipboard API where available; falls
 * back to a hidden contenteditable for older browsers.
 */
async function copyHtmlToClipboard(html: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && 'write' in navigator.clipboard) {
    const blob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([stripTags(html)], { type: 'text/plain' });
    const item = new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob });
    await navigator.clipboard.write([item]);
    return;
  }
  // Fallback — synchronous selection + execCommand on a hidden node.
  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.innerHTML = html;
  div.style.position = 'fixed';
  div.style.opacity = '0';
  document.body.appendChild(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('copy');
  sel?.removeAllRanges();
  document.body.removeChild(div);
}

function stripTags(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}
