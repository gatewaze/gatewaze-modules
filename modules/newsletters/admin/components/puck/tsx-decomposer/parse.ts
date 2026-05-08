/**
 * Decompose a Barebone-style react-email TSX file into a registry
 * block tree (`RegistryTreeEntry[]`) the platform's editor can load.
 *
 * Strategy:
 *   1. Parse the source with @babel/parser (jsx + typescript plugins).
 *   2. Locate the default-exported function component's return JSX.
 *   3. Skip the Tailwind / Html / Head / Body / Preview wrappers
 *      whose responsibilities are already handled by EditionEmail.
 *   4. Walk the meaningful subtree (everything inside Body) and map
 *      each JSX element to a registry componentId, extracting props
 *      from JSX attributes and recursively processing children for
 *      slot containers.
 *
 * Where the source uses something we can't decompose (helper
 * components defined in the same file, dynamic expressions like
 * `{title}` interpolations, conditional renders, Tailwind utility
 * classes) the decomposer emits a *best-effort* mapping plus a
 * warning so the operator can clean up after import.
 *
 * The output trees are NOT a 1:1 visual reproduction of the original
 * react-email rendering — Barebone's Tailwind classes use CSS
 * variables and a custom font scale that we can't carry through to
 * inline styles cleanly. The trees ARE structurally faithful (same
 * sequence of sections, same headings, same image src URLs) so the
 * operator gets a usable starting point that they then re-style via
 * the registry components' field editors.
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export interface RegistryTreeEntry {
  type: string;
  props: Record<string, unknown>;
}

export interface DecomposeResult {
  /** The ordered list of top-level registry blocks the operator can apply. */
  blocks: RegistryTreeEntry[];
  /** Per-element warnings emitted during the walk. */
  warnings: string[];
}

const SKIP_WRAPPER_NAMES = new Set([
  'Tailwind',
  'Html',
  'Head',
  'BarebonesFonts',
  'Body',
  'Preview',
  'Fragment',
]);

interface MapEntry {
  componentId: string;
  /** Optional per-element prop extractor — given the JSX element, returns the registry props. */
  propsFromElement?: (el: t.JSXElement, walk: WalkFn) => Record<string, unknown>;
}

type WalkFn = (children: ReadonlyArray<t.JSXElement | t.JSXText | t.JSXExpressionContainer | t.JSXFragment | t.JSXSpreadChild>) => RegistryTreeEntry[];

const ELEMENT_MAP: Record<string, MapEntry> = {
  Container: {
    componentId: 'container',
    propsFromElement: (el, walk) => ({
      maxWidth: '600',
      padding: '24px',
      background: 'transparent',
      children: walk(el.children),
    }),
  },
  Section: {
    componentId: 'section',
    propsFromElement: (el, walk) => ({
      padding: pickStyleString(el, 'padding') ?? '20px 40px',
      background: pickStyleString(el, 'backgroundColor') ?? 'transparent',
      align: pickStyleString(el, 'textAlign') as 'left' | 'center' | 'right' | undefined ?? 'left',
      rounded: pickStyleString(el, 'borderRadius') ?? '0',
      children: walk(el.children),
    }),
  },
  Row: {
    componentId: 'row',
    propsFromElement: (el, walk) => ({ children: walk(el.children) }),
  },
  Column: {
    componentId: 'column',
    propsFromElement: (el, walk) => ({
      width: pickStyleString(el, 'width') ?? '100%',
      verticalAlign: pickStyleString(el, 'verticalAlign') as 'top' | 'middle' | 'bottom' | undefined ?? 'top',
      padding: pickStyleString(el, 'padding') ?? '0',
      children: walk(el.children),
    }),
  },
  Heading: {
    componentId: 'heading',
    propsFromElement: (el) => ({
      text: extractTextContent(el) || 'Heading',
      level: (pickAttrString(el, 'as') ?? 'h2') as 'h1' | 'h2' | 'h3',
      align: (pickStyleString(el, 'textAlign') ?? 'left') as 'left' | 'center' | 'right',
    }),
  },
  Text: {
    componentId: 'text',
    propsFromElement: (el) => ({
      text: extractTextContent(el),
      align: (pickStyleString(el, 'textAlign') ?? 'left') as 'left' | 'center' | 'right',
    }),
  },
  Button: {
    componentId: 'button',
    propsFromElement: (el) => ({
      button_text: extractTextContent(el) || 'Click me',
      button_url: pickAttrString(el, 'href') ?? '#',
    }),
  },
  Img: {
    componentId: 'img',
    propsFromElement: (el) => {
      const src = pickAttrString(el, 'src');
      return {
        src: src ?? '',
        alt: pickAttrString(el, 'alt') ?? '',
        width: pickAttrNumber(el, 'width')?.toString() ?? '600',
        align: (pickStyleString(el, 'textAlign') ?? 'center') as 'left' | 'center' | 'right',
      };
    },
  },
  Link: {
    componentId: 'link',
    propsFromElement: (el) => ({
      href: pickAttrString(el, 'href') ?? '#',
      text: extractTextContent(el),
      color: pickStyleString(el, 'color') ?? '#1a1a2e',
      underline: 'underline' as const,
    }),
  },
  Hr: {
    componentId: 'hr',
    propsFromElement: (el) => ({
      color: pickStyleString(el, 'borderTopColor') ?? pickStyleString(el, 'borderColor') ?? '#e0e0e0',
      margin: pickStyleString(el, 'margin') ?? '24px 0',
    }),
  },
};

export function decomposeBareboneTsx(source: string): DecomposeResult {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  });

  let returnJsx: t.JSXElement | t.JSXFragment | null = null;

  traverse(ast, {
    ExportDefaultDeclaration(path) {
      // Either `export default function X() { return <jsx/> }` or
      // `export default Foo` (where Foo is a function declared above).
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) || t.isArrowFunctionExpression(decl) || t.isFunctionExpression(decl)) {
        const jsx = findReturnJsx(decl);
        if (jsx) returnJsx = jsx;
      } else if (t.isIdentifier(decl)) {
        const target = findIdentifierFunction(path, decl.name);
        if (target) {
          const jsx = findReturnJsx(target);
          if (jsx) returnJsx = jsx;
        }
      }
    },
  });

  if (!returnJsx) {
    return { blocks: [], warnings: ['no default-exported function component with returned JSX found'] };
  }

  const warnings: string[] = [];

  const walk: WalkFn = (children) => {
    const out: RegistryTreeEntry[] = [];
    for (const child of children) {
      if (t.isJSXElement(child)) {
        const name = jsxElementName(child);
        if (!name) continue;
        if (SKIP_WRAPPER_NAMES.has(name)) {
          // Recurse INTO the wrapper without emitting a node for it.
          out.push(...walk(child.children));
          continue;
        }
        const entry = ELEMENT_MAP[name];
        if (!entry) {
          warnings.push(`unmapped component: ${name} — emitting Section placeholder`);
          out.push({
            type: 'section',
            props: {
              padding: '20px',
              background: '#F9FAFB',
              align: 'left',
              rounded: '8',
              children: walk(child.children),
            },
          });
          continue;
        }
        const props = entry.propsFromElement ? entry.propsFromElement(child, walk) : {};
        out.push({ type: entry.componentId, props });
      } else if (t.isJSXFragment(child)) {
        out.push(...walk(child.children));
      } else if (t.isJSXExpressionContainer(child)) {
        // Conditional like `{x ? <foo/> : null}` or a helper-call JSX
        // expression. Try to dig out a JSXElement from inside.
        const inner = unwrapJsxFromExpression(child.expression);
        if (inner) {
          out.push(...walk([inner]));
        } else {
          warnings.push('skipped a JSX expression we couldn\'t resolve to an element');
        }
      }
      // Plain JSXText (whitespace, etc.) → ignored.
    }
    return out;
  };

  const top: t.JSXElement | null = t.isJSXElement(returnJsx) ? (returnJsx as t.JSXElement) : null;
  const blocks: RegistryTreeEntry[] = top ? walk([top]) : (returnJsx ? walk((returnJsx as t.JSXFragment).children) : []);

  // The Barebone templates wrap their meaningful content in
  // `<Tailwind><Html><Body><Container><Section>…`. After
  // SKIP_WRAPPER_NAMES drops Tailwind/Html/Body/Preview, we usually
  // end up with one Container wrapping the real top-level Sections.
  // Unwrap that Container so the editor sees the Sections as
  // first-class top-level blocks (the platform supplies its own
  // outer Container in EditionEmail).
  const unwrapped = blocks.length === 1 && blocks[0]?.type === 'container'
    ? (Array.isArray(blocks[0].props.children) ? blocks[0].props.children as RegistryTreeEntry[] : blocks)
    : blocks;

  return { blocks: unwrapped, warnings };
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function findReturnJsx(node: t.Node): t.JSXElement | t.JSXFragment | null {
  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node) || t.isFunctionDeclaration(node)) {
    const body = node.body;
    if (t.isJSXElement(body) || t.isJSXFragment(body)) return body;
    if (t.isBlockStatement(body)) {
      for (const stmt of body.body) {
        if (t.isReturnStatement(stmt) && stmt.argument) {
          if (t.isJSXElement(stmt.argument) || t.isJSXFragment(stmt.argument)) return stmt.argument;
          // Sometimes wrapped in parens: still a JSXElement at AST level.
        }
      }
    }
  }
  return null;
}

function findIdentifierFunction(path: NodePath, name: string): t.Function | null {
  const binding = path.scope.getBinding(name);
  if (!binding) return null;
  const node = binding.path.node;
  if (t.isVariableDeclarator(node)) {
    if (
      node.init &&
      (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
    ) {
      return node.init as t.Function;
    }
  }
  if (t.isFunctionDeclaration(node)) return node;
  return null;
}

function jsxElementName(el: t.JSXElement): string | null {
  const name = el.openingElement.name;
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    // e.g. `<Foo.Bar/>` — return last segment.
    let cursor: t.JSXMemberExpression | t.JSXIdentifier = name;
    while (t.isJSXMemberExpression(cursor)) cursor = cursor.property as t.JSXIdentifier | t.JSXMemberExpression;
    return t.isJSXIdentifier(cursor) ? cursor.name : null;
  }
  return null;
}

function pickAttrString(el: t.JSXElement, attrName: string): string | null {
  const attr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attrName,
  );
  if (!attr) return null;
  if (!attr.value) return '';
  if (t.isStringLiteral(attr.value)) return attr.value.value;
  if (t.isJSXExpressionContainer(attr.value)) {
    const expr = attr.value.expression;
    if (t.isStringLiteral(expr)) return expr.value;
    if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) {
      return expr.quasis.map((q) => q.value.cooked ?? '').join('');
    }
    // Identifier or member expression — return placeholder so the
    // operator can fill in. (E.g. `{baseUrl + '/img.png'}`.)
    return null;
  }
  return null;
}

function pickAttrNumber(el: t.JSXElement, attrName: string): number | null {
  const s = pickAttrString(el, attrName);
  if (s != null) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // also accept `{600}` JSX expressions
  const attr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attrName,
  );
  if (attr && attr.value && t.isJSXExpressionContainer(attr.value)) {
    const expr = attr.value.expression;
    if (t.isNumericLiteral(expr)) return expr.value;
  }
  return null;
}

/**
 * Read `style={{ key: value }}` and return the string for one key. Best
 * effort — only static string / numeric literal values, not dynamic
 * expressions.
 */
function pickStyleString(el: t.JSXElement, key: string): string | null {
  const attr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'style',
  );
  if (!attr || !attr.value || !t.isJSXExpressionContainer(attr.value)) return null;
  const expr = attr.value.expression;
  if (!t.isObjectExpression(expr)) return null;
  for (const prop of expr.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const k = t.isIdentifier(prop.key) ? prop.key.name : (t.isStringLiteral(prop.key) ? prop.key.value : null);
    if (k !== key) continue;
    const v = prop.value;
    if (t.isStringLiteral(v)) return v.value;
    if (t.isNumericLiteral(v)) return String(v.value);
  }
  return null;
}

/**
 * Pull a usable text representation out of a JSX element's children.
 * Concatenates JSXText, string-literal expressions, and `{var}`
 * placeholders (rendered as `{var}` so the operator can swap them).
 */
function extractTextContent(el: t.JSXElement): string {
  const out: string[] = [];
  for (const child of el.children) {
    if (t.isJSXText(child)) {
      const trimmed = child.value.replace(/\s+/g, ' ').trim();
      if (trimmed) out.push(trimmed);
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;
      if (t.isStringLiteral(expr)) out.push(expr.value);
      else if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) {
        out.push(expr.quasis.map((q) => q.value.cooked ?? '').join(''));
      } else if (t.isIdentifier(expr)) {
        out.push(`{${expr.name}}`);
      } else if (t.isMemberExpression(expr)) {
        // e.g. {props.companyName}
        out.push('{...}');
      }
    } else if (t.isJSXElement(child)) {
      // Inline elements like <strong> or <br/> within a Text — recurse.
      const name = jsxElementName(child);
      if (name === 'br') {
        out.push('\n');
      } else {
        const inner = extractTextContent(child);
        if (inner) out.push(inner);
      }
    }
  }
  return out.join(' ').trim();
}

function unwrapJsxFromExpression(expr: t.Expression): t.JSXElement | null {
  if (t.isJSXElement(expr)) return expr;
  if (t.isConditionalExpression(expr)) {
    if (t.isJSXElement(expr.consequent)) return expr.consequent;
    if (t.isJSXElement(expr.alternate)) return expr.alternate;
  }
  if (t.isLogicalExpression(expr)) {
    // `x && <Foo/>`
    if (t.isJSXElement(expr.right)) return expr.right;
  }
  return null;
}
