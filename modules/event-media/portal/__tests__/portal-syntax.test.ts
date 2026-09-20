// @ts-nocheck — vitest harness.

/**
 * Parse every portal page and component.
 *
 * This exists because of a live incident on 2026-09-20: an edit left an
 * orphaned `</Row>` in DisplayView.tsx, and NOTHING caught it. The
 * module's tsconfig only includes `lib/**` and `api/**`, so portal
 * `.tsx` files are never typechecked; the unit tests do not import
 * them; CodeQL, gitleaks and the auth check do not parse JSX. The first
 * thing that noticed was the portal itself, which builds module pages
 * at pod startup — so a syntax error does not fail CI, it
 * CrashLoopBackOffs the portal, and one bad page takes the whole portal
 * down with it.
 *
 * Parse-only on purpose. The files carry `@ts-nocheck` and import
 * through webpack aliases that do not resolve here, so full type
 * checking is not available — but a syntax error is exactly the class
 * of fault that reaches production this way, and parsing catches it in
 * milliseconds.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const PORTAL = join(__dirname, '..');

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = tsxFiles(PORTAL);

describe('portal sources parse', () => {
  it('finds the portal pages to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(PORTAL.length + 1);
    it(`parses ${rel}`, () => {
      const source = readFileSync(file, 'utf8');
      const out = ts.transpileModule(source, {
        reportDiagnostics: true,
        fileName: file,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
      });
      const syntactic = (out.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      const messages = syntactic.map((d) => {
        const at = d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start)
          : null;
        const where = at ? `:${at.line + 1}:${at.character + 1}` : '';
        return `${rel}${where} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      });
      expect(messages).toEqual([]);
    });
  }
});
