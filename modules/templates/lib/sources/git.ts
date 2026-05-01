/**
 * Git source ingest — DEFERRED to a follow-up PR.
 *
 * The full implementation requires:
 *   1. Extracting @gatewaze/shared/git-monitor from the existing module-update
 *      monitoring code (per spec-module-git-update-monitoring.md). The helpers
 *      (lsRemoteHead, cloneOrUpdateRepo, isWorkingTreeClean) are currently
 *      vendored inside the modules subsystem and need lifting into a shared
 *      package both modules and templates can consume.
 *   2. A BullMQ scheduler / worker (`templates:check-template-updates`) running
 *      every 15 min by default, reading templates_sources WHERE kind='git',
 *      lsRemoteHead → diff vs installed_git_sha → cloneOrUpdateRepo → re-parse
 *      → write available_git_sha + previews. Mirrors spec-module-git-update-
 *      monitoring §5 ‘Component 5: Worker handler’.
 *   3. Realtime fan-out so the admin UI receives drift notifications.
 *   4. Auto-apply gate: if templates_sources.auto_apply=true AND change
 *      preview is non-breaking, call applySource() automatically.
 *
 * Until those land, the schema and parser already accept git-shaped rows
 * (kind='git', url, branch, etc.); they just won't be auto-checked. An
 * admin can manually re-import via reapplyUpload-equivalent (TODO endpoint).
 *
 * This file exists so importers don't get a missing-module error and so
 * the contract is documented in code, not just in the spec.
 */

import type { ApplyResult } from './apply.js';

export interface IngestGitInput {
  library_id: string;
  label: string;
  url: string;
  branch?: string;
  /** Pointer into the platform secrets store. */
  token_secret_ref?: string;
  manifest_path?: string;
  auto_apply?: boolean;
  created_by?: string | null;
}

export async function ingestGit(_input: IngestGitInput): Promise<{ source_id: string; apply: ApplyResult }> {
  throw new Error(
    'templates: git source ingest is not implemented in v0.1. See lib/sources/git.ts for the planned design and spec-module-git-update-monitoring.md for the helpers to extract.',
  );
}

export async function checkGitSourceForUpdates(_sourceId: string): Promise<never> {
  throw new Error('templates: git drift monitor not implemented in v0.1.');
}
