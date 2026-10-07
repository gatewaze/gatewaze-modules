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

/**
 * React requires hooks to run in the same order on every render, so a
 * hook placed after an early return runs on some renders and not
 * others. That is React error #310, and in a portal page it takes the
 * whole display out.
 *
 * Live incident 2026-09-21: an effect added below `if (!mounted)
 * return null` in DisplayView crashed the projector. Typecheck and the
 * parse gate both passed — the code is perfectly valid, it just breaks
 * at runtime.
 */
describe('hooks run before any early return', () => {
  const HOOK = /^\s*(?:const\s+\w+\s*=\s*)?use(?:Effect|LayoutEffect|Callback|Memo|State|Ref)\s*\(/;
  // A bare `return` or `return null/undefined/<jsx>` at component
  // indentation, i.e. not inside a nested function or a hook body.
  const EARLY_RETURN = /^ {2}(?:if \(.*\) )?return(?: null| undefined)?\s*$/;

  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const rel = file.slice(PORTAL.length + 1);
    it(`has no hook after an early return in ${rel}`, () => {
      const lines = readFileSync(file, 'utf8').split('\n');
      let firstReturn = -1;
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (firstReturn === -1 && EARLY_RETURN.test(line)) firstReturn = i;
        if (firstReturn !== -1 && HOOK.test(line)) {
          offenders.push(`${rel}:${i + 1} after early return at line ${firstReturn + 1}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * A hook's dependency array is evaluated DURING RENDER, at the line the
 * hook is written on. Naming a `const` declared further down the
 * component throws a ReferenceError (the temporal dead zone) before
 * anything paints, and in a portal page that takes the whole display
 * out.
 *
 * Typecheck cannot see it, the parse gate cannot see it, and the
 * hook-order gate above cannot see it — the code is valid and the hooks
 * are in a fixed order. It has reached production in this repo before,
 * and on 2026-09-21 an innocent-looking fix to a preload effect would
 * have done it again by naming displaySrc from 110 lines above its
 * declaration.
 */
describe('hook dependencies are declared before the hook', () => {
  const DEPS = /\}\s*,\s*\[([^\]]*)\]\s*\)/;
  const DECL = /^\s*const\s+(?:\[([^\]]+)\]|\{([^}]+)\}|([A-Za-z_$][\w$]*))\s*=/;

  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const rel = file.slice(PORTAL.length + 1);
    it(`names nothing from below itself in ${rel}`, () => {
      const lines = readFileSync(file, 'utf8').split('\n');
      // First line each name is declared on. Taking the FIRST keeps this
      // conservative: a name declared anywhere above passes.
      const firstDecl = new Map<string, number>();
      lines.forEach((line, i) => {
        const m = DECL.exec(line);
        if (!m) return;
        const names = (m[1] ?? m[2] ?? m[3] ?? '')
          .split(',')
          .map((n) => n.split(':').pop()!.split('=')[0]!.trim())
          .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
        for (const n of names) if (!firstDecl.has(n)) firstDecl.set(n, i);
      });

      const offenders: string[] = [];
      lines.forEach((line, i) => {
        const m = DEPS.exec(line);
        if (!m) return;
        for (const raw of m[1]!.split(',')) {
          const name = raw.trim().split(/[.?[\s]/)[0]!;
          const at = firstDecl.get(name);
          if (at !== undefined && at > i) {
            offenders.push(`${rel}:${i + 1} depends on "${name}", declared at line ${at + 1}`);
          }
        }
      });
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * Every component a page renders has to actually exist somewhere.
 *
 * Live incident 2026-09-29: AlbumGallery rendered `<XrayIcon />`, which
 * was never written. `<SparkIcon>`, `<LinkIcon>` and `<TickIcon>` beside
 * it all were, so the file read as finished. The parse gate passed (the
 * JSX is well-formed), both hook gates passed, and the module's tsconfig
 * covers only `lib/**` and `api/**`, so no typechecker ever looked at
 * the file. It reached production, where the button is only rendered for
 * an album with x-ray on — so four of the five albums worked and the
 * photo booth threw `ReferenceError: XrayIcon is not defined` into the
 * portal's error boundary.
 *
 * Deliberately crude: it asks only whether the name is bound ANYWHERE in
 * the file, at any scope, or imported. That cannot catch a name used out
 * of scope, but it does catch a name that does not exist — which is the
 * fault that ships.
 */
describe('every component rendered is defined', () => {
  // Bound by the runtime or by the JSX transform, not by a declaration.
  const AMBIENT = new Set(['React', 'Fragment']);

  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const rel = file.slice(PORTAL.length + 1);
    it(`renders nothing undefined in ${rel}`, () => {
      const source = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

      const bound = new Set<string>(AMBIENT);
      const rendered: Array<{ name: string; line: number }> = [];

      const walk = (node: ts.Node): void => {
        // Anything that introduces a name, at any scope. A plain
        // identifier binding is all we need; a destructuring pattern
        // binds through BindingElements, which this visits in turn.
        if (
          (ts.isVariableDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isImportClause(node) ||
            ts.isImportSpecifier(node) ||
            ts.isNamespaceImport(node) ||
            ts.isBindingElement(node)) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          bound.add(node.name.text);
        }

        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          // `Foo.Bar` only needs `Foo`; a lowercase tag is an HTML element.
          let tag: ts.Node = node.tagName;
          while (ts.isPropertyAccessExpression(tag)) tag = tag.expression;
          if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
            const at = sf.getLineAndCharacterOfPosition(tag.getStart(sf));
            rendered.push({ name: tag.text, line: at.line + 1 });
          }
        }

        ts.forEachChild(node, walk);
      };
      walk(sf);

      const offenders = rendered
        .filter((r) => !bound.has(r.name))
        .map((r) => `${rel}:${r.line} renders <${r.name}>, which is never defined or imported`);
      expect(offenders).toEqual([]);
    });
  }
});
