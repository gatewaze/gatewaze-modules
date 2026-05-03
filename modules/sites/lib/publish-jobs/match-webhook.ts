/**
 * Webhook → publish-job matching (spec-sites-theme-kinds §6.5).
 *
 * Layered match:
 *   1. Primary: (publisher_id, deployment_id) — most reliable; deployment_id
 *      recorded on first build_started webhook.
 *   2. Fallback for first event: (publisher_id, commit_sha) — used when no
 *      job has deployment_id yet (matching the very first build_started to
 *      its initiating publish job).
 *   3. Fallback for pull_request strategy: (publisher_id, pr_number) — used
 *      when commit_sha doesn't match (rebase / force-push scenarios).
 *
 * The handler applies the event's status update transactionally to ALL
 * matched non-terminal jobs at once (N-to-1 case: a developer rebased and
 * consolidated multiple publish-job commits into one before merging).
 *
 * Pure function — takes a list of candidate jobs and an event, returns the
 * subset that matches. The DB-side filtering (publisher_id + non-terminal
 * status) is the caller's concern.
 */

import { isTerminal, type PublishJobStatus } from './state-machine.js';
import type { BuildStatusEvent } from '../git-driven-publisher/types.js';

export interface JobMatchCandidate {
  id: string;
  publisher_id: string;
  status: PublishJobStatus;
  result_commit_sha: string | null;
  result_deployment_id: string | null;
  result_pr_number: number | null;
}

export type MatchStrategy = 'deployment_id' | 'commit_sha' | 'pr_number';

export interface WebhookMatchResult {
  matched: ReadonlyArray<JobMatchCandidate>;
  strategy: MatchStrategy | null;
}

/**
 * Match a webhook event against candidate jobs. Caller pre-filters by
 * publisher_id + non-terminal status.
 *
 * Returns the matched subset and the strategy used. An empty match with
 * strategy=null indicates the event is unmatched (caller logs
 * `sites.webhook.unmatched` and 200-OKs to avoid retry storms per spec).
 *
 * `isAncestor` is an injectable callback the caller wires up to the
 * publisher's `isAncestor()` capability (or returns false when the
 * publisher doesn't expose one). Used only in the commit-sha-fallback
 * path.
 */
export async function matchWebhookEvent(args: {
  candidates: ReadonlyArray<JobMatchCandidate>;
  event: BuildStatusEvent & { prNumber?: number };
  isAncestor?: (parent: string, child: string) => Promise<boolean>;
}): Promise<WebhookMatchResult> {
  const { candidates, event } = args;
  const isAncestor = args.isAncestor ?? (async () => false);

  // Strip terminal jobs defensively, even though the caller should pre-filter.
  const eligible = candidates.filter((c) => !isTerminal(c.status));

  // 1. Primary: match by deployment_id when any job already has one set
  //    matching the event. (Subsequent webhooks for an in-flight build all
  //    carry the same deployment_id.)
  if (event.deploymentId) {
    const byDeployment = eligible.filter(
      (c) => c.result_deployment_id === event.deploymentId,
    );
    if (byDeployment.length > 0) {
      return { matched: byDeployment, strategy: 'deployment_id' };
    }
  }

  // 2. Fallback: match by commit_sha. Used only when no candidate has
  //    deployment_id set yet — the first build_started webhook lands here.
  //    Includes ancestor matching so that a rebased commit still hits the
  //    publish job that produced the predecessor.
  if (event.commitSha && event.commitSha.length === 40) {
    // Direct commit match
    const direct = eligible.filter(
      (c) => c.result_deployment_id === null && c.result_commit_sha === event.commitSha,
    );
    if (direct.length > 0) {
      return { matched: direct, strategy: 'commit_sha' };
    }

    // Ancestor match (rebase / squash scenarios)
    const ancestorChecks = await Promise.all(
      eligible
        .filter((c) => c.result_deployment_id === null && c.result_commit_sha)
        .map(async (c) => ({
          candidate: c,
          isAncestorOfEvent: c.result_commit_sha
            ? await isAncestor(c.result_commit_sha, event.commitSha)
            : false,
        })),
    );
    const ancestorMatches = ancestorChecks
      .filter((r) => r.isAncestorOfEvent)
      .map((r) => r.candidate);
    if (ancestorMatches.length > 0) {
      return { matched: ancestorMatches, strategy: 'commit_sha' };
    }
  }

  // 3. Fallback: match by pr_number. Used when commit_sha doesn't match
  //    (force-push / rebase) but the PR is still recognizable.
  if (typeof event.prNumber === 'number') {
    const byPr = eligible.filter((c) => c.result_pr_number === event.prNumber);
    if (byPr.length > 0) {
      return { matched: byPr, strategy: 'pr_number' };
    }
  }

  return { matched: [], strategy: null };
}

/**
 * Map a normalized BuildStatusEvent kind → the publish-job status it
 * implies. The caller still validates the transition is legal via the
 * state machine.
 */
export function statusForEvent(eventKind: BuildStatusEvent['kind']): PublishJobStatus {
  switch (eventKind) {
    case 'build_started':   return 'build_started';
    case 'build_succeeded': return 'finalizing';   // succeeded comes after the finalize step lands
    case 'build_failed':    return 'build_failed';
    case 'build_cancelled': return 'cancelled';
  }
}

/**
 * Webhook replay key — used to dedupe by `(publisher_id, deployment_id, event_kind)`
 * in the `sites_webhook_seen` table. Returns null when the event has no
 * deployment_id (e.g. a build_started webhook from a publisher that doesn't
 * mint a deployment_id until later — pathological; we accept and don't dedupe).
 */
export function replayKey(
  publisherId: string,
  event: BuildStatusEvent,
): { publisherId: string; deploymentId: string; eventKind: string } | null {
  if (!event.deploymentId) return null;
  return {
    publisherId,
    deploymentId: event.deploymentId,
    eventKind: event.kind,
  };
}
