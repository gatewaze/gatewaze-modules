// @ts-nocheck
/**
 * Per-profile test-environment panel for the Overview page — one instance per
 * env profile (gatewaze + lfx), each with its own status, Launch, teardown,
 * mainline deploy, and the full ordered PR-set builder, so an arbitrary PR
 * set can be deployed without a run. Replaces the single project-filter-
 * switched TestEnvStrip. All the shared surface (status header, stepper,
 * builder) is <TestEnvControls>; this file keeps only the Overview-specific
 * selection state and related-PR sourcing. Hides itself on deployments
 * without this profile's control channel (available:false).
 *
 * Related-PR auto-detect is best-effort here: /test-env/related needs a
 * project's GitHub PAT, and the Overview has no natural project — any project
 * whose testEnvProfile matches this panel's profile serves; with none, the
 * lookup is skipped silently.
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { fetchRelated } from './testEnv';
import { addEntry, pickRelatedProject } from './testEnvSet';
import TestEnvControls from './TestEnvControls';

export default function TestEnvOverviewPanel({ profile, projects }: { profile: 'gatewaze' | 'lfx'; projects?: any[] }) {
  const [deploySet, setDeploySet] = useState<{ repo: string; number: number }[]>([]);
  // PR-page URLs learned from related-PR lookups, keyed "repo#number".
  const [knownUrls, setKnownUrls] = useState<Record<string, string>>({});

  // A manually-added PR triggers a best-effort same-branch lookup across the
  // profile's other repos; anything found is appended to the set (deduped).
  const onAdded = async (repo: string, number: number) => {
    const proj = pickRelatedProject(projects ?? [], profile);
    if (!proj?.id) return;
    try {
      const r = await fetchRelated(profile, proj.id, repo, number);
      const rel = (r?.related ?? []).filter((x) => x?.repo && Number.isInteger(x?.number));
      if (!rel.length) return;
      setKnownUrls((prev) => ({ ...prev, ...Object.fromEntries(rel.map((x) => [`${x.repo}#${x.number}`, x.url])) }));
      setDeploySet((s) => {
        const next = rel.reduce((acc, x) => addEntry(acc, x.repo, x.number), s);
        if (next.length > s.length) toast.info(`Added ${next.length - s.length} related PR${next.length - s.length > 1 ? 's' : ''} (same head branch)`);
        return next;
      });
    } catch { /* best-effort — related lookup failures never block the builder */ }
  };
  const prUrlOf = (repo: string, number: number) => knownUrls[`${repo}#${number}`] ?? null;

  return (
    <TestEnvControls profile={profile} deploySet={deploySet} onChange={setDeploySet} prUrlOf={prUrlOf} onAdded={onAdded} className="mb-4">
      {({ tornDown }) => deploySet.length === 0 && (
        <span className="text-neutral-400">Deploy any open PR set{tornDown ? '' : ' — or replace what’s deployed'}: add PRs below, or deploy plain main.</span>
      )}
    </TestEnvControls>
  );
}
