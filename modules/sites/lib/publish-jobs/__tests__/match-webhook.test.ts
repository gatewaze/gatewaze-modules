import { describe, expect, it } from 'vitest';
import { matchWebhookEvent, statusForEvent, replayKey, type JobMatchCandidate } from '../match-webhook.js';
import type { BuildStatusEvent } from '../../git-driven-publisher/types.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);

const job = (overrides: Partial<JobMatchCandidate> = {}): JobMatchCandidate => ({
  id: overrides.id ?? 'job1',
  publisher_id: overrides.publisher_id ?? 'sites-publisher-vercel-git',
  status: overrides.status ?? 'awaiting_build',
  result_commit_sha: overrides.result_commit_sha ?? null,
  result_deployment_id: overrides.result_deployment_id ?? null,
  result_pr_number: overrides.result_pr_number ?? null,
});

describe('matchWebhookEvent — primary match by deployment_id', () => {
  it('matches all candidates already linked to the deployment_id', async () => {
    const candidates = [
      job({ id: 'a', result_deployment_id: 'dep-1' }),
      job({ id: 'b', result_deployment_id: 'dep-1' }),
      job({ id: 'c', result_deployment_id: 'dep-2' }),
    ];
    const event: BuildStatusEvent = {
      kind: 'build_succeeded',
      commitSha: COMMIT_A,
      deploymentId: 'dep-1',
      url: 'https://x.com',
      durationMs: 5000,
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.strategy).toBe('deployment_id');
    expect(result.matched.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});

describe('matchWebhookEvent — fallback by commit_sha (no deployment_id yet)', () => {
  it('matches the initiating job by exact commit_sha', async () => {
    const candidates = [
      job({ id: 'a', result_commit_sha: COMMIT_A, result_deployment_id: null }),
      job({ id: 'b', result_commit_sha: COMMIT_B, result_deployment_id: null }),
    ];
    const event: BuildStatusEvent = {
      kind: 'build_started',
      commitSha: COMMIT_A,
      deploymentId: 'dep-1',
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.strategy).toBe('commit_sha');
    expect(result.matched.map((m) => m.id)).toEqual(['a']);
  });

  it('uses ancestor matching when no exact commit hits', async () => {
    const candidates = [
      job({ id: 'a', result_commit_sha: COMMIT_A, result_deployment_id: null }),
      job({ id: 'b', result_commit_sha: COMMIT_B, result_deployment_id: null }),
    ];
    const event: BuildStatusEvent = {
      kind: 'build_started',
      commitSha: COMMIT_C, // squashed result, neither A nor B but A is its parent
      deploymentId: 'dep-1',
    };
    const isAncestor = async (parent: string, _child: string): Promise<boolean> => {
      return parent === COMMIT_A;
    };
    const result = await matchWebhookEvent({ candidates, event, isAncestor });
    expect(result.strategy).toBe('commit_sha');
    expect(result.matched.map((m) => m.id)).toEqual(['a']);
  });
});

describe('matchWebhookEvent — fallback by pr_number', () => {
  it('matches when commit doesn’t hit but PR is recognized (force-push scenario)', async () => {
    const candidates = [
      job({ id: 'a', result_commit_sha: COMMIT_A, result_pr_number: 42, result_deployment_id: null }),
      job({ id: 'b', result_pr_number: 99, result_deployment_id: null }),
    ];
    const event = {
      kind: 'build_succeeded' as const,
      commitSha: COMMIT_C,        // post force-push; no candidate has this commit
      deploymentId: 'dep-2',
      url: 'https://x.com',
      durationMs: 1000,
      prNumber: 42,
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.strategy).toBe('pr_number');
    expect(result.matched.map((m) => m.id)).toEqual(['a']);
  });
});

describe('matchWebhookEvent — empty results', () => {
  it('returns no matches with strategy=null when nothing aligns', async () => {
    const candidates = [job({ id: 'a', result_commit_sha: COMMIT_A })];
    const event: BuildStatusEvent = {
      kind: 'build_started',
      commitSha: COMMIT_C,        // no candidate has this commit, no PR fallback
      deploymentId: 'dep-1',
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.strategy).toBe(null);
    expect(result.matched).toHaveLength(0);
  });

  it('skips terminal candidates even when they would otherwise match', async () => {
    const candidates = [
      job({ id: 'a', status: 'succeeded', result_commit_sha: COMMIT_A }),
    ];
    const event: BuildStatusEvent = {
      kind: 'build_started',
      commitSha: COMMIT_A,
      deploymentId: 'dep-1',
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.matched).toHaveLength(0);
  });
});

describe('matchWebhookEvent — N-to-1 case (multiple jobs → one deployment)', () => {
  it('matches three coalesced jobs sharing a deployment_id', async () => {
    const candidates = [
      job({ id: 'a', result_deployment_id: 'dep-1', result_commit_sha: COMMIT_A }),
      job({ id: 'b', result_deployment_id: 'dep-1', result_commit_sha: COMMIT_B }),
      job({ id: 'c', result_deployment_id: 'dep-1', result_commit_sha: COMMIT_C }),
    ];
    const event: BuildStatusEvent = {
      kind: 'build_succeeded',
      commitSha: COMMIT_C, // the squashed commit
      deploymentId: 'dep-1',
      url: 'https://x.com',
      durationMs: 1000,
    };
    const result = await matchWebhookEvent({ candidates, event });
    expect(result.matched).toHaveLength(3);
    expect(result.strategy).toBe('deployment_id');
  });
});

describe('statusForEvent', () => {
  it('build_started → build_started', () => expect(statusForEvent('build_started')).toBe('build_started'));
  it('build_succeeded → finalizing (NOT succeeded; finalize step lands first)', () =>
    expect(statusForEvent('build_succeeded')).toBe('finalizing'));
  it('build_failed → build_failed', () => expect(statusForEvent('build_failed')).toBe('build_failed'));
  it('build_cancelled → cancelled', () => expect(statusForEvent('build_cancelled')).toBe('cancelled'));
});

describe('replayKey', () => {
  it('returns the dedupe key triple', () => {
    const event: BuildStatusEvent = {
      kind: 'build_succeeded',
      commitSha: COMMIT_A,
      deploymentId: 'dep-1',
      url: 'x',
      durationMs: 1,
    };
    expect(replayKey('vercel', event)).toEqual({
      publisherId: 'vercel',
      deploymentId: 'dep-1',
      eventKind: 'build_succeeded',
    });
  });

  it('returns null when no deploymentId is present', () => {
    const event = {
      kind: 'build_started' as const,
      commitSha: COMMIT_A,
      deploymentId: '',
    };
    expect(replayKey('vercel', event)).toBe(null);
  });
});
