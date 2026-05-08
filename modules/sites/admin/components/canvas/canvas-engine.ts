/**
 * canvas-engine — feature-flag dispatcher between the legacy
 * SiteCanvasEditor and the Puck-based PuckCanvasEditor.
 *
 * Per spec-builder-evaluation §3.7. The engine is read from
 * `sites_settings.canvas.engine` (per-site jsonb path) with a
 * platform default from `SITES_CANVAS_ENGINE_DEFAULT`. v1 default
 * is `legacy`; new sites can be Puck-by-default once the deployment
 * env var flips.
 *
 * The dispatcher itself is a thin function — the real React-tree
 * branch lives in <CanvasEditor> in admin/page-editor. This file
 * holds:
 *
 *   - the engine type
 *   - the parser that reads sites_settings safely (returns 'legacy'
 *     on any malformed input — fail closed to the editor that ships
 *     today)
 *   - a capability check used to demote 'puck' → 'legacy' when the
 *     browser lacks IntersectionObserver (Puck v0.20 DnD requires it)
 */

export type CanvasEngine = 'legacy' | 'puck';

export const DEFAULT_ENGINE: CanvasEngine = 'legacy';

export interface SitesSettingsLike {
  canvas?: { engine?: unknown } | null;
}

/**
 * Resolve the engine for a site. Order of precedence:
 *
 *   1. site-level `sites_settings.canvas.engine` (if valid)
 *   2. platform default from env (passed in by caller)
 *   3. DEFAULT_ENGINE
 *
 * Browser-capability override is applied separately by
 * `applyCapabilityCheck` so server-side resolution stays pure.
 */
export function resolveEngine(
  siteSettings: SitesSettingsLike | null | undefined,
  platformDefault: CanvasEngine | undefined = undefined,
): CanvasEngine {
  const fromSite = siteSettings?.canvas?.engine;
  if (fromSite === 'legacy' || fromSite === 'puck') return fromSite;
  if (platformDefault === 'legacy' || platformDefault === 'puck') return platformDefault;
  return DEFAULT_ENGINE;
}

/**
 * Demote `'puck'` to `'legacy'` when the browser lacks
 * IntersectionObserver. Called from the editor mount, NOT from
 * server-side resolution — server doesn't know browser capabilities.
 */
export function applyCapabilityCheck(
  engine: CanvasEngine,
  hasIntersectionObserver: boolean,
): { engine: CanvasEngine; demoted: boolean } {
  if (engine === 'puck' && !hasIntersectionObserver) {
    return { engine: 'legacy', demoted: true };
  }
  return { engine, demoted: false };
}

/**
 * Read the platform default from `SITES_CANVAS_ENGINE_DEFAULT`.
 * Server-side only — admin reads via the existing feature-flags
 * endpoint shape (extended in a follow-up commit).
 */
export function platformDefaultFromEnv(envVar: string | undefined): CanvasEngine | undefined {
  if (envVar === 'legacy' || envVar === 'puck') return envVar;
  return undefined;
}
