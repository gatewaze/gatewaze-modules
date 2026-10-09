import { describe, it, expect, vi } from 'vitest';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, relative } from 'node:path';
vi.mock('../git.js', () => ({
  authedRemote: (owner: string, name: string) => `${owner}/${name}`,
  git: async (args: string[]) => {
    if (args[0] === 'clone') {
      const dir = args.at(-1)!;
      await mkdir(dir); // Real filesystem: a reused destination fails.
      if (args.at(-2) === 'unavailable/modules') throw new Error('inaccessible');
      await writeFile(join(dir, 'source'), args.at(-2)!);
    }
    return args.includes('rev-parse') ? 'abc123\n' : '';
  },
}));
import { makeMultiWorkspace } from '../worktree.js';
const repo = (repoOwner: string, repoName = 'modules', writeMode = 'writable') => ({ repoOwner, repoName, writeMode, baseBranch: 'main' });
describe('multi-repository workspace isolation', () => {
  it('clones same-name repos from different owners separately and retains identity', async () => {
    const ws = await makeMultiWorkspace([repo('private'), repo('public')], 'token', 'feature');
    try {
      expect(ws.repos.map(r => relative(ws.root, r.dir))).toEqual(['private/modules', 'public/modules']);
      for (const r of ws.repos) expect(await readFile(join(r.dir, 'source'), 'utf8')).toBe(`${r.repoOwner}/${r.repoName}`);
    } finally { await ws.cleanup(); }
  });
  it('failed read-only clone cannot remove another owners writable checkout', async () => {
    const ws = await makeMultiWorkspace([repo('private'), repo('unavailable', 'modules', 'read_only')], 'token', 'feature');
    try {
      expect(ws.repos).toHaveLength(1);
      await access(join(ws.repos[0].dir, 'source'));
    } finally { await ws.cleanup(); }
  });
  it('fails closed if a required preview reference no longer matches its recorded SHA', async () => {
    await expect(makeMultiWorkspace([{...repo('private','modules','read_only'),checkoutRef:'staging/helf-preview/'+'a'.repeat(40)}], 'token','feature')).rejects.toThrow('HELF preview reference changed');
  });
  it('rejects traversal before cloning writable repositories', async () => {
    await expect(makeMultiWorkspace([repo('..')], 'token', 'feature')).rejects.toThrow('unsafe repo identity');
  });
});
