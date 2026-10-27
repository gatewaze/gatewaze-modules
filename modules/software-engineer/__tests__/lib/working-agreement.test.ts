// @ts-nocheck
//
// readWorkingAgreement is what every agent phase injects as a repo's working agreement. Repos keep
// it in CLAUDE.md, in AGENTS.md (lfx-self-serve consolidated the former into the latter), or both;
// before this helper only CLAUDE.md was read, so an AGENTS.md-only repo's rules — including its
// pre-PR review section — never reached the agent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWorkingAgreement } from '../../lib/working-agreement.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'se-agreement-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readWorkingAgreement', () => {
  it('reads CLAUDE.md alone', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Claude rules');
    const out = await readWorkingAgreement(dir);
    expect(out).toContain('#### CLAUDE.md\n# Claude rules');
    expect(out).not.toContain('AGENTS.md');
  });

  it('reads AGENTS.md alone (the lfx-self-serve shape)', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n\n## Pre-PR review\nLoad the skill.');
    const out = await readWorkingAgreement(dir);
    expect(out).toContain('#### AGENTS.md\n# Agents');
    expect(out).toContain('## Pre-PR review');
  });

  it('injects both when they differ, CLAUDE.md first', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md');
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents');
    const out = await readWorkingAgreement(dir);
    expect(out.indexOf('#### CLAUDE.md')).toBeLessThan(out.indexOf('#### AGENTS.md'));
    expect(out).toContain('# Agents');
  });

  it('injects identical content only once', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Same\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# Same\n');
    const out = await readWorkingAgreement(dir);
    expect(out.match(/# Same/g)).toHaveLength(1);
    expect(out).toContain('#### CLAUDE.md');
  });

  it('appends .claude/rules/*.md in name order with the caller prefix, and caps sizes', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(50));
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'rules', 'b.md'), 'rule b');
    writeFileSync(join(dir, '.claude', 'rules', 'a.md'), 'rule a is long');
    writeFileSync(join(dir, '.claude', 'rules', 'notes.txt'), 'ignored');
    const out = await readWorkingAgreement(dir, { maxFile: 10, maxRule: 6, rulePrefix: 'acme/widgets/' });
    expect(out).toContain('#### AGENTS.md\n' + 'x'.repeat(10) + '\n');
    expect(out).toContain('#### acme/widgets/.claude/rules/a.md\nrule a');
    expect(out).toContain('#### acme/widgets/.claude/rules/b.md\nrule b');
    expect(out.indexOf('rules/a.md')).toBeLessThan(out.indexOf('rules/b.md'));
    expect(out).not.toContain('ignored');
  });

  it('a dangling symlink under .claude/rules is skipped like an absent file', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# a');
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'rules', 'ok.md'), 'rule');
    symlinkSync('/nonexistent/target.md', join(dir, '.claude', 'rules', 'dangling.md'));
    const out = await readWorkingAgreement(dir);
    expect(out).toContain('rules/ok.md\nrule');
    expect(out).not.toContain('dangling');
  });

  it('is silent only on absence — any other read failure surfaces instead of dropping the agreement', async () => {
    mkdirSync(join(dir, 'AGENTS.md'));   // a directory by that name: EISDIR, not ENOENT
    await expect(readWorkingAgreement(dir)).rejects.toThrow();
  });

  it('returns an empty string for a repo with no agreement and no rules', async () => {
    expect(await readWorkingAgreement(dir)).toBe('');
    writeFileSync(join(dir, 'CLAUDE.md'), '   \n');
    expect(await readWorkingAgreement(dir)).toBe('');
  });
});
