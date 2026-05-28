/**
 * In-process circuit breaker for the upstream scrapling-fetcher (spec §10.3).
 *
 * Closed: requests proceed; failures incrementally tracked.
 * Open:   503 returned without ever calling upstream — and without any DB
 *         writes (saves the API DB from write amplification during outages).
 * Half-open: a single probe request is allowed through.
 *
 * Multi-replica deployments each run their own breaker; under a real
 * outage all replicas converge to "open" quickly enough.
 */

type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Failures in 60s that flip the breaker open. */
  failureThreshold: number;
  /** Window size for failure counting (ms). */
  windowMs: number;
  /** Initial open duration (ms); doubles on repeated open trips up to maxOpenMs. */
  baseOpenMs: number;
  /** Cap on backoff. */
  maxOpenMs: number;
}

const DEFAULTS: BreakerConfig = {
  failureThreshold: 20,
  windowMs: 60_000,
  baseOpenMs: 30_000,
  maxOpenMs: 5 * 60_000,
};

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures: number[] = []; // timestamps (ms epoch)
  private successes = 0;
  private openUntil = 0;
  private currentOpenMs: number;
  private readonly cfg: BreakerConfig;

  constructor(cfg: Partial<BreakerConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.currentOpenMs = this.cfg.baseOpenMs;
  }

  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() >= this.openUntil) {
        this.state = 'half_open';
        return false;
      }
      return true;
    }
    return false;
  }

  retryAfterSeconds(): number {
    if (this.state !== 'open') return 0;
    return Math.max(1, Math.ceil((this.openUntil - Date.now()) / 1000));
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      // Probe succeeded — reset.
      this.state = 'closed';
      this.failures = [];
      this.successes = 0;
      this.currentOpenMs = this.cfg.baseOpenMs;
      return;
    }
    this.successes += 1;
    // Drop old failure timestamps from the window.
    this.pruneFailures();
  }

  recordFailure(): void {
    const now = Date.now();
    if (this.state === 'half_open') {
      // Probe failed — back to open with doubled timeout.
      this.currentOpenMs = Math.min(this.currentOpenMs * 2, this.cfg.maxOpenMs);
      this.openUntil = now + this.currentOpenMs;
      this.state = 'open';
      return;
    }
    this.failures.push(now);
    this.pruneFailures();
    if (this.failures.length >= this.cfg.failureThreshold) {
      this.openUntil = now + this.currentOpenMs;
      this.state = 'open';
    }
  }

  private pruneFailures(): void {
    const cutoff = Date.now() - this.cfg.windowMs;
    while (this.failures.length > 0 && this.failures[0]! < cutoff) {
      this.failures.shift();
    }
  }

  /** Diagnostic. */
  getStateForMetrics(): { state: BreakerState; failures: number } {
    return { state: this.state, failures: this.failures.length };
  }
}

// Module-level singleton — one breaker per process protects all callers
// against a single upstream service.
let _instance: CircuitBreaker | null = null;
export function getCircuitBreaker(): CircuitBreaker {
  if (!_instance) _instance = new CircuitBreaker();
  return _instance;
}

/** Test-only reset hook. */
export function _resetCircuitBreakerForTests(): void {
  _instance = null;
}
