/**
 * CanvasEditor — engine-dispatching wrapper. Per spec-builder-evaluation §3.7.
 *
 * Reads the per-site `canvas.engine` setting (or platform default), applies
 * the browser-capability check (Puck DnD requires IntersectionObserver), and
 * mounts either the legacy `SiteCanvasEditor` or the new `PuckCanvasEditor`.
 *
 * This is the ONLY edit-time entry point used by page-editor — neither
 * editor should be imported directly. Switching engines (per-site flag,
 * or a capability demote) reaches the user via this seam.
 */

import { useEffect, useState } from 'react';
import { SiteCanvasEditor } from './SiteCanvasEditor.js';
import { PuckCanvasEditor } from './puck/PuckCanvasEditor.js';
import { useFeatureFlags } from './useFeatureFlags.js';
import {
  resolveEngine,
  applyCapabilityCheck,
  type CanvasEngine,
  type SitesSettingsLike,
} from './canvas-engine.js';

interface CanvasEditorProps {
  pageId: string;
  siteSlug: string;
  /**
   * Per-site settings bag. May be undefined when the admin app hasn't
   * fetched it yet — we fall back to the platform default in that case.
   */
  siteSettings?: SitesSettingsLike | null;
  /**
   * Platform default override. When omitted, the dispatcher pulls
   * `canvasEngineDefault` from the `/api/admin/feature-flags` endpoint.
   * Useful for tests + for callers that already have the flags loaded.
   */
  platformDefault?: CanvasEngine;
}

/**
 * Read the build-time / dev-time env default for the canvas engine.
 * Vite exposes `VITE_*` vars on `import.meta.env`. Wrapped in a try
 * so the dispatcher still works when the var is unset (returns
 * `undefined` and the runtime falls through to the API flag fetch).
 */
function envDefaultEngine(): CanvasEngine | undefined {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
    const v = env.VITE_SITES_CANVAS_ENGINE_DEFAULT;
    if (v === 'legacy' || v === 'puck') return v;
  } catch {
    // import.meta unavailable in this runtime — fall through.
  }
  return undefined;
}

export function CanvasEditor(props: CanvasEditorProps) {
  const flags = useFeatureFlags();
  const envDefault = envDefaultEngine();
  // Resolution priority: per-site setting → explicit prop → API flags →
  // build-time env default → DEFAULT_ENGINE. The env default short-circuits
  // the legacy-editor flash that would otherwise happen while the API
  // flag fetch is in flight (the canvas mounts before flags resolve).
  const platformDefault = props.platformDefault ?? flags.flags?.canvasEngineDefault ?? envDefault;
  const desired = resolveEngine(props.siteSettings, platformDefault);

  // Capability check is browser-only — useState lazy-init keeps SSR safe.
  // Initial value uses the env default so the FIRST mount is the right
  // editor, not legacy. We still re-run the capability check in an
  // effect once `desired` settles after the flag fetch.
  const [engine, setEngine] = useState<CanvasEngine>(() => {
    const initial = props.platformDefault ?? envDefault ?? 'legacy';
    return initial;
  });
  const [demoted, setDemoted] = useState(false);

  useEffect(() => {
    const hasIO = typeof window !== 'undefined' && typeof window.IntersectionObserver !== 'undefined';
    const result = applyCapabilityCheck(desired, hasIO);
    setEngine(result.engine);
    setDemoted(result.demoted);
  }, [desired]);

  if (engine === 'puck') {
    return <PuckCanvasEditor pageId={props.pageId} siteSlug={props.siteSlug} />;
  }
  return (
    <>
      {demoted && (
        <div className="puck-demoted-banner" role="status">
          The new visual editor needs a browser feature your device doesn&apos;t support.
          Falling back to the classic editor.
        </div>
      )}
      <SiteCanvasEditor pageId={props.pageId} siteSlug={props.siteSlug} />
    </>
  );
}
