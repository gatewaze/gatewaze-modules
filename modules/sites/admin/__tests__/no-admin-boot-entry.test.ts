// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Guard for linuxfoundation/lfx-self-serve#3762.
 *
 * The platform's Vite plugin statically imports every module's
 * `admin/index.*` into the admin boot bundle. A sites barrel there pulled
 * PageEditor → CanvasEditor → PuckCanvasEditor → @puckeditor/core plus the
 * rich-text editor (about 2 MB raw together) into the boot graph of every
 * admin page whenever sites was in the build. Consumers import the deep
 * entries instead (`@gatewaze-modules/sites/admin/page-editor`,
 * `…/admin/schema-editor`, `…/admin/components/...`).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const adminDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('sites admin boot entry', () => {
  it('ships no admin/index entry for the platform to boot-import', () => {
    for (const name of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
      expect(existsSync(resolve(adminDir, name)), `admin/${name}`).toBe(false);
    }
  });

  it('keeps the deep entries that replace the barrel', () => {
    expect(existsSync(resolve(adminDir, 'page-editor', 'index.ts'))).toBe(true);
    expect(existsSync(resolve(adminDir, 'schema-editor', 'index.ts'))).toBe(true);
  });
});
