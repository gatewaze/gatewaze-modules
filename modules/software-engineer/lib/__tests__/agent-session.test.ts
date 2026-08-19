// @ts-nocheck — vitest harness; lib modules are @ts-nocheck'd already.
//
// Issue #58: recurring autocompact-thrashing failures (LFX #17, LFX #15) traced to whole-file
// Reads / `cat` filling the context window. This pins the PreToolUse guard that mechanically
// rejects a whole-file Read or a `cat` on an oversized file — plus the pre-existing Bash
// forbidden-flag guard, which had shipped without a test until now. Both runPhase and
// runInteractive build their hooks via the same buildPreToolUseHooks() helper, so this file
// exercises both entry points to confirm neither one drifted from the other.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let capturedOptions: any;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((opts: any) => {
    capturedOptions = opts.options;
    return (async function* () {})(); // empty async iterable; runPhase/runInteractive just drain it
  }),
}));

import { InProcessRunner } from '../agent-session.js';

const CRED = { kind: 'anthropic_api_key', value: 'x' };

describe('agent-session PreToolUse guards (issue #58 + Bash forbidden-flag)', () => {
  let dir: string;

  beforeEach(async () => {
    capturedOptions = undefined;
    dir = await mkdtemp(join(tmpdir(), 'se-agent-session-test-'));
  });

  async function writeLines(name: string, count: number) {
    const path = join(dir, name);
    await writeFile(path, Array.from({ length: count }, (_, i) => `line ${i}`).join('\n'), 'utf8');
    return path;
  }

  async function bashHook() {
    const runner = new InProcessRunner();
    await runner.runPhase({ cwd: dir, prompt: 'do it', model: 'claude-sonnet-5', credential: CRED });
    const bash = capturedOptions.hooks.PreToolUse.find((h: any) => h.matcher === 'Bash');
    return bash.hooks[0];
  }

  async function readHook() {
    const runner = new InProcessRunner();
    await runner.runPhase({ cwd: dir, prompt: 'do it', model: 'claude-sonnet-5', credential: CRED });
    const read = capturedOptions.hooks.PreToolUse.find((h: any) => h.matcher === 'Read');
    return read.hooks[0];
  }

  it('denies a Bash command with --no-verify', async () => {
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: 'git push --no-verify' } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies a Bash command with --force', async () => {
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: 'git push --force' } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies rm -rf /', async () => {
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: 'rm -rf /' } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows an ordinary Bash command', async () => {
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: 'pnpm test' } });
    expect(res).toEqual({});
  });

  it('allows cat on a small file', async () => {
    const small = await writeLines('small.txt', 20);
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: `cat ${small}` } });
    expect(res).toEqual({});
  });

  it('denies cat on a file over the line threshold', async () => {
    const big = await writeLines('big.txt', 2000);
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: `cat ${big}` } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput.permissionDecisionReason).toMatch(/2000|head|tail|grep/);
  });

  it('allows cat piped into grep even on a large file', async () => {
    const big = await writeLines('big2.txt', 2000);
    const hook = await bashHook();
    const res = await hook({ tool_input: { command: `cat ${big} | grep foo` } });
    expect(res).toEqual({});
  });

  it('allows cat with a relative path resolved against cwd', async () => {
    await writeLines('small-rel.txt', 20);
    const hookSmall = await bashHook();
    const resSmall = await hookSmall({ tool_input: { command: 'cat small-rel.txt' } });
    expect(resSmall).toEqual({});

    await writeLines('big-rel.txt', 2000);
    const hookBig = await bashHook();
    const resBig = await hookBig({ tool_input: { command: 'cat big-rel.txt' } });
    expect(resBig.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows a Read with a limit on a large file', async () => {
    const big = await writeLines('big3.txt', 2000);
    const hook = await readHook();
    const res = await hook({ tool_input: { file_path: big, limit: 400 } });
    expect(res).toEqual({});
  });

  it('allows a Read with no limit on a small file', async () => {
    const small = await writeLines('small2.txt', 20);
    const hook = await readHook();
    const res = await hook({ tool_input: { file_path: small } });
    expect(res).toEqual({});
  });

  it('denies a Read with no limit on a file over the line threshold', async () => {
    const big = await writeLines('big4.txt', 2000);
    const hook = await readHook();
    const res = await hook({ tool_input: { file_path: big } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput.permissionDecisionReason).toMatch(/offset/);
  });

  it('allows a Read with no limit when the file cannot be read', async () => {
    const hook = await readHook();
    const res = await hook({ tool_input: { file_path: join(dir, 'does-not-exist.txt') } });
    expect(res).toEqual({});
  });

  it('runInteractive wires the same shared PreToolUse hooks (denies cat on a large file)', async () => {
    const big = await writeLines('big5.txt', 2000);
    const runner = new InProcessRunner();
    await runner.runInteractive({
      cwd: dir,
      kickoff: 'do it',
      model: 'claude-sonnet-5',
      credential: CRED,
      inputSource: (async function* () {})(),
    });
    const bash = capturedOptions.hooks.PreToolUse.find((h: any) => h.matcher === 'Bash');
    const res = await bash.hooks[0]({ tool_input: { command: `cat ${big}` } });
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
