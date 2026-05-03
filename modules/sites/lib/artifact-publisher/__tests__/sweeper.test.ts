import { describe, expect, it } from 'vitest';
import {
  selectPreviewsForCleanup,
  selectStaleDeployments,
  selectWebhookSeenForPurge,
  type PreviewCandidate,
  type StaleCandidate,
  type WebhookSeenCandidate,
} from '../sweeper.js';

const NOW = new Date('2026-05-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('selectPreviewsForCleanup()', () => {
  it('selects previews older than the default retention (24h)', () => {
    const candidates: PreviewCandidate[] = [
      { id: 'a', publisher_id: 'vercel', created_at: new Date(NOW.getTime() - 25 * HOUR).toISOString(), last_accessed_at: null },
      { id: 'b', publisher_id: 'vercel', created_at: new Date(NOW.getTime() - 23 * HOUR).toISOString(), last_accessed_at: null },
    ];
    const out = selectPreviewsForCleanup({ candidates, now: () => NOW });
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('uses last_accessed_at if available (sliding window)', () => {
    const candidates: PreviewCandidate[] = [
      {
        id: 'a',
        publisher_id: 'vercel',
        created_at: new Date(NOW.getTime() - 100 * HOUR).toISOString(),     // very old
        last_accessed_at: new Date(NOW.getTime() - 1 * HOUR).toISOString(), // recently accessed
      },
    ];
    const out = selectPreviewsForCleanup({ candidates, now: () => NOW });
    expect(out).toHaveLength(0);
  });

  it('honors per-publisher retention overrides', () => {
    const candidates: PreviewCandidate[] = [
      { id: 'a', publisher_id: 'fast', created_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(), last_accessed_at: null },
      { id: 'b', publisher_id: 'slow', created_at: new Date(NOW.getTime() - 2 * HOUR).toISOString(), last_accessed_at: null },
    ];
    const out = selectPreviewsForCleanup({
      candidates,
      retentionByPublisher: { fast: 1, slow: 24 },
      now: () => NOW,
    });
    expect(out.map((c) => c.id)).toEqual(['a']);  // fast retention has elapsed; slow's hasn't
  });
});

describe('selectStaleDeployments()', () => {
  it('selects non-terminal deployments with stale heartbeat', () => {
    const candidates: StaleCandidate[] = [
      { id: 'a', status: 'rendering', heartbeat_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(), started_at: null },
      { id: 'b', status: 'rendering', heartbeat_at: new Date(NOW.getTime() - 10 * 1000).toISOString(), started_at: null },
    ];
    const out = selectStaleDeployments({ candidates, now: () => NOW });
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('does not select terminal deployments even if their heartbeat is old', () => {
    const old = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const candidates: StaleCandidate[] = [
      { id: 'a', status: 'succeeded', heartbeat_at: old, started_at: null },
      { id: 'b', status: 'cancelled', heartbeat_at: old, started_at: null },
      { id: 'c', status: 'failed', heartbeat_at: old, started_at: null },
    ];
    const out = selectStaleDeployments({ candidates, now: () => NOW });
    expect(out).toHaveLength(0);
  });

  it('treats deployments with no heartbeat AND no started_at as definitively stuck', () => {
    const candidates: StaleCandidate[] = [
      { id: 'a', status: 'queued', heartbeat_at: null, started_at: null },
    ];
    const out = selectStaleDeployments({ candidates, now: () => NOW });
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('falls back to started_at when heartbeat is null', () => {
    const candidates: StaleCandidate[] = [
      { id: 'a', status: 'rendering', heartbeat_at: null, started_at: new Date(NOW.getTime() - 1 * 1000).toISOString() }, // 1s ago — fresh
      { id: 'b', status: 'rendering', heartbeat_at: null, started_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString() }, // 10m — stale
    ];
    const out = selectStaleDeployments({ candidates, now: () => NOW });
    expect(out.map((c) => c.id)).toEqual(['b']);
  });
});

describe('selectWebhookSeenForPurge()', () => {
  it('selects rows older than the retention window (default 7d)', () => {
    const candidates: WebhookSeenCandidate[] = [
      { publisher_id: 'vercel', deployment_id: 'd1', event_kind: 'build_succeeded', seen_at: new Date(NOW.getTime() - 8 * DAY).toISOString() },
      { publisher_id: 'vercel', deployment_id: 'd2', event_kind: 'build_succeeded', seen_at: new Date(NOW.getTime() - 6 * DAY).toISOString() },
    ];
    const out = selectWebhookSeenForPurge({ candidates, now: () => NOW });
    expect(out.map((c) => c.deployment_id)).toEqual(['d1']);
  });
});
