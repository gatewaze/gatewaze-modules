/**
 * A repo's working agreement for AI agents: `CLAUDE.md` and/or `AGENTS.md` at its root, plus its
 * `.claude/rules/*.md`. Repos are split between the two names (lfx-self-serve consolidated its
 * CLAUDE.md into AGENTS.md; the LFX Go services keep CLAUDE.md; some carry both), so both are read
 * and injected, each under its own file name. Before this, only CLAUDE.md was read, so an
 * AGENTS.md-only repo's rules — its pre-PR review section among them — never reached the agent.
 *
 * Pure filesystem; no SDK imports, so it is cheap to test and to reuse from any phase.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// The files a repo may keep its agent working agreement in, in injection order.
export const AGREEMENT_FILES = ['CLAUDE.md', 'AGENTS.md'];

/**
 * Read a repo's working agreement as one markdown block: each agreement file under a `#### <name>`
 * heading (identical content under both names is injected once), then the rules under
 * `#### <rulePrefix>.claude/rules/<file>` in name order. Returns '' when the repo has neither file
 * and no rules. `maxFile` / `maxRule` cap each part so one repo cannot crowd out the task.
 */
export async function readWorkingAgreement(
  dir: string,
  opts: { maxFile?: number; maxRule?: number; rulePrefix?: string } = {},
): Promise<string> {
  const maxFile = opts.maxFile ?? 16000;
  const maxRule = opts.maxRule ?? 8000;
  let out = '';
  const seen = new Set<string>();
  for (const name of AGREEMENT_FILES) {
    let body = '';
    // Only "not there" is silence. Any other read failure (permissions, a directory by that name,
    // I/O) would otherwise drop the agreement and let the agent run without the repo's rules.
    try { body = await readFile(join(dir, name), 'utf8'); } catch (e) { if (isAbsent(e)) continue; throw e; }
    const key = body.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out += `\n\n#### ${name}\n${body.slice(0, maxFile)}`;
  }
  const rulesDir = join(dir, '.claude', 'rules');
  let ruleFiles: string[] = [];
  try { ruleFiles = (await readdir(rulesDir)).filter((n) => n.endsWith('.md')).sort(); } catch (e) { if (!isAbsent(e)) throw e; }
  for (const f of ruleFiles) {
    let body = '';
    // A dangling symlink lists but does not read: absence again, not an error.
    try { body = await readFile(join(rulesDir, f), 'utf8'); } catch (e) { if (isAbsent(e)) continue; throw e; }
    out += `\n\n#### ${opts.rulePrefix ?? ''}.claude/rules/${f}\n` + body.slice(0, maxRule);
  }
  return out;
}

const isAbsent = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};
