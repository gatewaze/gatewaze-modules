/**
 * Shared registry for Puck plugins contributed by other modules.
 *
 * CanvasShell (which both sites' `PuckCanvasEditor` and newsletters'
 * `NewsletterPuckCanvas` render) reads from this registry at mount
 * time, so a contributing module registers its plugin once and it
 * reaches both editors.
 *
 * Module-level state. Stays in this file (sites' admin surface)
 * because it must be shared across sibling modules that don't depend
 * on each other directly.
 *
 * editor-ai-copilot no longer registers here: it loads on demand via
 * `useCanvasAiPlugins()` (load-canvas-ai-plugins.ts) and reaches the
 * editors through CanvasShell's `extraPlugins`. Registering from a
 * module's `admin/index.ts` runs at admin boot, so anything registered
 * that way (and everything it imports) lands in the boot bundle.
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
