/**
 * Cross-module React context that host editors (sites' PuckCanvasEditor
 * and newsletters' NewsletterPuckCanvas) use to advertise host identity
 * (hostKind/hostId/targetId) to contributing Puck plugins.
 *
 * Defined in sites — not in a contributing module — so both editors can
 * provide values WITHOUT taking a hard dependency on any one contributor
 * (e.g. the premium `editor-ai-copilot` module). Contributors import
 * this context from sites and read values inside their `overrides`.
 *
 * If no contributing plugin reads the context, the provider is a no-op;
 * editors can wrap unconditionally.
 *
 * Per spec-canvas-ai-copilot.md §3.8.
 */

import { createContext } from 'react';

export type CanvasPluginHostKind = 'site' | 'newsletter';

export interface CanvasPluginHostContextValue {
  hostKind: CanvasPluginHostKind;
  /** Site id (when hostKind='site') or newsletter id (when 'newsletter'). */
  hostId: string;
  /** Page id (when hostKind='site') or edition id (when 'newsletter'). */
  targetId: string;
  /** Gate plugins on a feature flag at the host. Plugins should check this. */
  enabled: boolean;
  /**
   * Optional reason string shown by plugins when `enabled` is false.
   * Lets the host explain why — e.g. "Save the edition before using
   * AI." — without each plugin needing to know about host-specific
   * states (new/unsaved/draft).
   */
  disabledReason?: string;
  /**
   * Optional: the available block defs the host editor knows about,
   * supplied to plugins that need to know what types of blocks are
   * valid in this library (notably the AI copilot, which queries DB
   * templates by default but must accept registry-driven libraries for
   * newsletters that aren't backed by `templates_block_defs` rows).
   *
   * The shape is opaque here — `CanvasPluginHostContext` is a
   * cross-module wiring surface and shouldn't depend on any one
   * plugin's view type. Plugins cast and validate the entries
   * themselves; structural compatibility with the AI copilot's
   * `BlockDefView` is the contract. See
   * `email-blocks/build-ai-block-defs.ts` for the newsletter producer.
   */
  blockDefs?: ReadonlyArray<Record<string, unknown>>;
}

export const CanvasPluginHostContext = createContext<CanvasPluginHostContextValue | null>(null);
