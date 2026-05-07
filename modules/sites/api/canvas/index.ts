/**
 * Canvas admin API entry point. Per spec-sites-wysiwyg-builder §6.
 */

export { createCanvasRoutes, mountCanvasRoutes } from './canvas-routes.js';
export type { CanvasRoutesDeps } from './canvas-routes.js';
export { validateEnvelope, validateOp } from './validators.js';
export type { ValidationResult, ValidationOk, ValidationFail } from './validators.js';
export { applyEnvelope } from './op-handlers.js';
export type { ApplyOpsResult, OpHandlerDeps } from './op-handlers.js';
export { validateContent, validateFieldUpdate } from './schema-validate.js';
export type { ContentValidationResult, ValidationIssue } from './schema-validate.js';
export { canvasConfig, type CanvasConfig } from './canvas-config.js';
export {
  noopCanvasMetrics,
  type CanvasMetrics,
  type OpObservation,
  type RenderObservation,
} from './canvas-metrics.js';
export { createPromCanvasMetrics, type PromCanvasMetricsConfig, type PromConstructors } from './canvas-metrics-prom.js';
export { assertCanvasEnabled, assertCanAdminSite, type CanvasAuthResult } from './canvas-auth.js';
