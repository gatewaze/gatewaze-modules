// @ts-nocheck
//
// resolveRepoLocalSkills turns a workspace repo's own `.claude/skills/` into a local plugin named
// `<repo>-local` so the Skill tool can load the skills the repo's working agreement names (sessions
// run with settingSources: [], which never loads them). Only `skills/` is materialised, symlinks are
// skipped, and the whole tree lives in a fresh temp dir the caller cleans up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRepoLocalSkills, repoLocalPluginName } from '../../lib/skills.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'se-repo-skills-test-')); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

function repoWithSkills(name: string, skills: Record<string, string>) {
  const dir = join(ws, name);
  for (const [skill, body] of Object.entries(skills)) {
    mkdirSync(join(dir, '.claude', 'skills', skill), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', skill, 'SKILL.md'), body);
  }
  return { repoName: name, dir };
}

describe('repoLocalPluginName', () => {
  it('suffixes -local and keeps the plugin-name charset', () => {
    expect(repoLocalPluginName('lfx-self-serve')).toBe('lfx-self-serve-local');
    expect(repoLocalPluginName('lfx.v2 service')).toBe('lfx-v2-service-local');
  });
});

describe('resolveRepoLocalSkills', () => {
  it('materialises one plugin per repo that has .claude/skills, with a manifest and the skill files', async () => {
    const a = repoWithSkills('lfx-self-serve', { preflight: '# preflight', 'lfx-self-serve-pr-readiness': '# readiness' });
    const b = { repoName: 'no-skills', dir: join(ws, 'no-skills') };
    mkdirSync(b.dir, { recursive: true });
    mkdirSync(join(ws, 'file-not-dir', '.claude'), { recursive: true });
    writeFileSync(join(ws, 'file-not-dir', '.claude', 'skills'), 'not a directory');
    const c = { repoName: 'file-not-dir', dir: join(ws, 'file-not-dir') };

    const { plugins, cleanup } = await resolveRepoLocalSkills([a, b, c]);
    try {
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({ type: 'local', skipMcpDiscovery: true });
      expect(plugins[0].path.endsWith('/lfx-self-serve-local')).toBe(true);
      const manifest = JSON.parse(readFileSync(join(plugins[0].path, '.claude-plugin', 'plugin.json'), 'utf8'));
      expect(manifest).toMatchObject({ name: 'lfx-self-serve-local', skills: './skills/' });
      expect(readdirSync(join(plugins[0].path, 'skills')).sort()).toEqual(['lfx-self-serve-pr-readiness', 'preflight']);
      expect(readFileSync(join(plugins[0].path, 'skills', 'preflight', 'SKILL.md'), 'utf8')).toBe('# preflight');
      // Only skills/ and the manifest — nothing else from the repo is loaded as plugin content.
      expect(readdirSync(plugins[0].path).sort()).toEqual(['.claude-plugin', 'skills']);
    } finally { await cleanup(); }
    expect(existsSync(plugins[0].path)).toBe(false);
  });

  it('skips symlinks inside the skills directory', async () => {
    const r = repoWithSkills('widgets', { real: '# real' });
    writeFileSync(join(ws, 'secret.txt'), 'outside');
    symlinkSync(join(ws, 'secret.txt'), join(r.dir, '.claude', 'skills', 'real', 'leak.md'));
    symlinkSync(join(ws), join(r.dir, '.claude', 'skills', 'escape'));

    const { plugins, cleanup } = await resolveRepoLocalSkills([r]);
    try {
      expect(plugins).toHaveLength(1);
      expect(existsSync(join(plugins[0].path, 'skills', 'real', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(plugins[0].path, 'skills', 'real', 'leak.md'))).toBe(false);
      expect(existsSync(join(plugins[0].path, 'skills', 'escape'))).toBe(false);
    } finally { await cleanup(); }
  });

  it('two repos with the same name (upstream + fork) do not merge: the second is skipped', async () => {
    const a = repoWithSkills('widgets', { preflight: '# upstream' });
    const b = { repoName: 'widgets', dir: join(ws, 'fork', 'widgets') };
    mkdirSync(join(b.dir, '.claude', 'skills', 'preflight'), { recursive: true });
    writeFileSync(join(b.dir, '.claude', 'skills', 'preflight', 'SKILL.md'), '# fork');
    const warn = vi.fn();
    const { plugins, cleanup } = await resolveRepoLocalSkills([a, b], { warn });
    try {
      expect(plugins).toHaveLength(1);
      expect(readFileSync(join(plugins[0].path, 'skills', 'preflight', 'SKILL.md'), 'utf8')).toBe('# upstream');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('collision'), expect.objectContaining({ plugin: 'widgets-local' }));
    } finally { await cleanup(); }
  });

  it('returns no plugins and a no-op cleanup when nothing is configured', async () => {
    const out = await resolveRepoLocalSkills([]);
    expect(out.plugins).toEqual([]);
    await out.cleanup();
    const out2 = await resolveRepoLocalSkills([{ repoName: 'x', dir: join(ws, 'missing') }]);
    expect(out2.plugins).toEqual([]);
  });
});
