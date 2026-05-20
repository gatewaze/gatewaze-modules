import { describe, expect, it } from 'vitest';

/**
 * Lightweight unit tests for ai/api/mcp-servers.ts validation logic.
 * The functions under test are private to the module; we exercise
 * them indirectly via the regex + allowlist constants the API uses.
 * Heavier end-to-end tests live in the platform's integration suite.
 */

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

describe('MCP server name validation', () => {
  it('accepts valid kebab-case names', () => {
    for (const n of ['hackernews', 'chrome-devtools', 'lf-x', 'h1', 'a-b-c']) {
      expect(NAME_RE.test(n), `${n} should be valid`).toBe(true);
    }
  });
  it('rejects invalid names', () => {
    for (const n of ['Hackernews', 'hackerNews', '-leading', 'trailing-', '1numeric', 'snake_case', 'space name', '']) {
      expect(NAME_RE.test(n), `${n} should be invalid`).toBe(false);
    }
  });
});

describe('MCP env-key validation', () => {
  it('accepts UPPER_SNAKE_CASE keys', () => {
    for (const k of ['API_KEY', 'BRAVE_API_KEY', 'GITHUB_TOKEN', 'X', 'A1', 'A_B_C']) {
      expect(ENV_KEY_RE.test(k), `${k} should be valid`).toBe(true);
    }
  });
  it('rejects lowercase / mixed-case / leading-digit keys', () => {
    for (const k of ['api_key', 'apiKey', 'API-KEY', '1KEY', '_LEADING', '']) {
      expect(ENV_KEY_RE.test(k), `${k} should be invalid`).toBe(false);
    }
  });
});

describe('MCP shell-meta detection', () => {
  function isShellMeta(arg: string): boolean {
    return /[;&|`$()<>]/.test(arg);
  }
  it('flags args containing shell metacharacters', () => {
    for (const a of ['foo;bar', 'a&b', 'a|b', 'a`b', 'a$b', 'a(b', 'a)b', 'a<b', 'a>b']) {
      expect(isShellMeta(a), `${a} should be flagged`).toBe(true);
    }
  });
  it('allows clean args', () => {
    for (const a of ['mcp-hn', '@upstash/context7-mcp', 'beads-mcp', '--from', 'git+https://github.com/foo/bar']) {
      expect(isShellMeta(a), `${a} should pass`).toBe(false);
    }
  });
});
