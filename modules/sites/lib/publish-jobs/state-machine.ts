/**
 * Publish-job state machine (mirror of the SQL trigger in migration 007).
 *
 * Centralises the allowed-transitions table so:
 *   - the worker can validate transitions before issuing the UPDATE
 *   - tests assert each cell of the transition matrix
 *   - the SQL trigger can be regenerated from this when it drifts
 *
 * Per spec-sites-theme-kinds §6.4. Terminal statuses:
 *   succeeded, build_failed, cancelled, conflict, failed
 *
 * Non-terminal-but-recoverable: finalization_failed (admin-initiated retry
 * back to finalizing, OR escalate to terminal failed).
 */

export type PublishJobStatus =
  | 'queued' | 'preparing' | 'committing' | 'awaiting_build' | 'build_started'
  | 'finalizing' | 'succeeded' | 'build_failed' | 'cancelled' | 'conflict' | 'failed'
  | 'finalization_failed';

const TRANSITIONS: Record<PublishJobStatus, ReadonlyArray<PublishJobStatus>> = {
  queued:        ['preparing', 'cancelled', 'failed'],
  preparing:     ['committing', 'cancelled', 'failed', 'conflict'],
  committing:    ['awaiting_build', 'cancelled', 'failed', 'conflict'],
  awaiting_build:['build_started', 'failed', 'cancelled'],
  build_started: ['finalizing', 'build_failed', 'cancelled'],
  finalizing:    ['succeeded', 'finalization_failed'],
  finalization_failed: ['finalizing', 'failed'],
  // Terminal — no outgoing transitions
  succeeded:     [],
  build_failed:  [],
  cancelled:     [],
  conflict:      [],
  failed:        [],
};

const TERMINAL = new Set<PublishJobStatus>([
  'succeeded', 'build_failed', 'cancelled', 'conflict', 'failed',
]);

export function isTerminal(status: PublishJobStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: PublishJobStatus, to: PublishJobStatus): boolean {
  if (from === to) return true;          // identity transition is always allowed
  return TRANSITIONS[from].includes(to);
}

/**
 * Returns the set of legal next states for a given current status. Returns
 * the same status when terminal (no transitions).
 */
export function legalNextStates(status: PublishJobStatus): ReadonlyArray<PublishJobStatus> {
  return TRANSITIONS[status];
}

/**
 * Apply a transition, throwing on illegal moves. Used by the worker before
 * issuing the UPDATE; the SQL trigger is the authoritative second line of
 * defense.
 */
export function assertTransition(from: PublishJobStatus, to: PublishJobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`sites_publish_jobs: illegal transition ${from} -> ${to}`);
  }
}
