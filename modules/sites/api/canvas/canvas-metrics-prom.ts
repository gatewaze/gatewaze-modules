/**
 * Prom-client adapter for the abstract `CanvasMetrics` interface. The
 * platform owns the prom-client dependency; this file lives next to the
 * abstract interface so a single import wires everything when the
 * platform's bootstrap calls `createPromCanvasMetrics(register)`.
 *
 * gatewaze-modules itself never imports this file at module-resolution
 * time — only the platform side does, AFTER prom-client is in scope.
 * (Sites module ships the abstract interface; concrete prom-client
 * binding ships separately so unit tests don't pull the whole stack.)
 */

import type { CanvasMetrics, OpObservation, RenderObservation } from './canvas-metrics.js';

interface PromCounter {
  inc(labels: Record<string, string>, value?: number): void;
}
interface PromHistogram {
  observe(labels: Record<string, string>, value: number): void;
}
interface PromBare {
  inc(value?: number): void;
}

interface PromRegistryLike {
  // The fields prom-client's Registry exposes (or the constructors we
  // need below). Kept structural so we don't need to import the actual
  // prom-client types in this module.
}

export interface PromConstructors {
  Counter: new (cfg: { name: string; help: string; labelNames?: string[]; registers?: PromRegistryLike[] }) => PromCounter & PromBare;
  Histogram: new (cfg: { name: string; help: string; labelNames?: string[]; buckets?: number[]; registers?: PromRegistryLike[] }) => PromHistogram;
}

export interface PromCanvasMetricsConfig {
  /** prom-client Registry to register against (NOT the bare global). */
  register: PromRegistryLike;
  /** prom-client constructors — pass `{ Counter, Histogram }` from the platform side. */
  prom: PromConstructors;
}

const DURATION_BUCKETS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export function createPromCanvasMetrics({ register, prom }: PromCanvasMetricsConfig): CanvasMetrics {
  const opsTotal = new prom.Counter({
    name: 'sites_canvas_ops_total',
    help: 'Count of canvas op-batch operations, labelled by op-kind and final result code.',
    labelNames: ['op_kind', 'result'],
    registers: [register],
  });
  const opDurationSeconds = new prom.Histogram({
    name: 'sites_canvas_op_duration_seconds',
    help: 'Wall-clock duration (seconds) of canvas op-batch operations, labelled by op-kind.',
    labelNames: ['op_kind'],
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [register],
  });
  const renderDurationSeconds = new prom.Histogram({
    name: 'sites_canvas_render_duration_seconds',
    help: 'Wall-clock duration (seconds) of canvas rendering phases (preflight | apply | render | sanitise).',
    labelNames: ['phase'],
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [register],
  });
  const lockConflictsTotal = new prom.Counter({
    name: 'sites_canvas_lock_conflicts_total',
    help: 'Count of editor-lock conflict events (acquire denials + apply-time canvas.lock_conflict).',
    registers: [register],
  });

  return {
    observeOp(o: OpObservation): void {
      opsTotal.inc({ op_kind: o.opKind, result: o.result });
      opDurationSeconds.observe({ op_kind: o.opKind }, o.durationSeconds);
    },
    observeRender(o: RenderObservation): void {
      renderDurationSeconds.observe({ phase: o.phase }, o.durationSeconds);
    },
    recordLockConflict(): void {
      lockConflictsTotal.inc();
    },
  };
}
