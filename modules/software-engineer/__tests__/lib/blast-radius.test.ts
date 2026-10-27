// @ts-nocheck
//
// The blast-radius classifier gates auto-merge. A branch that rewrites a repo's agent working
// agreement (CLAUDE.md / AGENTS.md — the same files the pre-PR review phase guards) must never
// score 'safe', the same as a change under .claude/.
import { describe, it, expect } from 'vitest';
import { classifyBlastRadius } from '../../lib/blast-radius.js';

const f = (filename: string, additions = 1, deletions = 0) => ({ filename, status: 'modified', additions, deletions });

describe('classifyBlastRadius — agent guardrails', () => {
  it('a small ordinary change is safe', () => {
    expect(classifyBlastRadius([f('src/a.ts', 3, 1)]).classification).toBe('safe');
  });
  it('touching the working agreement needs a human', () => {
    expect(classifyBlastRadius([f('AGENTS.md')]).classification).toBe('needs_human');
    expect(classifyBlastRadius([f('CLAUDE.md')]).classification).toBe('needs_human');
    expect(classifyBlastRadius([f('packages/x/CLAUDE.md')]).classification).toBe('needs_human');
    expect(classifyBlastRadius([f('.claude/rules/x.md')]).classification).toBe('needs_human');
  });
  it('a file merely named like one is not matched', () => {
    expect(classifyBlastRadius([f('docs/AGENTS.md.bak')]).classification).toBe('safe');
  });
});
