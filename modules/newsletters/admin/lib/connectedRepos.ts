/**
 * "Reuse a connected repo" — the template git repos already connected
 * anywhere in this installation (any newsletter publication, the shared
 * broadcast library), offered when connecting a new one so nobody has to
 * type the URL, branch, path and token again.
 *
 * Pure helpers over `templates_sources` rows; the panel fetches, this
 * dedupes. The token never reaches the browser: reuse goes through the
 * templates API's clone endpoint, which copies the stored credential
 * server-side.
 */

export interface ConnectedRepoSource {
  id: string;
  library_id: string;
  kind: 'git' | 'upload' | 'inline';
  status: 'active' | 'paused' | 'errored';
  label: string;
  url: string | null;
  branch: string | null;
  manifest_path: string | null;
  created_at: string;
  /** From the joined library row, when selected. */
  library?: { name: string; host_kind: string } | null;
}

export interface ConnectedRepo {
  /** The source to clone from (the most recently connected one for this repo). */
  sourceId: string;
  url: string;
  branch: string | null;
  manifestPath: string | null;
  label: string;
  /** Where it is connected, for the picker's description. */
  connectedTo: string[];
}

/**
 * One entry per distinct repo (url + branch + path), newest source first,
 * excluding sources that belong to `excludeLibraryId` (the library being
 * configured — its own sources are listed above the form already) and
 * anything that is not an active git source.
 */
export function dedupeConnectedRepos(rows: ReadonlyArray<ConnectedRepoSource>, excludeLibraryId?: string): ConnectedRepo[] {
  const byKey = new Map<string, ConnectedRepo>();
  const sorted = [...rows]
    .filter((r) => r.kind === 'git' && r.status === 'active' && typeof r.url === 'string' && r.url.trim() !== '')
    .filter((r) => !excludeLibraryId || r.library_id !== excludeLibraryId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const r of sorted) {
    const url = (r.url as string).trim();
    const key = `${url}|${r.branch ?? ''}|${r.manifest_path ?? ''}`;
    const where = r.library?.name ? `${r.library.name}${r.library.host_kind === 'broadcasts' ? ' (broadcasts)' : ''}` : r.library_id;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.connectedTo.includes(where)) existing.connectedTo.push(where);
      continue;
    }
    byKey.set(key, { sourceId: r.id, url, branch: r.branch, manifestPath: r.manifest_path, label: r.label, connectedTo: [where] });
  }
  return [...byKey.values()];
}
