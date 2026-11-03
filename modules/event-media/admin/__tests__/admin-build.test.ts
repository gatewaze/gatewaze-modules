// @ts-nocheck — vitest harness.

/**
 * Would the admin build succeed with these files?
 *
 * Module admin pages are compiled when the admin container STARTS, not in
 * CI: the container clones module main and runs a Vite build. Admin .tsx
 * is outside this module's tsconfig and imports through aliases, so
 * nothing here typechecks it, and a mistake surfaces as a failed admin
 * build on restart.
 *
 * Vite does not typecheck -- esbuild strips types -- so a type error does
 * not fail that build. What does fail it is narrower, and checkable:
 *
 *   1. a syntax error
 *   2. a relative import whose file does not exist
 *   3. a named import the target file does not export
 *
 * This checks all three for every admin file. Aliased (`@/...`) and
 * package imports belong to the platform and cannot be resolved here.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const ADMIN = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(tsx?)$/.test(e)) out.push(f);
  }
  return out;
}
const files = walk(ADMIN);

/** Resolve a relative specifier the way Vite would, `.js` included. */
function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.(js|jsx|ts|tsx)$/, '');
  const tries = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return tries.find((t) => existsSync(t) && statSync(t).isFile()) ?? null;
}

/** Does `src` export `name`? True when it cannot tell (export *), so this never cries wolf. */
function exportsName(src: string, name: string): boolean {
  if (/export\s+\*\s+from/.test(src)) return true;
  if (name === 'default') return /export\s+default\b/.test(src);
  const decl = new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b`);
  const list = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`);
  return decl.test(src) || list.test(src);
}

const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

describe('admin files would build', () => {
  it('finds admin files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(ADMIN.length + 1);
    const src = readFileSync(file, 'utf8');

    it(`parses ${rel}`, () => {
      const out = ts.transpileModule(src, {
        reportDiagnostics: true, fileName: file,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      });
      const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
      expect(errs).toEqual([]);
    });

    it(`resolves its relative imports in ${rel}`, () => {
      const problems: string[] = [];
      for (const m of src.matchAll(IMPORT)) {
        const [, typeOnly, clause, spec] = m;
        if (!spec.startsWith('.')) continue;
        const target = resolveImport(file, spec);
        if (!target) { problems.push(`cannot find "${spec}"`); continue; }
        if (typeOnly) continue; // erased at build time
        const tsrc = readFileSync(target, 'utf8');
        const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
        for (const raw of named.split(',')) {
          const part = raw.trim();
          if (!part || part.startsWith('type ')) continue; // inline type import, erased
          const name = part.split(/\s+as\s+/)[0].trim();
          if (!exportsName(tsrc, name)) problems.push(`"${spec}" does not export ${name}`);
        }
        const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
        if (def && !def.startsWith('*') && !exportsName(tsrc, 'default')) problems.push(`"${spec}" has no default export`);
      }
      expect(problems).toEqual([]);
    });
  }
});

/**
 * Every component an admin page renders has to exist somewhere.
 *
 * The same gate the portal carries, for the same reason. On 2026-09-29
 * AlbumGallery rendered `<XrayIcon />`, which was never written: the JSX
 * was well-formed so nothing caught it, and it reached production, where
 * it threw `ReferenceError: XrayIcon is not defined` into the error
 * boundary for the one album that rendered that button.
 *
 * Admin is the same blind spot -- outside this module's tsconfig, built
 * at container start -- and worse in one way: Vite does not typecheck, so
 * an undefined name is not a build failure here, it is a blank Media tab
 * for whoever opens it.
 *
 * Deliberately scope-blind: it asks only whether the name is bound
 * ANYWHERE in the file or imported. That misses a name used out of scope
 * and catches a name that does not exist, which is the one that ships.
 */
describe('every component rendered is defined', () => {
  const AMBIENT = new Set(['React', 'Fragment']);

  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const rel = file.slice(ADMIN.length + 1);
    it(`renders nothing undefined in ${rel}`, () => {
      const sf = ts.createSourceFile(
        file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX,
      );
      const bound = new Set<string>(AMBIENT);
      const rendered: Array<{ name: string; line: number }> = [];

      const walkNode = (node: ts.Node): void => {
        if (
          (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
            || ts.isClassDeclaration(node) || ts.isParameter(node)
            || ts.isImportClause(node) || ts.isImportSpecifier(node)
            || ts.isNamespaceImport(node) || ts.isBindingElement(node))
          && node.name && ts.isIdentifier(node.name)
        ) {
          bound.add(node.name.text);
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          let tag: ts.Node = node.tagName;
          while (ts.isPropertyAccessExpression(tag)) tag = tag.expression;
          if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
            rendered.push({
              name: tag.text,
              line: sf.getLineAndCharacterOfPosition(tag.getStart(sf)).line + 1,
            });
          }
        }
        ts.forEachChild(node, walkNode);
      };
      walkNode(sf);

      const offenders = rendered
        .filter((r) => !bound.has(r.name))
        .map((r) => `${rel}:${r.line} renders <${r.name}>, which is never defined or imported`);
      expect(offenders).toEqual([]);
    });
  }
});
