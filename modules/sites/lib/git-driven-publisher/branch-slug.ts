/**
 * Branch-slug derivation per spec-sites-theme-kinds §6.2.
 *
 * Final branch format:
 *   content/<page-branch-slug>-<page-id-short>/<timestamp>-<publish-id-short>
 *
 * Where:
 *   <page-branch-slug>  derived from pages.full_path (deterministic; this file)
 *   <page-id-short>     first 8 chars of pages.id (UUID)
 *   <publish-id-short>  first 8 chars of a fresh UUIDv4 per publish
 *   <timestamp>         compact YYYYMMDDHHMMSS in UTC
 *
 * Pure functions; no IO. Easy to unit-test against the spec's worked
 * examples.
 */

/**
 * Derive a branch-friendly slug from a page's full_path. Per §6.2:
 *   1. Strip leading '/'
 *   2. Replace '/' with '-'
 *   3. Lowercase
 *   4. Replace any character outside [a-z0-9-] with '-'
 *   5. Collapse runs of '-'
 *   6. Trim leading and trailing '-'
 *   7. Truncate to 40 characters
 *   8. If result is empty OR contains only '-', use 'home'
 */
export function pageBranchSlug(fullPath: string): string {
  const stripped = fullPath.replace(/^\//, '');
  const dashedSlashes = stripped.replace(/\//g, '-');
  const lowered = dashedSlashes.toLowerCase();
  const safeChars = lowered.replace(/[^a-z0-9-]/g, '-');
  const collapsed = safeChars.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  const truncated = trimmed.slice(0, 40);
  if (truncated.length === 0 || /^-+$/.test(truncated)) {
    return 'home';
  }
  return truncated;
}

/**
 * Produce a compact UTC timestamp 'YYYYMMDDHHMMSS' for a Date.
 */
export function compactTimestamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

export interface BuildBranchNameArgs {
  fullPath: string;
  pageId: string;          // full UUID; first 8 chars used
  publishId: string;       // full UUID; first 8 chars used
  timestamp: Date;
}

/**
 * Compose the final branch name. Per §6.2 worked examples:
 *   /                       (id abc12345-…) → content/home-abc12345/20260501143022-a3f9c2b1
 *   /for/developer          (id def67890-…) → content/for-developer-def67890/...
 *   /blog/2026/article-… (id 9876fedc-…)    → content/blog-2026-article-…-9876fedc/...
 *
 * Total length is bounded by Git's 255-byte ref name limit; in practice
 * branches end up ~70 chars max.
 */
export function buildBranchName(args: BuildBranchNameArgs): string {
  const slug = pageBranchSlug(args.fullPath);
  const pageShort = args.pageId.replace(/-/g, '').slice(0, 8);
  const publishShort = args.publishId.replace(/-/g, '').slice(0, 8);
  const ts = compactTimestamp(args.timestamp);
  return `content/${slug}-${pageShort}/${ts}-${publishShort}`;
}

/**
 * Validate a remote URL against an optional egress allowlist. Returns the
 * URL's hostname for logging or null if the URL is malformed.
 *
 * The allowlist semantics: empty array = unrestricted; non-empty = the
 * hostname (without port) must equal one of the entries (case-insensitive).
 * Subdomain wildcards are NOT supported in v1 (per spec posture; explicit
 * is safer).
 */
export function checkRemoteAgainstAllowlist(
  remote: string,
  allowlist: ReadonlyArray<string>,
): { ok: true; host: string } | { ok: false; reason: string; host: string | null } {
  let host: string;
  try {
    // git@github.com:owner/repo.git form — convert to a parseable URL for
    // hostname extraction. Otherwise treat as URL.
    const sshMatch = remote.match(/^git@([^:]+):/);
    if (sshMatch) {
      host = sshMatch[1] ?? '';
    } else {
      host = new URL(remote).hostname;
    }
  } catch {
    return { ok: false, reason: 'malformed_remote_url', host: null };
  }
  if (allowlist.length === 0) return { ok: true, host };
  const lower = host.toLowerCase();
  if (allowlist.some((h) => h.toLowerCase() === lower)) {
    return { ok: true, host };
  }
  return { ok: false, reason: 'egress_blocked', host };
}
