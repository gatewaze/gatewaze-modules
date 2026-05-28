/**
 * Puck plugin definition. Registered into the shared
 * canvas-puck-plugin-registry exported by sites; both
 * PuckCanvasEditor (sites) and NewsletterPuckCanvas (newsletters)
 * pick it up automatically.
 *
 * Per spec-canvas-ai-copilot.md §3.7 / §3.8.
 *
 * The plugin reads host identity (hostKind/hostId/targetId) from the
 * shared `CanvasPluginHostContext` defined in sites — host editors
 * provide that context unconditionally, so this premium module isn't
 * a hard dependency of the open-core editors.
 *
 * UI placement: this contributes a native sidebar TAB (the same
 * mechanism Puck v0.21 uses internally for the built-in Blocks,
 * Outline, and Fields tabs). When the user clicks the AI tab icon
 * in the left sidebar's tab strip, Puck swaps the panel body to our
 * `render` function. No overrides, no merging, no race with the
 * editor's existing overrides — it slots in alongside the built-ins
 * via `[ ...defaultPlugins, ...userPlugins ]` inside Puck.
 */

import type { Plugin } from '@puckeditor/core';
import { useContext } from 'react';
import { CanvasPluginHostContext } from '@gatewaze-modules/sites/admin/components/canvas/puck/canvas-plugin-host-context.js';
import { AiSidebarPane } from './AiSidebarPane.js';

function AiTabBody() {
  const ctx = useContext(CanvasPluginHostContext);
  if (!ctx || !ctx.enabled) {
    // Prefer a host-supplied reason when available — lets newsletter /
    // sites surfaces explain WHY the AI is unavailable (e.g. unsaved
    // edition) instead of the generic "not enabled" message.
    const message = ctx?.disabledReason ?? 'AI copilot is not enabled for this editor.';
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--puck-color-grey-05)' }}>
        {message}
      </div>
    );
  }
  return (
    <AiSidebarPane
      hostKind={ctx.hostKind}
      hostId={ctx.hostId}
      targetId={ctx.targetId}
      blockDefs={ctx.blockDefs}
    />
  );
}

// Inline SVG sparkles icon. Sized to match Puck's built-in Lucide tab
// icons (24×24, stroke-width 2) so it doesn't read as visually lighter
// than Blocks / Outline / Fields in the sidebar tab strip.
function SparklesIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  );
}

export const aiPlugin: Plugin = {
  name: 'editor-ai-copilot',
  label: 'AI',
  icon: <SparklesIcon />,
  render: () => <AiTabBody />,
};
