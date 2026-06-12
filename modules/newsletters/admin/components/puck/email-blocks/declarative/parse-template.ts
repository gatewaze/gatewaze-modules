/**
 * Parser for the html-ish declarative block format.
 *
 * A block lives in the template git repo as a small HTML-like file: a SCHEMA
 * comment (the editable fields) followed by an element tree of allowlisted
 * react-email tags with `{{field}}` bindings and `if` / `each` control-flow
 * attributes. This parser turns that source into a serialisable node tree —
 * it is NEVER executed, just walked by the renderer — so there is no
 * code-execution surface (unlike compiling JSX from git).
 *
 *   <!-- SCHEMA: { "title": {"type":"text"}, "body": {"type":"richtext"} } -->
 *   <Section class="card">
 *     <Text class="eyebrow">HOT TAKE</Text>
 *     <Heading if="title">{{title}}</Heading>
 *     <RichText field="body" class="body" />
 *   </Section>
 */

export type TemplateNode =
  | { kind: 'element'; tag: string; attrs: Record<string, string>; children: TemplateNode[] }
  | { kind: 'text'; value: string };

export interface ParsedTemplate {
  /** JSON-Schema-ish field map from the SCHEMA comment (null if absent). */
  schema: Record<string, unknown> | null;
  /** The element tree (top-level nodes). */
  nodes: TemplateNode[];
}

const SCHEMA_RE = /<!--\s*SCHEMA:\s*([\s\S]*?)-->/i;

/** Parse a declarative block source into { schema, nodes }. */
export function parseTemplate(source: string): ParsedTemplate {
  let schema: Record<string, unknown> | null = null;
  let body = source;

  const schemaMatch = source.match(SCHEMA_RE);
  if (schemaMatch) {
    try {
      const parsed = JSON.parse(schemaMatch[1].trim());
      if (parsed && typeof parsed === 'object') schema = parsed as Record<string, unknown>;
    } catch {
      // Invalid SCHEMA JSON — treat as no schema; the renderer still works
      // with whatever bindings appear in the tree.
    }
    body = source.replace(schemaMatch[0], '');
  }

  if (typeof DOMParser === 'undefined') {
    throw new Error('parseTemplate requires DOMParser (browser or jsdom)');
  }

  // The HTML parser doesn't honour JSX-style self-closing (`<RichText/>`) for
  // non-void custom tags — it would treat them as open and swallow following
  // siblings as children. Expand `<Tag .../>` to `<Tag ...></Tag>` first.
  // (Void HTML elements like <img/> still parse correctly: the parser
  // auto-closes them and ignores the redundant close tag.)
  body = body.replace(/<([A-Za-z][\w-]*)\b([^>]*?)\/>/g, '<$1$2></$1>');

  // Wrap in a sentinel root so top-level siblings are preserved and we avoid
  // the html/head/body auto-wrapping. Custom tags (Section/Row/…) parse as
  // generic elements — no HTML table auto-correction interferes.
  const doc = new DOMParser().parseFromString(`<div id="__gw_root">${body}</div>`, 'text/html');
  const root = doc.getElementById('__gw_root');
  const nodes = root ? collect(root.childNodes) : [];
  return { schema, nodes };
}

function collect(list: NodeListOf<ChildNode> | ChildNode[]): TemplateNode[] {
  const out: TemplateNode[] = [];
  for (const n of Array.from(list)) {
    const node = domToNode(n);
    if (node) out.push(node);
  }
  return out;
}

function domToNode(n: ChildNode): TemplateNode | null {
  // Text node
  if (n.nodeType === 3) {
    const value = n.textContent ?? '';
    // Drop pure-whitespace text that carries no binding (formatting noise).
    if (value.trim() === '' && !value.includes('{{')) return null;
    return { kind: 'text', value };
  }
  // Element node
  if (n.nodeType === 1) {
    const el = n as Element;
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    return {
      kind: 'element',
      tag: el.tagName.toLowerCase(),
      attrs,
      children: collect(el.childNodes),
    };
  }
  // Comments, etc. — ignore.
  return null;
}
