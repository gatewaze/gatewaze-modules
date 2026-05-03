/**
 * Runtime content API — public exports.
 *
 * The HTTP handler (api/runtime.ts, mounted via the module's apiRoutes
 * callback) composes these pure helpers + a Supabase service-role client
 * + the platform's rate-limiter to serve the spec §7 endpoints.
 */

export {
  canonicalizeRenderContext,
  assertFlatContext,
  type RenderContextValue,
  type RenderContextFlat,
} from './render-context.js';

export {
  selectVariant,
  scoreEligibility,
  SQL_SELECT_WINNING_VARIANT,
  type VariantCandidate,
} from './variant-precedence.js';

export {
  generateRuntimeApiKey,
  hashRuntimeApiKey,
  compareKeyHashes,
  extractBearerKey,
  siteIdShortFromKey,
  type GeneratedRuntimeApiKey,
} from './api-keys.js';
