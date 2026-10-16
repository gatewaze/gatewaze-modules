/**
 * Guards for linuxfoundation/lfx-self-serve#3762.
 *
 * The platform's Vite plugin statically imports every module's
 * `admin/index.*` into the admin boot bundle, and an eager
 * `import.meta.glob` in the manifest does the same. Either one pulls
 * aiPlugin → AiSidebarPane → @puckeditor/core (about 1.3 MB raw) into the
 * boot graph of every admin page. The plugin must stay reachable only
 * through the lazy `admin/plugin.ts` entry that canvas hosts import on
 * demand.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The real plugin pulls in React and Puck; a sentinel is enough to prove
// admin/plugin.ts re-exports it.
const sentinelPlugin = { name: 'sentinel' };
vi.mock('../admin/components/aiPlugin.js', () => ({ aiPlugin: sentinelPlugin }));

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('editor-ai-copilot stays out of the admin boot bundle', () => {
  it('ships no admin/index entry for the platform to boot-import', () => {
    for (const name of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
      expect(existsSync(resolve(moduleRoot, 'admin', name)), `admin/${name}`).toBe(false);
    }
  });

  it('does not import admin code from the module manifest', () => {
    const manifest = readFileSync(resolve(moduleRoot, 'index.ts'), 'utf8');
    // Code lines only: drop whole-line comments so the explanatory note
    // can name the APIs it warns against.
    const code = manifest
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bimport\.meta\b/);
    expect(code).not.toMatch(/\.glob\s*\(/);
    expect(code).not.toMatch(/^\s*import\s+(?!type\b)[^;]*['"]\.\/admin\//m);
  });

  it('exposes the plugin, and only the plugin, from the lazy admin/plugin entry', async () => {
    const mod = await import('../admin/plugin.js');
    expect(mod.aiPlugin).toBe(sentinelPlugin);
    expect(Object.keys(mod)).toEqual(['aiPlugin']);
  });
});
