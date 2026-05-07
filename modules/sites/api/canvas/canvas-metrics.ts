/**
 * Canvas observability shim. Per spec-sites-wysiwyg-builder §8 the
 * canvas pipeline must expose four metrics to Prometheus:
 *
 *   sites_canvas_ops_total{op_kind,result}        — counter
 *   sites_canvas_op_duration_seconds{op_kind}     — histogram
 *   sites_canvas_render_duration_seconds{phase}   — histogram (preflight/apply/render)
 *   sites_canvas_lock_conflicts_total             — counter
 *
 * gatewaze-modules deliberately does NOT depend on prom-client (the
 * platform owns the registry; modules stay portable). This file
 * defines an abstract `CanvasMetrics` interface plus a no-op default;
 * the platform's express boot passes a prom-client-backed impl via
 * dependency injection.
 *
 * Recording shape:
 *   metrics.observeOp({ op_kind: 'block.insert', result: 'ok',
 *                       durationSeconds: 0.013 })
 *   metrics.observeRender({ phase: 'render', durationSeconds: 0.045 })
 *   metrics.recordLockConflict()
 */

export interface OpObservation {
  /** Canonical op kind, e.g. 'block.insert', 'preset.apply'. */
  opKind: string;
  /** 'ok' | 'validation_error' | 'lock_conflict' | 'version_conflict' | 'internal'. */
  result: string;
  /** End-to-end duration of THIS op including SQL dispatch in seconds. */
  durationSeconds: number;
}

export interface RenderObservation {
  /** 'preflight' | 'apply' | 'render' | 'sanitise' */
  phase: string;
  durationSeconds: number;
}

export interface CanvasMetrics {
  observeOp(o: OpObservation): void;
  observeRender(o: RenderObservation): void;
  recordLockConflict(): void;
}

export const noopCanvasMetrics: CanvasMetrics = {
  observeOp: () => undefined,
  observeRender: () => undefined,
  recordLockConflict: () => undefined,
};

/**
 * Convenience timing helper: returns elapsed seconds between two
 * `process.hrtime.bigint()` reads. Hrtime nanoseconds → seconds float.
 */
export function elapsedSeconds(startHrtime: bigint): number {
  return Number(process.hrtime.bigint() - startHrtime) / 1e9;
}
