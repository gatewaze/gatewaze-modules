/**
 * Shared registry for Puck plugins contributed by other modules.
 *
 * Sites' `PuckCanvasEditor` and newsletters' `NewsletterPuckCanvas`
 * both read from this registry at mount time, so a contributing
 * module (e.g. `@gatewaze-modules/editor-ai-copilot`) registers
 * its plugin ONCE and it reaches both editors.
 *
 * Module-level state — registrations are side-effects of importing
 * the contributing module's `admin/index.ts` at app boot. Stays
 * in this file (sites' admin surface) because it must be shared
 * across sibling modules that don't depend on each other directly.
 *
 * Per spec-canvas-ai-copilot.md §3.8.
 */

import type { Plugin } from '@puckeditor/core';

const plugins: Plugin[] = [];

/** Called by contributing modules at admin-init time. */
export function registerCanvasPuckPlugin(plugin: Plugin): void {
  // Idempotent against duplicate-import: don't push the same plugin
  // instance twice. Different instances (same `name`) are still
  // pushed — runtime is permissive; consumers can collide-check.
  if (!plugins.includes(plugin)) {
    plugins.push(plugin);
  }
}

/** Called by editor mounts to get the plugins array. */
export function getCanvasPuckPlugins(): ReadonlyArray<Plugin> {
  return plugins;
}

/** Test hook. */
export function _resetPluginRegistryForTests(): void {
  plugins.length = 0;
}
