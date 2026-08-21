// Pins the status-detail-line parser behind the Overview/run-view test-env
// panels (testEnvStatusLine.ts). The grammar is what the host agents in
// gatewaze-environments emit (staging-test-env.sh / staging-lfx-env.sh):
// "Deployed: repo@base[+#PR…]" summaries, the live-tracking list with
// resolved PR-head shas, the watcher heartbeat ("refreshed …, checked …"),
// the conflict-freeze notice, and the in-progress rewrites. This module's
// vitest env is 'node' (no jsdom), so the pure parser is the contract.
import { describe, it, expect } from 'vitest';
import {
  splitLiveDetail, parseTestEnvDetail, relTime, testEnvPrUrl, testEnvCommitUrl,
} from '../components/testEnvStatusLine';

describe('parseTestEnvDetail — deployed-only summaries', () => {
  it('parses repo rows with base shas and PR numbers (no live segment)', () => {
    const d = parseTestEnvDetail('Deployed: lfx-self-serve@bbafa07+#1688 lfx-v2-newsletter-service@67a846a+#63');
    expect(d.liveTracking).toBe(false);
    expect(d.live).toBeNull();
    expect(d.conflict).toBeNull();
    expect(d.mainline).toBe(false);
    expect(d.repos).toEqual([
      { repo: 'lfx-self-serve', baseSha: 'bbafa07', prs: [{ number: 1688, headSha: null }] },
      { repo: 'lfx-v2-newsletter-service', baseSha: '67a846a', prs: [{ number: 63, headSha: null }] },
    ]);
  });

  it('keeps the gatewaze startup-builds note as leftover prose', () => {
    const d = parseTestEnvDetail('Deployed: gatewaze@abc1234+#12 gatewaze-modules@def5678 (admin/portal finish their startup builds a few minutes after this)');
    expect(d.repos.map((r) => r.repo)).toEqual(['gatewaze', 'gatewaze-modules']);
    expect(d.repos[1].prs).toEqual([]);   // repo deployed at plain main
    expect(d.note).toBe('(admin/portal finish their startup builds a few minutes after this)');
  });

  it('flags the mainline prefix and repeats of +#PR within one repo', () => {
    const d = parseTestEnvDetail('Deployed: mainline (origin/main) gatewaze@abc1234');
    expect(d.mainline).toBe(true);
    expect(d.repos).toEqual([{ repo: 'gatewaze', baseSha: 'abc1234', prs: [] }]);

    const multi = parseTestEnvDetail('Deployed: gatewaze@abc1234+#12+#34');
    expect(multi.repos[0].prs.map((p) => p.number)).toEqual([12, 34]);
  });
});

describe('parseTestEnvDetail — live tracking', () => {
  const line = 'Deployed: lfx-self-serve@bbafa07+#1688 — live: tracking lfx-self-serve@bbafa07+#1688@9ec5796c1b2d3e4, refreshed 2026-08-21T10:00:00Z';

  it('prefers the tracking list (it carries resolved PR-head shas)', () => {
    const d = parseTestEnvDetail(line);
    expect(d.liveTracking).toBe(true);
    expect(d.repos).toEqual([
      { repo: 'lfx-self-serve', baseSha: 'bbafa07', prs: [{ number: 1688, headSha: '9ec5796c1b2d3e4' }] },
    ]);
    expect(d.refreshedAt).toBe('2026-08-21T10:00:00Z');
    expect(d.checkedAt).toBeNull();
  });

  it('parses the heartbeat variant — refreshed (last change) and checked (watcher alive) both surface', () => {
    const d = parseTestEnvDetail('Deployed — live: tracking lfx-self-serve@bbafa07+#1688@9ec5796 lfx-v2-newsletter-service@67a846a+#63@0a1b2c3, refreshed 2026-08-21T09:00:00Z, checked 2026-08-21T10:30:45Z');
    expect(d.liveTracking).toBe(true);
    expect(d.repos).toHaveLength(2);
    expect(d.repos[1]).toEqual({ repo: 'lfx-v2-newsletter-service', baseSha: '67a846a', prs: [{ number: 63, headSha: '0a1b2c3' }] });
    expect(d.refreshedAt).toBe('2026-08-21T09:00:00Z');
    expect(d.checkedAt).toBe('2026-08-21T10:30:45Z');
  });

  it('handles a multi-PR repo in the tracking list (merge-queue order preserved)', () => {
    const d = parseTestEnvDetail('Deployed — live: tracking gatewaze-modules@11aa22b+#206@33cc44d+#207@55ee66f, refreshed 2026-08-21T09:00:00Z');
    expect(d.repos[0].prs).toEqual([
      { number: 206, headSha: '33cc44d' },
      { number: 207, headSha: '55ee66f' },
    ]);
  });
});

describe('parseTestEnvDetail — conflict + in-progress + passthrough', () => {
  it('extracts the conflict-freeze notice, keeping the frozen summary rows', () => {
    const d = parseTestEnvDetail('Deployed: lfx-self-serve@bbafa07+#1688@9ec5796 — live refresh conflict: lfx-self-serve#1688(after main) — env frozen at previous state; fix the branch and push again');
    expect(d.liveTracking).toBe(false);   // frozen, not following
    expect(d.conflict).toBe('lfx-self-serve#1688(after main) — env frozen at previous state; fix the branch and push again');
    // Summary rows still parse from the main segment (with the head sha).
    expect(d.repos).toEqual([
      { repo: 'lfx-self-serve', baseSha: 'bbafa07', prs: [{ number: 1688, headSha: '9ec5796' }] },
    ]);
  });

  it('passes the in-progress rewrite through raw (no rows, live segment intact)', () => {
    const d = parseTestEnvDetail('Live refresh in progress (gatewaze-modules changed) — re-merging worktrees');
    expect(d.repos).toEqual([]);
    expect(d.liveTracking).toBe(false);
    expect(d.live).toBe('Live refresh in progress (gatewaze-modules changed) — re-merging worktrees');
  });

  it('passes arbitrary error/progress prose through untouched in main', () => {
    for (const msg of ['app install/build failed — see lfx-app-build.log', 'Cloning database', '', undefined]) {
      const d = parseTestEnvDetail(msg as string | undefined);
      expect(d.repos).toEqual([]);
      expect(d.main).toBe(msg ?? '');
      expect(d.conflict).toBeNull();
    }
  });
});

describe('splitLiveDetail (unchanged contract, now in testEnvStatusLine)', () => {
  it('splits at the live marker and trims trailing dashes from main', () => {
    expect(splitLiveDetail('Deployed: a@abc1234 — live: tracking a@abc1234, refreshed 2026-08-21T10:00:00Z'))
      .toEqual({ main: 'Deployed: a@abc1234', live: 'live: tracking a@abc1234, refreshed 2026-08-21T10:00:00Z' });
    expect(splitLiveDetail('plain detail')).toEqual({ main: 'plain detail', live: null });
    expect(splitLiveDetail(undefined)).toEqual({ main: '', live: null });
  });
});

describe('relTime', () => {
  const now = Date.parse('2026-08-21T10:00:00Z');

  it('renders compact ages and clamps clock skew to 0s', () => {
    expect(relTime('2026-08-21T09:59:40Z', now)).toBe('20s ago');
    expect(relTime('2026-08-21T09:57:00Z', now)).toBe('3m ago');
    expect(relTime('2026-08-21T08:00:00Z', now)).toBe('2h ago');
    expect(relTime('2026-08-18T10:00:00Z', now)).toBe('3d ago');
    expect(relTime('2026-08-21T10:00:05Z', now)).toBe('0s ago');   // box clock ahead
  });

  it('returns null on missing or unparseable input', () => {
    expect(relTime(null, now)).toBeNull();
    expect(relTime(undefined, now)).toBeNull();
    expect(relTime('not-a-date', now)).toBeNull();
  });
});

describe('GitHub links — owner per profile org', () => {
  it('maps gatewaze → gatewaze org and lfx → linuxfoundation org', () => {
    expect(testEnvPrUrl('gatewaze', 'gatewaze-modules', 206)).toBe('https://github.com/gatewaze/gatewaze-modules/pull/206');
    expect(testEnvPrUrl('lfx', 'lfx-self-serve', 1688)).toBe('https://github.com/linuxfoundation/lfx-self-serve/pull/1688');
    expect(testEnvCommitUrl('lfx', 'lfx-self-serve', '9ec5796')).toBe('https://github.com/linuxfoundation/lfx-self-serve/commit/9ec5796');
  });
});
