/**
 * Artifact-publisher deployment state machine
 * (mirrors §6.2 of spec-sites-module — the artifact-based publishing path).
 *
 * The git-driven publish-job state machine lives in lib/publish-jobs; this
 * one covers the older artifact-based path; sites are now uniformly
 * website-kind and use the git-driven publisher exclusively, so this path
 * is retained only for non-site hosts that still use HTML artifacts.
 *
 * States:
 *   queued           — created in DB, awaiting worker pickup
 *   preparing        — worker has the lock, gathering page list + media refs
 *   rendering        — emitting per-page HTML to the artifact directory
 *   syncing_media    — uploading new media to the publisher's CDN
 *   deploying        — handing artifact to publisher.deploy()
 *   cancelling       — user requested cancel; worker is rolling back
 *   succeeded        — terminal: live + URL recorded
 *   cancelled        — terminal: cleanup completed
 *   failed           — terminal: error recorded
 *
 * Identity transitions are allowed (idempotency under retries).
 */

export type DeploymentStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'syncing_media'
  | 'deploying'
  | 'cancelling'
  | 'succeeded'
  | 'cancelled'
  | 'failed';

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(['succeeded', 'cancelled', 'failed']);

const TRANSITIONS: Record<DeploymentStatus, ReadonlyArray<DeploymentStatus>> = {
  queued: ['preparing', 'cancelling', 'failed', 'cancelled'],
  preparing: ['rendering', 'cancelling', 'failed'],
  rendering: ['syncing_media', 'cancelling', 'failed'],
  syncing_media: ['deploying', 'cancelling', 'failed'],
  deploying: ['succeeded', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  cancelled: [],
  failed: [],
};

export function isTerminal(s: DeploymentStatus): boolean {
  return TERMINAL.has(s);
}

export function legalNextStates(s: DeploymentStatus): ReadonlyArray<DeploymentStatus> {
  return TRANSITIONS[s];
}

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition: ${from} -> ${to}`);
  }
}
