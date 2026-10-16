/**
 * Lazy loader for the editor-ai-copilot Puck plugin.
 *
 * Both canvas hosts (sites' PuckCanvasEditor and newsletters'
 * NewsletterPuckCanvas, which the broadcast content editor reuses) call
 * `useCanvasAiPlugins()` and pass the result to CanvasShell's
 * `extraPlugins`. The plugin is fetched with a dynamic import the first
 * time an editor mounts, so neither the copilot nor the Puck runtime it
 * imports sits in the admin app's (or the hosted embed's) boot bundle.
 *
 * Why not a boot-time registration: the platform's Vite plugin
 * side-effect-imports every module's `admin/index.*` from the virtual
 * module registry at boot. When the copilot registered itself that way,
 * the import chain aiPlugin → AiSidebarPane → @puckeditor/core put the
 * whole Puck editor (about 1.3 MB raw) into the boot graph of every
 * page, including pages that never open an editor
 * (linuxfoundation/lfx-self-serve#3762).
 *
 * The copilot chunk is emitted whenever editor-ai-copilot exists in any
 * of the build's module sources, whether or not it is in the module
 * list; whether the AI tab is usable is still decided by each host's
 * `aiEnabled`. When no source has the copilot, the specifier resolves
 * to an empty stub and the editor mounts without an AI tab. A failed
 * chunk load does the same for that mount and is retried on the next.
 */

import { useEffect, useState } from 'react';
import type { Plugin } from '@puckeditor/core';

type PluginModule = { aiPlugin?: Plugin } | null | undefined;
export type CanvasAiPluginImporter = () => Promise<PluginModule>;

const NO_PLUGINS: ReadonlyArray<Plugin> = [];

// `as string` keeps tsc from resolving the premium module's types (sites
// does not depend on it); Vite still sees the literal specifier after the
// cast is stripped and emits the chunk.
const defaultImporter: CanvasAiPluginImporter = () =>
  import('@gatewaze-modules/editor-ai-copilot/admin/plugin' as string) as Promise<PluginModule>;

let importer: CanvasAiPluginImporter = defaultImporter;
let pending: Promise<ReadonlyArray<Plugin>> | null = null;
// Settled result, kept so editors that mount after the first load get a
// stable array on their first render. CanvasShell memoises its plugin
// list on the `extraPlugins` identity and Puck rebuilds its store when
// that list changes, so handing out the same array avoids a rebuild.
let settled: ReadonlyArray<Plugin> | null = null;

/** Loads the copilot plugin once; later calls share the same result. */
export function loadCanvasAiPlugins(): Promise<ReadonlyArray<Plugin>> {
  if (!pending) {
    pending = importer().then(
      (mod) => {
        // The Vite plugin resolves the specifier whenever the copilot is
        // in any module source, even when it is not in this build's module
        // list. When no source has it, the specifier resolves to an empty
        // stub with no `aiPlugin`. Either way the answer is final for this
        // bundle.
        settled = mod?.aiPlugin ? [mod.aiPlugin] : NO_PLUGINS;
        return settled;
      },
      (err: unknown) => {
        // The chunk failed to load (network, or a stale chunk after a
        // deploy). Mount this editor without the AI tab and let the next
        // mount try again rather than caching the failure.
        console.warn('[canvas] AI copilot plugin failed to load; editor opens without the AI tab', err);
        pending = null;
        return NO_PLUGINS;
      },
    );
  }
  return pending;
}

/** The loaded plugins, or null while the first load is still running. */
export function getLoadedCanvasAiPlugins(): ReadonlyArray<Plugin> | null {
  return settled;
}

/**
 * Plugins to pass to CanvasShell's `extraPlugins`. Empty until the
 * copilot chunk arrives, then the loaded plugin (or still empty if the
 * module is not in this build).
 */
export function useCanvasAiPlugins(): ReadonlyArray<Plugin> {
  const [plugins, setPlugins] = useState<ReadonlyArray<Plugin>>(() => settled ?? NO_PLUGINS);
  useEffect(() => {
    if (settled) {
      setPlugins(settled);
      return;
    }
    let cancelled = false;
    void loadCanvasAiPlugins().then((loaded) => {
      if (!cancelled) setPlugins(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return plugins;
}

/** Test hook: swap the importer and clear the cached result. */
export function _setCanvasAiPluginImporterForTests(next: CanvasAiPluginImporter | null): void {
  importer = next ?? defaultImporter;
  pending = null;
  settled = null;
}
