/**
 * mcp-resolve tests — covers ${GATEWAZE_*} substitution and the full
 * auth resolution chain (none / bearer.env_key / bearer.use_case_credential).
 *
 * Operator-config and SSRF blocklist are real (not mocked) — the
 * config is loaded from a temp file pointed to by
 * AI_RECIPES_CONFIG_PATH, and the env vars exercised here use safe
 * (public) hostnames so the URL-shape check passes.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadOperatorConfig } from '../../lib/recipes/operator-config.js';
import {
  resolveMcpExtension,
  substituteGatewazeVars,
} from '../../lib/recipes/mcp-resolve.js';

let tmpDir: string;
let configPath: string;

function writeOperatorConfig(yaml: string) {
  writeFileSync(configPath, yaml, 'utf-8');
  reloadOperatorConfig();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-resolve-test-'));
  configPath = join(tmpDir, 'ai-recipes.yaml');
  process.env.AI_RECIPES_CONFIG_PATH = configPath;
  writeOperatorConfig(`mcp_env:\n  GATEWAZE_PUBLIC_HOST: mcp.example.com\n  GATEWAZE_TOKEN_PROD: tok-prod-abc\n`);
});

afterEach(() => {
  delete process.env.AI_RECIPES_CONFIG_PATH;
  delete process.env.GATEWAZE_HOST_SECRET;
  rmSync(tmpDir, { recursive: true, force: true });
  reloadOperatorConfig();
});

describe('substituteGatewazeVars', () => {
  it('replaces ${GATEWAZE_*} with operator-config value', () => {
    const r = substituteGatewazeVars('https://${GATEWAZE_PUBLIC_HOST}/v1');
    expect(r).toEqual({ ok: true, value: 'https://mcp.example.com/v1' });
  });

  it('returns refusal for undefined GATEWAZE_* var', () => {
    const r = substituteGatewazeVars('https://${GATEWAZE_MISSING}/v1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('undefined_var: GATEWAZE_MISSING');
  });

  it('refuses non-GATEWAZE_ namespaced var', () => {
    const r = substituteGatewazeVars('https://${HOME}/x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('non_gatewaze_var: HOME');
  });

  it('handles multiple substitutions in one template', () => {
    writeOperatorConfig(
      `mcp_env:\n  GATEWAZE_A: alpha\n  GATEWAZE_B: beta\n  GATEWAZE_PUBLIC_HOST: mcp.example.com\n`,
    );
    const r = substituteGatewazeVars('https://${GATEWAZE_A}.${GATEWAZE_B}/v1');
    expect(r).toEqual({ ok: true, value: 'https://alpha.beta/v1' });
  });

  it('passes through templates with no substitutions', () => {
    const r = substituteGatewazeVars('https://mcp.example.com/v1');
    expect(r).toEqual({ ok: true, value: 'https://mcp.example.com/v1' });
  });

  it('respects mcp_env_passthrough fallback to process.env', () => {
    writeOperatorConfig(`mcp_env_passthrough: true\nmcp_env: {}\n`);
    process.env.GATEWAZE_HOST_SECRET = 'host-value';
    const r = substituteGatewazeVars('https://${GATEWAZE_HOST_SECRET}/v1');
    expect(r).toEqual({ ok: true, value: 'https://host-value/v1' });
  });

  it('default mcp_env_passthrough=false does NOT leak process.env', () => {
    process.env.GATEWAZE_HOST_SECRET = 'host-value';
    const r = substituteGatewazeVars('https://${GATEWAZE_HOST_SECRET}/v1');
    expect(r.ok).toBe(false);
  });
});

describe('resolveMcpExtension — auth.none', () => {
  it('returns ok with no bearer for auth.none', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { none: true },
      },
      'my-use-case',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uri).toBe('https://mcp.example.com/mcp');
    expect(r.bearer_token).toBeUndefined();
  });
});

describe('resolveMcpExtension — auth.bearer.env_key', () => {
  it('resolves env_key from operator-config mcp_env', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { env_key: 'GATEWAZE_TOKEN_PROD' } },
      },
      'my-use-case',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bearer_token).toBe('tok-prod-abc');
  });

  it('refuses env_key that does not match GATEWAZE_[A-Z_]+', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { env_key: 'random_var' } },
      },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid-env-key');
  });

  it('refuses undefined env_key', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { env_key: 'GATEWAZE_NOT_DEFINED' } },
      },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('env-key-undefined');
  });
});

describe('resolveMcpExtension — auth.bearer.use_case_credential', () => {
  it('resolves via supplied closure', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { use_case_credential: true } },
      },
      'my-use-case',
      async (provider, useCase) => {
        expect(provider).toBe('mcp');
        expect(useCase).toBe('my-use-case');
        return 'use-case-token';
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bearer_token).toBe('use-case-token');
  });

  it('refuses when no resolver supplied', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { use_case_credential: true } },
      },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('use-case-credential-unavailable');
  });

  it('refuses when resolver returns null', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_PUBLIC_HOST}/mcp',
        auth: { bearer: { use_case_credential: true } },
      },
      'uc',
      async () => null,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('use-case-credential-unavailable');
  });
});

describe('resolveMcpExtension — refusal envelope', () => {
  it('refuses non-streamable_http type', async () => {
    const r = await resolveMcpExtension(
      { type: 'stdio', uri: 'https://x.com/' },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed-extension');
  });

  it('refuses missing uri', async () => {
    const r = await resolveMcpExtension(
      { type: 'streamable_http' },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('malformed-extension');
  });

  it('refuses missing auth block entirely', async () => {
    const r = await resolveMcpExtension(
      { type: 'streamable_http', uri: 'https://mcp.example.com/' },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing-auth-block');
  });

  it('refuses bearer block without env_key or use_case_credential', async () => {
    const r = await resolveMcpExtension(
      { type: 'streamable_http', uri: 'https://mcp.example.com/', auth: { bearer: {} } },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing-auth-block');
  });

  it('flags env-substitution when URI references undefined GATEWAZE_*', async () => {
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_MISSING_HOST}/mcp',
        auth: { none: true },
      },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('env-substitution');
  });

  it('flags ssrf-substituted when post-substitution URL is internal', async () => {
    writeOperatorConfig(`mcp_env:\n  GATEWAZE_INTERNAL_HOST: localhost\n`);
    const r = await resolveMcpExtension(
      {
        type: 'streamable_http',
        uri: 'https://${GATEWAZE_INTERNAL_HOST}/mcp',
        auth: { none: true },
      },
      'uc',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ssrf-substituted');
  });
});
