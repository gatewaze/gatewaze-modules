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
import { Puck, type Config } from '@puckeditor/core';
import {
  PencilSquareIcon,
  CodeBracketIcon,
  SunIcon,
  MoonIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  ClipboardDocumentIcon,
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
  enabledRegistryComponentIds,
  collectionMetadata,
}) => {
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
  const [exportToast, setExportToast] = useState<string | null>(null);
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
  // Three export targets (HTML download / Substack copy / Beehiiv
  // copy) collapse into a single dropdown so the toolbar stays
  // visually quiet — three side-by-side buttons with similar
  // iconography were hard to scan.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [exportMenuOpen]);

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
    setExportToast(null);
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
        setExportToast('Downloaded email HTML.');
      } else {
        // Substack / Beehiiv: those platforms accept rich-text paste.
        // Copy directly to clipboard as HTML so the destination editor
        // ingests headings/bold/links rather than escaped source.
        await copyHtmlToClipboard(html);
        setExportToast(`${format === 'substack' ? 'Substack' : 'Beehiiv'} rich-text copied to clipboard. Paste into your editor.`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[newsletter-puck] export failed:', e);
      setExportToast(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExportBusy(null);
      // auto-dismiss the toast after a few seconds
      setTimeout(() => setExportToast(null), 4000);
    }
  };

  return (
    <NewsletterEditingProvider
      value={{
        collectionMetadata: collectionMetadata ?? {},
        onSaveEdition: onSave ? (async () => { await onSave({ silent: true }); }) : undefined,
      }}
    >
    <div
      className={`newsletter-puck-canvas puck-canvas-email puck-preview-${previewMode}`}
      style={{ background: '#fafbfc', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Map Puck's internal CSS variables onto the admin's Radix
          theme tokens so the editor inherits gatewaze's accent +
          neutral palette instead of Puck's default azure/grey scales.
          Puck's scale runs darkest (01) → lightest (12); Radix runs
          the opposite way (1 → 12), so step N on Puck maps to step
          (13 - N) on Radix.

          Scoped to .newsletter-puck-canvas so it doesn't bleed into
          sites' Puck canvas (which keeps the default theme until
          sites is themed too). */}
      <style dangerouslySetInnerHTML={{ __html: PUCK_RADIX_THEME_CSS }} />
      {/* The custom toolbar + edition-metadata bar that used to sit
          above Puck have moved:
            - Subject / date / preheader live on the edition's
              "Details" tab (editions/[id].tsx).
            - Editor / HTML, Light / Dark, and Email HTML / Substack
              / Beehiiv buttons are injected into Puck's `header`
              override below so they share a row with Puck's own
              "Page" label and Publish button.
          The export-toast still surfaces here as a thin strip when
          relevant. */}
      {exportToast && (
        <div
          role="status"
          style={{
            padding: '8px 12px',
            background: '#ecfdf3',
            color: '#065f46',
            fontSize: 13,
            borderBottom: '1px solid rgba(0,0,0,0.05)',
          }}
        >
          {exportToast}
        </div>
      )}

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
      {/* HTML source view — appears when the operator clicks "<> HTML"
          on the toolbar. The Puck canvas stays mounted in the
          sibling div below (display:none) so undo history + selection
          state survive the toggle. */}
      {view === 'html' && (
        <div
          className="newsletter-puck-html-view"
          style={{
            background: '#0e0f12',
            color: '#e5e7eb',
            padding: 0,
            minHeight: 480,
            position: 'relative',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #23262d' }}>
            <span style={{ fontSize: 12, color: '#9ca3af' }}>Rendered email HTML — read-only.</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(htmlSource);
                  setExportToast('HTML copied to clipboard.');
                  setTimeout(() => setExportToast(null), 3000);
                } catch (e) {
                  setExportToast(e instanceof Error ? e.message : 'Copy failed');
                  setTimeout(() => setExportToast(null), 3000);
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
              maxHeight: 'calc(100vh - 280px)',
            }}
          >
            {htmlSource}
          </pre>
        </div>
      )}

      <div style={{ display: view === 'wysiwyg' ? 'block' : 'none' }}>
      <Puck
        config={configWithUserBlocks.config as never}
        data={data as never}
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
        overrides={{
          // Inject "★ Save block" alongside Puck's default
          // delete/duplicate buttons in the contextual action bar that
          // appears around the selected component. Inside this
          // override, `usePuck()` resolves to the active Puck context
          // so SaveAsBlockAction can read the selected item directly.
          actionBar: ({ children, parentAction }) => (
            <>
              {parentAction}
              {children}
              <SaveAsBlockAction />
            </>
          ),
          // headerActions inserts our buttons into the right-side
          // actions slot of Puck's native header — alongside the
          // Publish button. This keeps Puck's left-side chrome
          // (sidebar toggles + undo/redo) intact and avoids the
          // duplicate-Publish issue an earlier `header` override
          // produced (Puck passes the FULL default header — including
          // its own actions slot — as `children`, plus a separate
          // `actions` prop for the Publish button; rendering both
          // doubled the button up).
          //
          // The "Page" title is hidden via the CSS in
          // PUCK_RADIX_THEME_CSS (a [class*=PuckLayout-title] rule).
          headerActions: ({ children }) => (
            <>
              {/* Editor / HTML view toggle */}
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

              {/* Light / Dark preview-iframe backdrop toggle */}
              <div role="group" aria-label="Preview background" style={toolbarSegment()}>
                <button
                  type="button"
                  onClick={() => setPreviewMode('light')}
                  style={toolbarIconBtn(previewMode === 'light')}
                  aria-pressed={previewMode === 'light'}
                  aria-label="Light background preview"
                  title="Preview against a light mail-client background"
                >
                  <SunIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode('dark')}
                  style={toolbarIconBtn(previewMode === 'dark')}
                  aria-pressed={previewMode === 'dark'}
                  aria-label="Dark background preview"
                  title="Preview against a dark mail-client background"
                >
                  <MoonIcon className="w-4 h-4" />
                </button>
              </div>

              {/* Export menu — single share button opens a dropdown
                  with the three destinations. Three icon-only buttons
                  side-by-side were too easy to confuse since
                  Substack and Beehiiv share copy semantics. */}
              <div ref={exportMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setExportMenuOpen((v) => !v)}
                  disabled={exportBusy !== null}
                  style={toolbarIconBtn(exportMenuOpen, exportBusy !== null)}
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  aria-label="Export"
                  title="Export — download HTML or copy for Substack / Beehiiv"
                >
                  <ArrowUpTrayIcon className="w-4 h-4" />
                </button>
                {exportMenuOpen && (
                  <div role="menu" style={exportMenuStyle}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setExportMenuOpen(false); void handleExport('email'); }}
                      style={exportMenuItemStyle}
                    >
                      <ArrowDownTrayIcon className="w-4 h-4 shrink-0" />
                      <span style={{ flex: 1, textAlign: 'left' }}>
                        <span style={{ display: 'block', fontWeight: 500 }}>Download HTML</span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--gray-9, #888)' }}>Email-safe full document</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setExportMenuOpen(false); void handleExport('substack'); }}
                      style={exportMenuItemStyle}
                    >
                      <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                      <span style={{ flex: 1, textAlign: 'left' }}>
                        <span style={{ display: 'block', fontWeight: 500 }}>Copy for Substack</span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--gray-9, #888)' }}>Rich-text — paste into Substack editor</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setExportMenuOpen(false); void handleExport('beehiiv'); }}
                      style={exportMenuItemStyle}
                    >
                      <ClipboardDocumentIcon className="w-4 h-4 shrink-0" />
                      <span style={{ flex: 1, textAlign: 'left' }}>
                        <span style={{ display: 'block', fontWeight: 500 }}>Copy for Beehiiv</span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--gray-9, #888)' }}>Rich-text — paste into Beehiiv editor</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              {children}
            </>
          ),
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
    </NewsletterEditingProvider>
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

function NewsletterCanvasRoot(props: RootProps) {
  const mode = props.puck?.metadata?.previewMode ?? 'light';
  const css = mode === 'dark' ? CANVAS_DARK_CSS : CANVAS_LIGHT_CSS;
  return (
    <>
      <style data-newsletter-canvas-css dangerouslySetInnerHTML={{ __html: BASE_CANVAS_CSS + css }} />
      <div className="gw-email-card">{props.children}</div>
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

/* Hide Puck's default "Page" header title. The class on Puck v0.21
   is _PuckHeader-title_<hash> (an earlier pass guessed
   PuckLayout-title — wrong; the title lives in PuckHeader). The
   hash changes between builds, so target via a substring-prefix
   attribute selector. */
.newsletter-puck-canvas [class*="PuckHeader-title"] {
  display: none;
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

function toolbarIconBtn(active: boolean, busy = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 28,
    border: 'none',
    borderRight: '1px solid var(--gray-a4, #eee)',
    background: active ? 'var(--accent-a3, #eef2f7)' : 'transparent',
    color: active ? 'var(--accent-11, #14171E)' : 'var(--gray-12, inherit)',
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  };
}

const exportMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  minWidth: 280,
  background: 'var(--color-surface, #fff)',
  border: '1px solid var(--gray-a5, #e5e7eb)',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  zIndex: 100,
};

const exportMenuItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 10px',
  border: 'none',
  background: 'transparent',
  borderRadius: 6,
  color: 'var(--gray-12, #14171E)',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  width: '100%',
};

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
