#!/usr/bin/env node
/**
 * spec-ai-mcp-extensions.md §Stdio execution risk §Safe-spawn adapter.
 *
 * Receives a JSON descriptor of an MCP stdio extension via the env
 * var GATEWAZE_MCP_LAUNCH_DESCRIPTOR, then spawns the actual MCP
 * server using `child_process.spawn(cmd, args, { shell: false })` —
 * execve semantics, never `/bin/sh -c`. Bidirectionally proxies the
 * Goose ↔ MCP-server stdio so Goose's `--with-extension` machinery
 * sees a normal stdio extension.
 *
 * The wrapper code (lib/recipes/run-recipe-goose.ts) sets the env
 * before invoking Goose, so multiple extensions can coexist — each
 * gets its own descriptor env name like
 * GATEWAZE_MCP_LAUNCH_DESCRIPTOR_<sanitized-name>.
 *
 * Usage from Goose:
 *   --with-extension "node /path/to/gatewaze-goose-launcher.mjs <descriptor-env-name>"
 *
 * Descriptor JSON shape:
 *   {
 *     "cmd": "uvx",
 *     "args": ["mcp-hn"],
 *     "env": { "BRAVE_API_KEY": "...", ... }
 *   }
 *
 * Why a JSON envelope vs flag passing? Goose's --with-extension
 * accepts a SINGLE quoted string and may split it on whitespace
 * internally. Carrying the descriptor in env sidesteps any
 * shell-quoting / whitespace parsing in Goose entirely.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const descriptorEnvName = process.argv[2];
if (!descriptorEnvName) {
  process.stderr.write('gatewaze-goose-launcher: descriptor env-var name required as first arg\n');
  process.exit(2);
}

const raw = process.env[descriptorEnvName];
if (!raw) {
  process.stderr.write(`gatewaze-goose-launcher: env ${descriptorEnvName} not set\n`);
  process.exit(2);
}

let descriptor;
try {
  descriptor = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`gatewaze-goose-launcher: descriptor JSON parse failed: ${err.message}\n`);
  process.exit(2);
}

const { cmd, args, env } = descriptor;
if (typeof cmd !== 'string' || cmd.length === 0) {
  process.stderr.write('gatewaze-goose-launcher: descriptor.cmd required\n');
  process.exit(2);
}
if (!Array.isArray(args)) {
  process.stderr.write('gatewaze-goose-launcher: descriptor.args must be an array\n');
  process.exit(2);
}
for (const a of args) {
  if (typeof a !== 'string') {
    process.stderr.write(`gatewaze-goose-launcher: descriptor.args contains non-string: ${JSON.stringify(a)}\n`);
    process.exit(2);
  }
}

// Spawn with shell: false → execve semantics. Arguments are passed
// as the argv array verbatim; the shell never sees them.
const childEnv = { ...process.env, ...(env && typeof env === 'object' ? env : {}) };
const child = spawn(cmd, args, {
  shell: false,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: childEnv,
});

child.on('error', (err) => {
  process.stderr.write(`gatewaze-goose-launcher: spawn error: ${err.message}\n`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

// Forward signals so cancellation works end-to-end.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
