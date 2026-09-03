// @ts-nocheck
/**
 * PR test environment panel (run view). Deployment-optional — renders only
 * where the operator wired a /staging-control channel AND the run's project
 * maps to an env profile (testEnvProfile: Gatewaze → gatewaze, LFX → lfx).
 * Run PRs pre-select (PR-number ascending); cross-repo related PRs (same head
 * branch, via /test-env/related) auto-populate pre-checked; a manual
 * "+ related PR" row remains for anything the heuristic misses.
 *
 * Selection is an ORDERED DEPLOY SET: checking a PR appends it; same-repo
 * entries can repeat and are merged onto main locally in the shown order
 * (merge-queue semantics on the host). One env slot per profile — deploying
 * replaces it. Everything below the selection — status header, Launch/URLs,
 * teardown, progress stepper, and the set builder itself — is the shared
 * <TestEnvControls>, also used by the per-profile Overview panels; this file
 * keeps only the run-specific selection state (pre-checked run PRs and the
 * auto-detected related PRs with their purple badge).
 */
import React, { useEffect, useState } from 'react';
import { Badge } from '@/components/ui';
import { DEPLOYABLE, testEnvProfile, fetchRelated } from './testEnv';
import { inSet as entryInSet, toggleEntry } from './testEnvSet';
import TestEnvControls from './TestEnvControls';

export default function TestEnvPanel({ prs, projectId, projectName }: { prs: any[]; projectId?: string; projectName?: string }) {
  const profile = testEnvProfile(projectName);
  const deployable = profile ? DEPLOYABLE[profile] : [];
  const runPrs = (prs ?? []).filter(
    (p) => (profile !== 'gatewaze' || p.repo_owner === 'gatewaze') && deployable.includes(p.repo_name) && p.pr_number,
  );
  // Ordered deploy set — order is what gets sent, verbatim. Pre-check the
  // run's own PRs, PR-number ascending.
  const [deploySet, setDeploySet] = useState<{ repo: string; number: number }[]>(
    () => runPrs
      .map((p) => ({ repo: p.repo_name, number: p.pr_number }))
      .sort((a, b) => a.number - b.number),
  );
  const [related, setRelated] = useState<any[]>([]);   // auto-discovered, pre-checked

  const inSet = (repo: string, number: number) => entryInSet(deploySet, repo, number);
  const toggle = (repo: string, number: number) => setDeploySet((s) => toggleEntry(s, repo, number));

  // Auto-discover cross-repo related PRs for each of the run's PRs.
  useEffect(() => {
    if (!profile || !projectId || runPrs.length === 0) return;
    let cancelled = false;
    (async () => {
      const found: any[] = [];
      for (const p of runPrs) {
        try {
          const r = await fetchRelated(profile, projectId, p.repo_name, p.pr_number);
          for (const rel of r?.related ?? []) {
            if (!found.some((f) => f.repo === rel.repo && f.number === rel.number)
              && !runPrs.some((rp) => rp.repo_name === rel.repo && rp.pr_number === rel.number)) {
              found.push(rel);
            }
          }
        } catch { /* lookup is best-effort */ }
      }
      if (!cancelled && found.length) {
        found.sort((a, b) => a.number - b.number);
        setRelated(found);
        setDeploySet((s) => [...s, ...found.filter((f) => !s.some((x) => x.repo === f.repo && x.number === f.number)).map((f) => ({ repo: f.repo, number: f.number }))]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- run PR set is stable per run

  if (!profile) return null;

  const prUrlOf = (repo: string, number: number) =>
    runPrs.find((p) => p.repo_name === repo && p.pr_number === number)?.pr_url
    ?? related.find((r) => r.repo === repo && r.number === number)?.url ?? null;

  return (
    <TestEnvControls profile={profile} deploySet={deploySet} onChange={setDeploySet} prUrlOf={prUrlOf} addLabel="related PR" className="mb-3">
      {runPrs.length === 0 && <span className="text-neutral-400">No deployable PRs on this run yet — add one below to deploy.</span>}
      {runPrs.map((p) => {
        const k = `${p.repo_name}#${p.pr_number}`;
        return (
          <label key={k} className="inline-flex items-center gap-1.5">
            <input type="checkbox" className="size-3.5" checked={inSet(p.repo_name, p.pr_number)}
              onChange={() => toggle(p.repo_name, p.pr_number)} />
            <span>{p.repo_name} <a href={p.pr_url} target="_blank" rel="noreferrer" className="text-[#7C93B0]">#{p.pr_number}</a></span>
          </label>
        );
      })}
      {related.map((r) => {
        const k = `${r.repo}#${r.number}`;
        return (
          <label key={k} className="inline-flex items-center gap-1.5" title={`Same head branch (${r.branch}) — auto-detected`}>
            <input type="checkbox" className="size-3.5" checked={inSet(r.repo, r.number)}
              onChange={() => toggle(r.repo, r.number)} />
            <span>{r.repo} <a href={r.url} target="_blank" rel="noreferrer" className="text-[#7C93B0]">#{r.number}</a>
              <Badge color="purple" variant="soft" size="1" className="ml-1">related</Badge></span>
          </label>
        );
      })}
    </TestEnvControls>
  );
}
