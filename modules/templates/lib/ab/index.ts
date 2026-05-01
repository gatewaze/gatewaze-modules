/**
 * Public A/B engine API.
 *
 * Usage:
 *   import { BuiltinAbEngine } from '@gatewaze-modules/templates/ab';
 *   const engine = new BuiltinAbEngine({ supabase, loadTest });
 *   const { variant } = await engine.assignVariant({ testId, sessionKey, viewerContext });
 *
 * Other engines (ab-optimizely, ab-growthbook) implement the same IAbEngine
 * interface and register via the platform's capability registry. The host
 * module (sites / newsletters) selects an engine per-host via its config.
 */

export { BuiltinAbEngine, pickVariantDeterministic } from './builtin.js';
export type { BuiltinAbEngineSupabase, BuiltinAbEngineOptions } from './builtin.js';
export type { IAbEngine, AbAssignmentResult, AbSummary, AbVariant, ViewerContext } from '../../types/index.js';
