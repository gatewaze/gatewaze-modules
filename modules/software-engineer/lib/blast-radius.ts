// @ts-nocheck
/**
 * Blast-radius classifier (spec §10.4). Fail-closed: anything touching a sensitive path, or
 * exceeding size thresholds, or an unreadable diff → `needs_human` (PR opened, merge withheld).
 * Input is the GitHub compare `files` array ({ filename, status, additions, deletions }).
 */

const SENSITIVE: Array<[RegExp, string]> = [
  [/(^|\/)\.claude\//, 'agent rules/config (.claude/**)'],
  [/(^|\/)\.github\/workflows\//, 'CI workflow'],
  [/(^|\/)safe-exec\.ts$/, 'shell-exec allowlist'],
  [/(^|\/)Dockerfile/i, 'Dockerfile'],
  [/(^|\/)(helm|charts)\//i, 'helm/k8s manifests'],
  [/(^|\/)migrations\//, 'database migration'],
  [/(rls|policy)/i, 'RLS/policy'],
  [/(^|\/)auth/i, 'auth code'],
  [/(^|\/)\.env/, 'env file'],
  [/secret/i, 'secret-related'],
  [/(^|\/)package\.json$/, 'dependency manifest'],
  [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/, 'lockfile'],
  [/(^|\/)modules\/software-engineer\//, 'the agent module itself (self-modification)'],
];

const MAX_FILES = 15;
const MAX_LINES = 400;
const MAX_DELETIONS = 3;

export interface BlastResult {
  classification: 'safe' | 'needs_human';
  reasons: string[];
  files: number;
  lines: number;
}

export function classifyBlastRadius(
  files: Array<{ filename?: string; status?: string; additions?: number; deletions?: number }> | null | undefined,
  opts: { maxFiles?: number; maxLines?: number } = {},
): BlastResult {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxLines = opts.maxLines ?? MAX_LINES;

  // Fail closed on a missing/unreadable diff.
  if (!Array.isArray(files)) {
    return { classification: 'needs_human', reasons: ['diff unavailable'], files: 0, lines: 0 };
  }

  const reasons: string[] = [];
  let lines = 0;
  let removed = 0;
  for (const f of files) {
    lines += (f.additions ?? 0) + (f.deletions ?? 0);
    if (f.status === 'removed') removed += 1;
    const p = f.filename ?? '';
    for (const [rx, label] of SENSITIVE) {
      if (rx.test(p)) { reasons.push(`${label}: ${p}`); break; }
    }
  }
  if (files.length > maxFiles) reasons.push(`too many files (${files.length} > ${maxFiles})`);
  if (lines > maxLines) reasons.push(`too many lines changed (${lines} > ${maxLines})`);
  if (removed > MAX_DELETIONS) reasons.push(`notable deletions (${removed} files removed)`);

  return {
    classification: reasons.length ? 'needs_human' : 'safe',
    reasons,
    files: files.length,
    lines,
  };
}
