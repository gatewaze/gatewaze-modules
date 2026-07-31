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
  };
}
