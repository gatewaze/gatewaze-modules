/**
 * Hostname label grammar for hostname-keyed LFX test environments — the TS
 * twin of `gatewaze-environments/scripts/lfx-envlabel.py` (the canonical
 * implementation the host agent validates every request against). Ported
 * faithfully for spec-se-multi-test-envs.md §2 (lfx profile, phase 2):
 *
 *     envlabel = "lfx--" spec
 *     spec     = group *( "--" group )
 *     group    = alias "-" prlist          ; ordered same-repo PR merges
 *              | alias "-b-" slug          ; branch-watch (slug is LOSSY —
 *                                           the registry keeps the exact ref)
 *     prlist   = prnum *( "-" prnum )
 *
 * The API validates + encodes here BEFORE writing a request file, and the
 * host agent re-validates with the Python original — the two must agree, so
 * `lib/__tests__/env-label.test.ts` pins this port against captured
 * lfx-envlabel.py outputs. If you change semantics here, change the Python
 * first and re-pin.
 *
 * Deliberate properties carried over from the Python:
 *  - Error messages NEVER echo raw request values (the Python fixed a
 *    JSON-injection into shell-built status files; here it also keeps
 *    reflected-input out of API error bodies).
 *  - `h-` overflow labels are rejected (they need a registry write at encode
 *    time — still a later phase).
 *  - Tier policy: only Tier-A repos (lfx-self-serve, lfx-v2-newsletter-service)
 *    may appear in a multi-env spec; Tier-B NATS queue-group subscribers and
 *    helm are rejected with the same explanations the agent gives.
 *
 * Pure module: no imports, no platform deps — shared by the API routes
 * (api/admin-routes.ts) and the admin set-builder's live label preview.
 */

export type EnvSpecEntry = { repo: string; pr: number } | { repo: string; branch: string };
export type ParsedSpecEntry = { repo: string; pr: number } | { repo: string; slug: string };

// Alias table (spec §2.2, lfx rows — permanent once labels circulate).
export const ENV_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['self-serve', 'lfx-self-serve'],
  ['helm', 'lfx-v2-helm'],
  ['email', 'lfx-v2-email-service'],
  ['campaign', 'lfx-v2-campaign-service'],
  ['ml', 'lfx-v2-mailing-list-service'],
  ['newsletter', 'lfx-v2-newsletter-service'],
  ['committee', 'lfx-v2-committee-service'],
];
const ALIAS_TO_REPO = new Map(ENV_ALIASES.map(([a, r]) => [a, r]));
const REPO_TO_ALIAS = new Map(ENV_ALIASES.map(([a, r]) => [r, a]));

// Tier split (spec §5.4) + phase-1 helm restriction.
export const ENV_TIER_A = new Set(['lfx-self-serve', 'lfx-v2-newsletter-service']);
const TIER_B = new Set([
  'lfx-v2-email-service', 'lfx-v2-campaign-service',
  'lfx-v2-mailing-list-service', 'lfx-v2-committee-service',
]);

export const ENV_MAX_LABEL = 54; // spec §2.5: keep room for the longest role suffix
const PROJECT = 'lfx';

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function slugifyBranch(branch: string): string {
  const s = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 20).replace(/-+$/g, '');
}

/**
 * spec → canonical label. Canonicalisation (spec §2.3): adjacent same-repo PR
 * groups merge; order is otherwise preserved verbatim. Mirrors encode() in
 * lfx-envlabel.py including its exact error strings (minus the label echo in
 * the overflow case — length only, no reflected content).
 */
export function encodeEnvLabel(spec: unknown): { label: string; error: null } | { label: null; error: string } {
  if (!Array.isArray(spec)) return { label: null, error: 'spec must be a list' };
  const groups: Array<{ alias: string; kind: 'pr' | 'branch'; items: string[] }> = [];
  for (const e of spec) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      return { label: null, error: 'spec entries must be objects' };
    }
    const entry = e as Record<string, unknown>;
    const alias = REPO_TO_ALIAS.get(String(entry.repo ?? ''));
    if (alias === undefined) {
      // Deliberately does NOT echo the raw value (see file header).
      return { label: null, error: 'unknown repo in spec (not in the alias table)' };
    }
    const repo = String(entry.repo);
    if ('pr' in entry) {
      const n = entry.pr;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99999) {
        return { label: null, error: `bad pr number for ${repo}` };
      }
      const last = groups[groups.length - 1];
      if (last && last.alias === alias && last.kind === 'pr') last.items.push(String(n));
      else groups.push({ alias, kind: 'pr', items: [String(n)] });
    } else if ('branch' in entry) {
      const b = entry.branch;
      if (typeof b !== 'string' || !BRANCH_RE.test(b) || b.includes('..')) {
        return { label: null, error: `bad branch name for ${repo}` };
      }
      const slug = slugifyBranch(b);
      if (!slug) return { label: null, error: `branch for ${repo} slugifies to nothing` };
      groups.push({ alias, kind: 'branch', items: [slug] });
    } else {
      return { label: null, error: `spec entry for ${repo} has neither pr nor branch` };
    }
  }
  if (groups.length === 0) return { label: null, error: 'empty spec' };
  const parts = groups.map((g) => (g.kind === 'pr' ? `${g.alias}-${g.items.join('-')}` : `${g.alias}-b-${g.items[0]}`));
  const label = `${PROJECT}--${parts.join('--')}`;
  if (label.length > ENV_MAX_LABEL) {
    return {
      label: null,
      error: `label is ${label.length} chars (max ${ENV_MAX_LABEL}) — overflow (h-) labels need the registry-backed form, which is not implemented yet`,
    };
  }
  return { label, error: null };
}

/**
 * label → spec. Branch groups come back as {repo, slug} — the exact ref lives
 * in the registry only. Mirrors parse() in lfx-envlabel.py.
 */
export function parseEnvLabel(label: unknown): { spec: ParsedSpecEntry[]; error: null } | { spec: null; error: string } {
  const l = typeof label === 'string' ? label : '';
  if (!DNS_LABEL_RE.test(l)) return { spec: null, error: 'not a valid DNS label' };
  if (l.length > ENV_MAX_LABEL) return { spec: null, error: `label longer than ${ENV_MAX_LABEL} chars` };
  if (!l.startsWith(`${PROJECT}--`)) return { spec: null, error: `label must start with '${PROJECT}--'` };
  const rest = l.slice(PROJECT.length + 2);
  if (!rest) return { spec: null, error: 'empty spec' };
  const spec: ParsedSpecEntry[] = [];
  const aliasesByLen = [...ALIAS_TO_REPO.keys()].sort((a, b) => b.length - a.length); // longest match
  for (const group of rest.split('--')) {
    if (group.startsWith('h-')) return { spec: null, error: 'overflow (h-) labels need the registry — not supported here' };
    const alias = aliasesByLen.find((a) => group === a || group.startsWith(`${a}-`));
    if (alias === undefined) return { spec: null, error: 'unknown repo alias in a label group' };
    const repo = ALIAS_TO_REPO.get(alias) as string;
    const tail = group.slice(alias.length);
    if (tail.startsWith('-b-')) {
      const slug = tail.slice(3);
      if (!DNS_LABEL_RE.test(slug)) return { spec: null, error: 'bad branch slug in a label group' };
      spec.push({ repo, slug });
      continue;
    }
    if (!tail.startsWith('-')) return { spec: null, error: 'a label group has no PR list' };
    const prs = tail.slice(1).split('-');
    if (!prs.every((p) => /^[1-9][0-9]{0,4}$/.test(p))) return { spec: null, error: 'bad PR list in a label group' };
    for (const p of prs) spec.push({ repo, pr: Number(p) });
  }
  return { spec, error: null };
}

/**
 * Phase-1 deployability policy — null when the spec passes, else the same
 * explanatory reason the host agent's tier_check gives (surfaced verbatim in
 * the UI per the phase-1 landing report).
 */
export function envTierCheck(spec: Array<{ repo: string }>): string | null {
  for (const e of spec) {
    const repo = e.repo;
    if (ENV_TIER_A.has(repo)) continue;
    if (TIER_B.has(repo)) {
      return `${repo} is a Tier-B NATS queue-group subscriber (spec §5.4): a second instance would steal traffic from the primary env. Test it in the primary slot instead.`;
    }
    if (repo === 'lfx-v2-helm') {
      return 'lfx-v2-helm changes upgrade the SHARED cluster and cannot be instantiated per-env. Use the primary slot.';
    }
    return `${repo} is not deployable in a hostname-keyed env`;
  }
  return null;
}
