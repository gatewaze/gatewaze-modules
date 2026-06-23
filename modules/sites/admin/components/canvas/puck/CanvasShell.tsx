/**
 * CanvasShell — the shared chrome around a Puck mount.
 *
 * Both the newsletter edition editor and the site page editor use this
 * shell so the two surfaces look and behave identically (same plugin
 * tab strip, same Desktop/Mobile viewport switch, same Light/Dark
 * backdrop toggle, same curved-corner panel, same iframe scoping,
 * same AI plugin wiring). Host-specific actions (Substack/Beehiiv
 * export, Publish, Save Draft for newsletters; Publish-to-git for
 * sites) live in the `toolbar` slot above the panel.
 *
 * Component boundaries:
 *
 *   - Outer:  host page provides its own outer providers (e.g.
 *             NewsletterEditingProvider, UserBlocksProvider) BEFORE
 *             rendering CanvasShell. CanvasShell never needs those.
 *
 *   - Inside: CanvasShell renders the toolbar prop, the curved
 *             panel, the Puck mount (with shared overrides + plugin
 *             spread + viewports + iframe), the Light/Dark portal,
 *             and the scoped CanvasPluginHostContext.Provider.
 *
 *   - Below:  host components supply config / data / onChange /
 *             onPublish / per-host overrides / extraMetadata.
 *
 * The CSS scope class is fixed to `.gw-canvas-shell` so the theme
 * variables map uniformly across hosts. Hosts that need to add their
 * own selectors (e.g. newsletter's `.puck-canvas-email`) pass them
 * via `className`.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Puck,
  type Config,
  type Data,
  type Overrides,
  type Plugin,
  blocksPlugin,
  outlinePlugin,
  fieldsPlugin,
} from '@puckeditor/core';
import { SunIcon, MoonIcon } from '@heroicons/react/24/outline';
import { getCanvasPuckPlugins } from './canvas-puck-plugin-registry.js';
import { DraggableOutline } from './DraggableOutline.js';
import { CanvasPluginHostContext, type CanvasPluginHostKind } from './canvas-plugin-host-context.js';

export type CanvasPreviewMode = 'light' | 'dark';

export interface CanvasShellViewport {
  width: number | '100%';
  height?: number | 'auto';
  label: string;
  icon?: 'Monitor' | 'Smartphone' | 'Tablet';
}

export interface CanvasShellProps {
  // ─── Host identity ────────────────────────────────────────────────
  hostKind: CanvasPluginHostKind;
  hostId: string;
  targetId: string;

  // ─── AI plugin gate ───────────────────────────────────────────────
  /** False hides the AI tab (plugin still mounted but PaneMount returns null). */
  aiEnabled?: boolean;
  /** Shown by the AI tab when aiEnabled is false. */
  aiDisabledReason?: string;
  /** Optional client-supplied block defs (newsletters' registry case). */
  blockDefs?: ReadonlyArray<Record<string, unknown>>;

  // ─── Puck data + lifecycle ────────────────────────────────────────
  config: Config;
  data: Data;
  onChange?: (data: Data) => void;
  onPublish?: (data: Data) => void;

  // ─── Customization slots ──────────────────────────────────────────
  /** Host-specific actions rendered ABOVE the curved panel. */
  toolbar?: ReactNode;
  /** Merged with shared overrides (host wins on collision). */
  overrides?: Partial<Overrides>;
  /** Prepended to the plugin list — runs BEFORE the AI tab. */
  extraPlugins?: ReadonlyArray<Plugin>;
  /**
   * Viewport set. Defaults to Desktop (1280) + Mobile (375) for sites;
   * newsletters override with Desktop (600) + Mobile (375) to match
   * the email column width. Single 600-wide entry for email-only
   * libraries.
   */
  viewports?: ReadonlyArray<CanvasShellViewport>;
  /** Merged with shared metadata (`{ previewMode }`). Host wins on collision. */
  extraMetadata?: Record<string, unknown>;
  /** Extra class names appended to the shell root for host-specific CSS hooks. */
  className?: string;
  /** Initial preview-backdrop colour. Defaults to 'light'. */
  initialPreviewMode?: CanvasPreviewMode;
}

// Defaults match the newsletter editor's existing chrome — both hosts
// should land on the same look out of the box.
const DEFAULT_VIEWPORTS: CanvasShellViewport[] = [
  { width: 1280, height: 'auto', label: 'Desktop', icon: 'Monitor' },
  { width: 375, height: 'auto', label: 'Mobile', icon: 'Smartphone' },
];

export function CanvasShell(props: CanvasShellProps): ReactElement {
  const {
    hostKind,
    hostId,
    targetId,
    aiEnabled = true,
    aiDisabledReason,
    blockDefs,
    config,
    data,
    onChange,
    onPublish,
    toolbar,
    overrides,
    extraPlugins = [],
    viewports = DEFAULT_VIEWPORTS,
    extraMetadata,
    className = '',
    initialPreviewMode = 'light',
  } = props;

  const [previewMode, setPreviewMode] = useState<CanvasPreviewMode>(initialPreviewMode);

  // Plugin spread — see NewsletterPuckCanvas history for the
  // duplicate-name re-insertion trick. Puck always prepends blocks +
  // outline; we want our extras (notably AI) FIRST. Re-pass blocks /
  // outline / fields after our extras so Puck's tab map bumps them to
  // the end.
  const plugins = useMemo<Plugin[]>(() => [
    ...extraPlugins,
    ...getCanvasPuckPlugins(),
    blocksPlugin(),
    outlinePlugin(),
    // Fields live in the RIGHT sidebar so selecting a block opens its fields
    // *alongside* whatever left tab is active (Blocks / AI / Outline) instead of
    // hijacking the left panel and yanking the operator out of the block picker.
    fieldsPlugin({ desktopSideBar: 'right' }),
  ], [extraPlugins]);

  // Merged overrides — shared defaults first, host overrides win.
  const mergedOverrides = useMemo<Partial<Overrides>>(() => ({
    // Hide Puck's native header (operators want a clean look matching
    // puckeditor.com; the toolbar above the panel takes its place).
    headerActions: () => null,
    // Replace the click-only outline with a drag-to-reorder one.
    outline: () => <DraggableOutline />,
    ...(overrides ?? {}),
  }), [overrides]);

  const mergedMetadata = useMemo<Record<string, unknown>>(() => ({
    previewMode,
    ...(extraMetadata ?? {}),
  }), [previewMode, extraMetadata]);

  return (
    <CanvasPluginHostContext.Provider
      value={{
        hostKind,
        hostId,
        targetId,
        enabled: aiEnabled,
        ...(aiDisabledReason ? { disabledReason: aiDisabledReason } : {}),
        ...(blockDefs ? { blockDefs } : {}),
      }}
    >
      <div
        className={`gw-canvas-shell gw-canvas-shell--preview-${previewMode}${className ? ` ${className}` : ''}`}
        style={S.root}
      >
        <style dangerouslySetInnerHTML={{ __html: SHELL_CSS }} />

        {toolbar && <div className="gw-canvas-shell__toolbar" style={S.toolbar}>{toolbar}</div>}

        <div className="gw-canvas-shell__panel" style={S.panel}>
          <Puck
            config={config as never}
            data={data as never}
            // Inherit height from the flex-sized wrapper instead of
            // Puck's default 100dvh. Combined with the
            // _PuckLayout { height: 100% !important } rule below this
            // lets the inner grid resolve to a concrete pixel height.
            height="100%"
            iframe={{ enabled: true }}
            metadata={mergedMetadata as never}
            viewports={viewports as never}
            plugins={plugins as never}
            overrides={mergedOverrides as never}
            onPublish={onPublish as never}
            onChange={onChange as never}
          />
          <ViewportLightDarkPortal previewMode={previewMode} setPreviewMode={setPreviewMode} />
        </div>
      </div>
    </CanvasPluginHostContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Light / Dark backdrop portal
// ---------------------------------------------------------------------------

function ViewportLightDarkPortal({
  previewMode,
  setPreviewMode,
}: {
  previewMode: CanvasPreviewMode;
  setPreviewMode: (mode: CanvasPreviewMode) => void;
}): ReactElement | null {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(() => {
    function find(): HTMLElement | null {
      // Target Puck's internal viewport-controls row so our Sun + Moon
      // buttons sit alongside Desktop / Mobile / Zoom. The container's
      // overflow: hidden gets relaxed in SHELL_CSS so portal children
      // aren't clipped when the row's flex layout runs out of width.
      const candidates = document.querySelectorAll<HTMLElement>(
        '.gw-canvas-shell [class*="ViewportControls-actionsInner"]',
      );
      return candidates[candidates.length - 1] ?? null;
    }

    setTarget(find());

    const obs = new MutationObserver(() => {
      const next = find();
      setTarget((prev) => {
        if (next === prev) return prev;
        if (prev && !prev.isConnected) return next;
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
        title="Preview against a light background"
      >
        <SunIcon className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => setPreviewMode('dark')}
        style={portalIconBtn(previewMode === 'dark')}
        aria-pressed={previewMode === 'dark'}
        aria-label="Dark background preview"
        title="Preview against a dark background"
      >
        <MoonIcon className="w-4 h-4" />
      </button>
    </div>,
    target,
  );
}

function portalIconBtn(active: boolean): CSSProperties {
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
    borderRadius: 6,
  };
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const S = {
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    minHeight: 0,
  } as CSSProperties,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  panel: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    borderWidth: 1,
    borderStyle: 'solid' as const,
    borderColor: 'var(--gray-6, #e2e8f0)',
    borderRadius: 14,
    overflow: 'hidden' as const,
    background: 'var(--color-surface, #fff)',
    position: 'relative' as const,
  } as CSSProperties,
};

// Scoped to `.gw-canvas-shell` so it doesn't leak. Mirrors the previous
// newsletter-specific block but parameterised on the shared class so
// both editors inherit identical chrome. The Radix-token mapping (Puck
// uses 01=darkest convention vs Radix 1=lightest) follows the original
// implementation in NewsletterPuckCanvas.
const SHELL_CSS = `
.gw-canvas-shell {
  /* Narrower left rail — the AI / Blocks / Outline panels don't need the
     default width. (Puck reads the *-user-* var for the resizable width.) */
  --puck-left-side-bar-width: 232px;
  --puck-user-left-side-bar-width: 232px;

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

/* Hide Puck's native header row — the toolbar above the panel owns
   all host actions now. */
.gw-canvas-shell [class*="PuckLayout-header"] {
  display: none !important;
}

/* Tighten the left tab-strip top padding — Puck reserves 32px for the
   header we just hid. 8px keeps the first tab's active-state indicator
   tucked inside the curved corner. */
.gw-canvas-shell [class*="Nav-list"] {
  padding-top: 8px !important;
}

/* Let ViewportLightDarkPortal's Sun + Moon buttons render alongside
   Desktop / Mobile / Zoom without being clipped by the row's default
   overflow: hidden. */
.gw-canvas-shell [class*="ViewportControls-actionsInner"] {
  overflow: visible !important;
}

/* Force Puck's outer layout to inherit our flex height instead of its
   default 100dvh — see comments in the newsletter editor's original
   block for the full rationale. */
.gw-canvas-shell [class*="_PuckLayout_"] {
  height: 100% !important;
}
.gw-canvas-shell [class*="_Sidebar_"],
.gw-canvas-shell [class*="_Nav_"],
.gw-canvas-shell [class*="_PuckPluginTab_"] {
  overscroll-behavior: contain;
}

/* Fields header: the breadcrumb row renders the parent crumbs ("Page" + a
   chevron) inside _Breadcrumbs-breadcrumb_ elements, followed by the current
   block's name as a trailing text node. Hide just the crumbs so the header
   shows only the block name ("Sponsored Ad" instead of "Page > Sponsored Ad").
   The trailing underscore in the selector avoids also matching
   _Breadcrumbs-breadcrumbLabel_. */
.gw-canvas-shell [class*="Breadcrumbs-breadcrumb_"] {
  display: none !important;
}

/* Selection-outline offset so contentEditable text has breathing room
   from the block-selection chrome. */
.gw-canvas-shell [class*="DraggableComponent-overlay"] {
  outline-offset: 4px !important;
}

/* Drop the browser's focus ring on inline-text fields — Puck already
   indicates focus via the block-selection overlay. */
.gw-canvas-shell [class*="InlineTextField"]:focus,
.gw-canvas-shell [class*="InlineTextField"]:focus-visible {
  outline: none !important;
}

/* Hide the block-selection outline while the operator is actively
   typing in an InlineTextField so the two competing borders don't
   noise the canvas. */
.gw-canvas-shell [class*="DraggableComponent"]:has([class*="InlineTextField"]:focus) [class*="DraggableComponent-overlay"] {
  outline: none !important;
}
`;
