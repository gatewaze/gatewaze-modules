/**
 * Sweeper helpers — decide which previews and stale jobs are eligible for
 * cleanup. Pure functions over candidate rows; the worker calls these and
 * dispatches the actual deletes via the platform's Supabase client.
 *
 * Per spec-sites-module §10.4:
 *   - Preview deployments older than the publisher-specific retention
 *     are eligible for cleanup
 *   - Deployments stuck in non-terminal status with no heartbeat for >5min
 *     are considered abandoned and rolled to `failed` on the next sweep
 *   - Webhook seen rows older than 7d are eligible for purge (replay
 *     dedupe window has elapsed)
 */

import type { DeploymentStatus } from './state-machine.js';

export const PREVIEW_DEFAULT_RETENTION_HOURS = 24;
export const STALE_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;
export const WEBHOOK_SEEN_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Preview cleanup
// ---------------------------------------------------------------------------

export interface PreviewCandidate {
  id: string;
  publisher_id: string;
  /** ISO timestamp the preview was created. */
  created_at: string;
  /** Last access (if the publisher exposes hit tracking). Null if not tracked. */
  last_accessed_at: string | null;
}

/**
 * Returns the subset of previews that should be removed. Retention is
 * per-publisher (derived from the deps; defaults to 24h).
 */
export function selectPreviewsForCleanup(args: {
  candidates: ReadonlyArray<PreviewCandidate>;
  retentionByPublisher?: Record<string, number>;       // hours
  defaultRetentionHours?: number;
  now?: () => Date;
}): PreviewCandidate[] {
  const now = args.now ? args.now() : new Date();
  const defaultRet = args.defaultRetentionHours ?? PREVIEW_DEFAULT_RETENTION_HOURS;
  return args.candidates.filter((c) => {
    const ret = args.retentionByPublisher?.[c.publisher_id] ?? defaultRet;
    const reference = c.last_accessed_at ?? c.created_at;
    const ageMs = now.getTime() - new Date(reference).getTime();
    return ageMs >= ret * 60 * 60 * 1000;
  });
}

// ---------------------------------------------------------------------------
// Stale deployment recovery
// ---------------------------------------------------------------------------

export interface StaleCandidate {
  id: string;
  status: DeploymentStatus;
  heartbeat_at: string | null;
  started_at: string | null;
}

/**
 * Returns the subset of deployments whose worker has gone quiet. Such
 * deployments are eligible for forced rollover to 'failed' so the editor
 * unblocks and the user can retry.
 */
export function selectStaleDeployments(args: {
  candidates: ReadonlyArray<StaleCandidate>;
  graceMs?: number;
  now?: () => Date;
}): StaleCandidate[] {
  const now = args.now ? args.now() : new Date();
  const grace = args.graceMs ?? STALE_HEARTBEAT_GRACE_MS;
  return args.candidates.filter((c) => {
    if (c.status === 'succeeded' || c.status === 'cancelled' || c.status === 'failed') return false;
    const reference = c.heartbeat_at ?? c.started_at;
    if (!reference) return true; // never started, never heartbeat — definitively stuck
    return now.getTime() - new Date(reference).getTime() >= grace;
  });
}

// ---------------------------------------------------------------------------
// Webhook seen-row purge
// ---------------------------------------------------------------------------

export interface WebhookSeenCandidate {
  publisher_id: string;
  deployment_id: string;
  event_kind: string;
  seen_at: string;
}

export function selectWebhookSeenForPurge(args: {
  candidates: ReadonlyArray<WebhookSeenCandidate>;
  retentionDays?: number;
  now?: () => Date;
}): WebhookSeenCandidate[] {
  const now = args.now ? args.now() : new Date();
  const retentionDays = args.retentionDays ?? WEBHOOK_SEEN_RETENTION_DAYS;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return args.candidates.filter((c) => new Date(c.seen_at).getTime() < cutoff);
}
