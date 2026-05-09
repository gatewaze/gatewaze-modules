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

import { useEffect, useMemo, useState, type FC, type ReactElement, type ReactNode } from 'react';
import { Puck, type Config } from '@puckeditor/core';
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
  const [myBlocksOpen, setMyBlocksOpen] = useState(false);

  const userBlocks = useUserBlocks();

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
      style={{
        // Preview-only chrome: changes the background AROUND the email
        // iframe so operators can see how their email looks against a
        // light or dark mail-client backdrop. Doesn't affect the
        // exported HTML.
        background: previewMode === 'dark' ? '#0e0f12' : '#fafbfc',
        transition: 'background 0.15s ease',
      }}
    >
      <div
        className="newsletter-puck-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: previewMode === 'dark' ? '1px solid #23262d' : '1px solid #eee',
          background: previewMode === 'dark' ? '#1a1c20' : '#fff',
          color: previewMode === 'dark' ? '#e5e7eb' : 'inherit',
        }}
      >
        <button
          type="button"
          onClick={() => setMyBlocksOpen(true)}
          style={toolbarBtn(previewMode)}
          title="Insert a block you previously saved"
        >
          ★ My blocks{userBlocks.blocks.length > 0 ? ` (${userBlocks.blocks.length})` : ''}
        </button>

        {/* Preview mode toggle — light / dark */}
        <div role="group" aria-label="Preview background" style={toolbarSegment(previewMode)}>
          <button
            type="button"
            onClick={() => setPreviewMode('light')}
            style={toolbarSegmentBtn(previewMode === 'light', previewMode)}
            aria-pressed={previewMode === 'light'}
            title="Preview against a light mail-client background"
          >
            ☀ Light
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode('dark')}
            style={toolbarSegmentBtn(previewMode === 'dark', previewMode)}
            aria-pressed={previewMode === 'dark'}
            title="Preview against a dark mail-client background"
          >
            ☾ Dark
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Output format dropdown */}
        <div style={toolbarSegment(previewMode)}>
          <button
            type="button"
            onClick={() => handleExport('email')}
            disabled={exportBusy !== null}
            style={toolbarSegmentBtn(false, previewMode, exportBusy === 'email')}
            title="Download as email-safe HTML (full document)"
          >
            {exportBusy === 'email' ? 'Exporting…' : 'Email HTML'}
          </button>
          <button
            type="button"
            onClick={() => handleExport('substack')}
            disabled={exportBusy !== null}
            style={toolbarSegmentBtn(false, previewMode, exportBusy === 'substack')}
            title="Render as Substack rich text and copy to clipboard"
          >
            {exportBusy === 'substack' ? 'Exporting…' : 'Substack'}
          </button>
          <button
            type="button"
            onClick={() => handleExport('beehiiv')}
            disabled={exportBusy !== null}
            style={toolbarSegmentBtn(false, previewMode, exportBusy === 'beehiiv')}
            title="Render as Beehiiv rich text and copy to clipboard"
          >
            {exportBusy === 'beehiiv' ? 'Exporting…' : 'Beehiiv'}
          </button>
        </div>
      </div>

      {exportToast && (
        <div
          role="status"
          style={{
            padding: '8px 12px',
            background: previewMode === 'dark' ? '#1f3a2a' : '#ecfdf3',
            color: previewMode === 'dark' ? '#a7e8c4' : '#065f46',
            fontSize: 13,
            borderBottom: '1px solid rgba(0,0,0,0.05)',
          }}
        >
          {exportToast}
        </div>
      )}
      <MyBlocksPanel
        open={myBlocksOpen || userBlocks.pendingSave !== null}
        mode={userBlocks.pendingSave !== null ? 'save' : 'browse'}
        edition={edition}
        registry={emailBlockRegistry}
        onApply={onChange}
        onClose={() => {
          setMyBlocksOpen(false);
          userBlocks.clearPendingSave();
        }}
      />
      <Puck
        config={config.config as never}
        data={data as never}
        // `metadata` propagates to the canvas root.render and to every
        // component as `puck.metadata`. We only need previewMode there
        // — the canvas root reads it to switch light/dark backdrop +
        // card chrome dynamically.
        metadata={{ previewMode }}
        viewports={[
          { width: 600, height: 'auto' as const, label: 'Desktop' },
          { width: 375, height: 'auto' as const, label: 'Mobile' },
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
        }}
        onChange={(nextData) => {
          // Convert + emit upstream. Cast through unknown because Puck's
          // `Data` type widens props to its own shape; ours is a subset.
          const nextPuck = nextData as unknown as ReturnType<typeof editionToPuckData>;
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
    </NewsletterEditingProvider>
  );
};

export default NewsletterPuckCanvas;

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

function toolbarBtn(mode: 'light' | 'dark'): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 4,
    border: mode === 'dark' ? '1px solid #2a2d34' : '1px solid #ccc',
    background: mode === 'dark' ? '#1f2227' : '#fff',
    color: mode === 'dark' ? '#e5e7eb' : 'inherit',
    cursor: 'pointer',
    fontSize: 13,
  };
}

function toolbarSegment(mode: 'light' | 'dark'): React.CSSProperties {
  return {
    display: 'inline-flex',
    border: mode === 'dark' ? '1px solid #2a2d34' : '1px solid #ccc',
    borderRadius: 4,
    overflow: 'hidden',
    background: mode === 'dark' ? '#1f2227' : '#fff',
  };
}

function toolbarSegmentBtn(
  active: boolean,
  mode: 'light' | 'dark',
  busy = false,
): React.CSSProperties {
  return {
    padding: '6px 12px',
    border: 'none',
    borderRight: mode === 'dark' ? '1px solid #2a2d34' : '1px solid #eee',
    background: active
      ? (mode === 'dark' ? '#2a2d34' : '#eef2f7')
      : 'transparent',
    color: mode === 'dark' ? '#e5e7eb' : 'inherit',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 13,
    opacity: busy ? 0.7 : 1,
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
