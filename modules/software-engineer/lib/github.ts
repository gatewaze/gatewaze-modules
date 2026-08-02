// @ts-nocheck
/**
 * Thin GitHub REST client via global fetch (Node 22) — no Octokit dependency to bake.
 * Only the handful of calls the pipeline needs. The token is a brand credential, resolved
 * per run; it is never logged.
 */
const BASE = 'https://api.github.com';

export function githubClient(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gatewaze-software-engineer',
  };

  async function j(path: string, init?: RequestInit) {
    const r = await fetch(`${BASE}${path}`, { ...init, headers });
    if (!r.ok) throw new Error(`github ${init?.method ?? 'GET'} ${path} → ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

  return {
    /** The token owner — commits are authored as this user so a PR reads as their own local work. */
    getAuthenticatedUser() {
      return j(`/user`);
    },
    getIssue(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/issues/${number}`);
    },
    /** Open issues on a repo (GitHub returns PRs here too — caller filters on `pull_request`). */
    listIssues(owner: string, name: string, state: 'open' | 'all' = 'open') {
      return j(`/repos/${owner}/${name}/issues?state=${state}&per_page=50&sort=updated`);
    },
    /** Reviews on a PR (APPROVED / CHANGES_REQUESTED / COMMENTED), newest-relevant last. */
    listReviews(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/pulls/${number}/reviews?per_page=100`);
    },
    /** Inline (diff) review comments on a PR. */
    listReviewComments(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/pulls/${number}/comments?per_page=100`);
    },
    /** Conversation (issue) comments on the PR thread. */
    listIssueComments(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/issues/${number}/comments?per_page=100`);
    },
    addLabels(owner: string, name: string, number: number, labels: string[]) {
      return j(`/repos/${owner}/${name}/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels }) });
    },
    async removeLabel(owner: string, name: string, number: number, label: string) {
      const r = await fetch(`${BASE}/repos/${owner}/${name}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', headers });
      return r.ok; // 404 (label not present) is fine
    },
    /** Set the single §2.1 status label — removes the other agent:* status labels first. */
    async setStatusLabel(owner: string, name: string, number: number, label: string | null) {
      const STATUS = ['agent:in-progress', 'agent:in-review', 'agent:blocked'];
      for (const l of STATUS) if (l !== label) { try { await this.removeLabel(owner, name, number, l); } catch { /* not present */ } }
      if (label) { try { await this.addLabels(owner, name, number, [label]); } catch { /* best-effort */ } }
    },
    closeIssue(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    },
    createIssue(owner: string, name: string, body: { title: string; body?: string; labels?: string[] }) {
      return j(`/repos/${owner}/${name}/issues`, { method: 'POST', body: JSON.stringify(body) });
    },
    postComment(owner: string, name: string, number: number, body: string) {
      return j(`/repos/${owner}/${name}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    },
    async fileExists(owner: string, name: string, path: string, ref?: string): Promise<boolean> {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const r = await fetch(`${BASE}/repos/${owner}/${name}/contents/${path}${q}`, { headers });
      return r.ok;
    },
    /** Create or update a single file via the contents API (no clone). Fetches the current sha so
     *  an existing file is updated in place — the repo's git history is the revision log. */
    async putFile(owner: string, name: string, path: string, content: string, message: string) {
      let sha: string | undefined;
      const cur = await fetch(`${BASE}/repos/${owner}/${name}/contents/${path}`, { headers });
      if (cur.ok) sha = (await cur.json())?.sha;
      return j(`/repos/${owner}/${name}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      });
    },
    async defaultBranch(owner: string, name: string): Promise<string> {
      const repo = await j(`/repos/${owner}/${name}`);
      return repo.default_branch;
    },
    /** True when the branch has protection with required status checks configured. */
    async hasBranchProtection(owner: string, name: string, branch: string): Promise<boolean> {
      const r = await fetch(`${BASE}/repos/${owner}/${name}/branches/${branch}/protection`, { headers });
      if (!r.ok) return false;
      const p = await r.json();
      return Boolean(p?.required_status_checks);
    },
    /** base...head file diff — used for blast-radius (avoids needing full history in a shallow clone). */
    compare(owner: string, name: string, base: string, head: string) {
      return j(`/repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    },
    createPullRequest(owner: string, name: string, body: { title: string; head: string; base: string; body: string; draft?: boolean }) {
      return j(`/repos/${owner}/${name}/pulls`, { method: 'POST', body: JSON.stringify(body) });
    },
    getPullRequest(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/pulls/${number}`);
    },
    /** Merge a PR. Fails (throws) if branch-protection required checks aren't satisfied — which is
     * exactly the desired backstop: a non-bypass token cannot force a red merge. */
    mergePullRequest(owner: string, name: string, number: number, method: 'merge' | 'squash' | 'rebase' = 'squash') {
      return j(`/repos/${owner}/${name}/pulls/${number}/merge`, {
        method: 'PUT',
        body: JSON.stringify({ merge_method: method }),
      });
    },
    /** Update a PR branch by merging its base into it (the "Update branch" button). Clears a PR held
     * at mergeable_state 'behind' under strict branch protection: required checks re-run against the
     * latest base and a later merge-tick lands it once clean. Throws 422 when the branch is already
     * up to date — callers treat this best-effort. */
    updateBranch(owner: string, name: string, number: number) {
      return j(`/repos/${owner}/${name}/pulls/${number}/update-branch`, { method: 'PUT' });
    },
    /** Open PRs AUTHORED by the token owner (`author:@me`), restricted to the given `owner/name`
     * repos — the project's CONNECTED code repos, never the token's whole visible universe (a
     * personal PAT would otherwise drag every unrelated personal/org PR onto the Overview board).
     * `repos` empty → no results. GitHub caps a search query at 256 chars, so the repo qualifiers
     * are chunked across multiple searches and merged, newest-updated first, capped at `perPage`. */
    async searchAuthoredOpenPRs(perPage = 50, repos: string[] = []) {
      // Defensive: qualifiers are interpolated into the search string — only well-formed
      // owner/name slugs may pass (values come from se_repos, but belt-and-braces).
      const safe = repos.filter((r) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r));
      if (safe.length === 0) return { items: [] };
      const BASE_Q = 'is:pr is:open author:@me archived:false';
      const MAX_Q = 256;
      const chunks: string[][] = [[]];
      let len = BASE_Q.length;
      for (const r of safe) {
        const add = ` repo:${r}`.length;
        if (len + add > MAX_Q && chunks[chunks.length - 1].length > 0) { chunks.push([]); len = BASE_Q.length; }
        chunks[chunks.length - 1].push(r);
        len += add;
      }
      const cap = Math.min(Math.max(perPage, 1), 100);
      const seen = new Set<string>();
      const items: Record<string, unknown>[] = [];
      for (const chunk of chunks) {
        const q = encodeURIComponent(`${BASE_Q} ${chunk.map((r) => `repo:${r}`).join(' ')}`);
        const res = await j(`/search/issues?q=${q}&sort=updated&order=desc&per_page=${cap}`);
        for (const it of res?.items ?? []) {
          const key = `${it.repository_url}#${it.number}`;
          if (!seen.has(key)) { seen.add(key); items.push(it); }
        }
      }
      items.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
      return { items: items.slice(0, cap) };
    },
    /** Check-run rollup for a commit (GitHub Actions + apps). Drives the CI part of PR status. */
    listCheckRuns(owner: string, name: string, ref: string) {
      return j(`/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
    },
  };
}
