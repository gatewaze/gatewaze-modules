/**
 * Renderer for the declarative block format. Walks a parsed TemplateNode tree
 * and the block's field values, emitting react-email components from the
 * allowlist. Pure interpretation — nothing from the template is executed.
 *
 * Supported per element:
 *   - `{{field}}` bindings in text and attributes (React escapes text/props).
 *   - `if="field"`    — render only when the field is truthy (non-empty).
 *   - `each="array"`  — repeat the element per array item; item fields become
 *                       bindings inside (e.g. <Text each="links">{{title}}</Text>).
 *   - <richtext field="x" /> (or <richtext>{{x}}</richtext>) — raw rich-text
 *                       HTML via the shared RichText component.
 *   - <slot name="x" /> — placeholder for nested content/bricks (rendered by
 *                       the caller via `slots[name]`).
 */

import { Fragment, createElement, isValidElement, type CSSProperties, type ReactNode } from 'react';
import type { TemplateNode } from './parse-template.js';
import { TAG_COMPONENTS, INTRINSIC_TAGS, classStyle, parseInlineStyle, PASSTHROUGH_ATTRS } from './component-map.js';
import { RichText } from '../blocks/_richtext.js';
import { renderSlot } from '../render-slot.js';

export type Content = Record<string, unknown>;

interface RenderCtx {
  content: Content;
  // True inside the Puck editor canvas (forwarded by the merge layer), false
  // at publish. Lets `if`-guarded inline-editable fields stay visible so an
  // empty field can still be clicked and filled in the editor.
  editMode: boolean;
  // Field keys that are edited inline (text / textarea / richtext). An empty
  // one of these is kept visible in edit mode despite an `if` guard.
  editableFields: Set<string>;
}

/**
 * Per-node style cache. Parsed nodes are stable for a block's lifetime, so the
 * merged class+inline style for each one is computed once and reused. This
 * keeps the `style` prop a STABLE reference across re-renders — matching the
 * hand-coded blocks (which pass module-constant style objects). Without it,
 * every keystroke handed React a fresh style object on the `<div>` that hosts
 * Puck's inline rich-text editor, remounting the editor and dropping focus
 * after one character.
 */
type ElementNode = Extract<TemplateNode, { kind: 'element' }>;
const styleCache = new WeakMap<ElementNode, CSSProperties>();

function nodeStyle(node: ElementNode): CSSProperties {
  const cached = styleCache.get(node);
  if (cached) return cached;
  const style = { ...classStyle(node.attrs['class']), ...parseInlineStyle(node.attrs['style']) };
  styleCache.set(node, style);
  return style;
}

function getPath(obj: Content, path: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[seg];
    return undefined;
  }, obj);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return !!v;
}

function resolveBindings(text: string, content: Content): string {
  return text.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, key: string) => {
    const v = getPath(content, key);
    return v == null ? '' : String(v);
  });
}

/**
 * Defence-in-depth URL encoder for `src` and `href` attribute values.
 *
 * Upload-time sanitisation (host-media's sanitiseFilename) is the primary
 * guard, but legacy uploads, manual DB edits, and AI-generated content can
 * still produce URLs containing literal spaces / non-ASCII bytes. Browsers
 * auto-encode these in a URL; mail clients (Gmail) refuse to load them.
 *
 * We use `encodeURI` semantics so URL structure (`/`, `:`, `?`, `&`, `#`)
 * is preserved while spaces and other unsafe path bytes get %-encoded.
 * If the value already contains `%XX` sequences we leave it alone to avoid
 * double-encoding (the `%` would otherwise become `%25`).
 */
function safeUrlEncode(s: string): string {
  if (!s) return s;
  if (/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try { return encodeURI(s); } catch { return s; }
}

const URL_ATTRS = new Set(['src', 'href']);

/**
 * Small allowlist of inline-formatting tags the `html` attribute permits inside
 * single-line text fields. Lets admins use `<s>strike</s>`, `<em>`, `<strong>`
 * etc. in a title without enabling block elements or anything scriptable.
 *
 * Strike variants (`strike`, `del`, `ins`) are aliased so admins can use the
 * tag their muscle memory gives them — HTML4 `<strike>`, HTML5 `<del>`/`<ins>`,
 * or the canonical `<s>`. The user-facing rendering is the same.
 *
 * Voids (no closing tag): br. All other tags expect a matching close.
 */
const INLINE_HTML_TAGS = new Set([
  's', 'strike', 'del', 'ins', 'em', 'strong', 'u', 'b', 'i', 'span', 'mark', 'sub', 'sup', 'code', 'small', 'br',
]);

/**
 * Strip every tag NOT in INLINE_HTML_TAGS, and strip ALL attributes from the
 * tags that are kept. Entity-encoded sequences (`&lt;`, `&#60;`) pass through
 * untouched — innerHTML will decode them as literal text, NOT as live HTML, so
 * `&lt;script&gt;` is safe even though `<script>` would not be.
 *
 * This is deliberately ham-fisted: admins are trusted, but a bad paste from
 * a richtext editor shouldn't be able to slip a `<script>` or `<img onerror>`
 * into the sent email. The richtext field type still owns the multi-line
 * formatting path; this is only for inline accents in single-line strings.
 */
/**
 * Walk a value down to its text content — used by the `html` attribute path
 * to recover the underlying string when Puck has wrapped the field value in
 * an inline contentEditable React node. Without this the canvas preview
 * for an `html`-attribute field renders the literal `<strike>...</strike>`
 * characters (because Puck's contentEditable shows its raw children) instead
 * of the formatted strike output the operator expects.
 *
 * Recursion is shallow on purpose: Puck's contentEditable wrappers nest
 * once or twice, but extractTextFromNode walks the whole props.children
 * tree to be safe across plugin variants.
 */
function extractTextFromNode(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractTextFromNode).join('');
  if (isValidElement(value)) {
    const props = (value as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) return extractTextFromNode(props.children);
    return '';
  }
  return '';
}

function sanitiseInlineHtml(html: string): string {
  if (!html) return html;
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>/g, (_match, rawTag) => {
    const tag = String(rawTag).toLowerCase();
    if (!INLINE_HTML_TAGS.has(tag)) return '';
    if (tag === 'br') return '<br/>';
    const isClosing = _match.startsWith('</');
    return isClosing ? `</${tag}>` : `<${tag}>`;
  });
}

function mergeItem(content: Content, item: unknown): Content {
  if (item && typeof item === 'object') return { ...content, ...(item as Content), $item: item };
  return { ...content, $item: item };
}

function renderNode(node: TemplateNode, ctx: RenderCtx, key: string): ReactNode {
  if (node.kind === 'text') {
    // Split the text into literal + `{{binding}}` segments. A binding can
    // resolve to a React *node* — in the editor canvas Puck swaps a
    // `contentEditable` field's string for a live inline-editor node — and that
    // node must be emitted as-is. String()-ing it prints "[object Object]"
    // (which is what broke e.g. the sponsored_ad eyebrow "PRESENTED BY
    // {{sponsor_name}}"). This handles both whole-value bindings
    // (<Heading>{{title}}</Heading>) and literal+binding mixes.
    const re = /\{\{\s*([\w.$]+)\s*\}\}/g;
    const parts: ReactNode[] = [];
    let last = 0, hasNode = false, m: RegExpExecArray | null;
    while ((m = re.exec(node.value)) !== null) {
      if (m.index > last) parts.push(node.value.slice(last, m.index));
      const v = getPath(ctx.content, m[1]);
      if (isValidElement(v)) { parts.push(v); hasNode = true; }
      else parts.push(v == null ? '' : String(v));
      last = re.lastIndex;
    }
    if (last < node.value.length) parts.push(node.value.slice(last));
    if (!hasNode) {
      const out = parts.join('');
      return out === '' ? null : out;
    }
    return <Fragment key={key}>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</Fragment>;
  }

  const { tag, attrs, children } = node;

  // Conditional. `if` is a publish-time guard — it hides empty optional
  // content in the sent email. In the editor we keep an empty *inline-editable*
  // field visible so the operator can click in and fill it (otherwise an empty
  // <Heading if="title"> has nothing to click). Structural guards (arrays,
  // slots) still collapse when empty so the canvas isn't cluttered.
  if (attrs['if'] !== undefined && !truthy(getPath(ctx.content, attrs['if']))) {
    if (!(ctx.editMode && ctx.editableFields.has(attrs['if']))) return null;
  }

  // Loop — repeat this element (minus `each`) per array item.
  if (attrs['each'] !== undefined) {
    const arr = getPath(ctx.content, attrs['each']);
    if (!Array.isArray(arr)) return null;
    const { each: _drop, ...restAttrs } = attrs;
    return (
      <Fragment key={key}>
        {arr.map((item, i) =>
          renderNode({ kind: 'element', tag, attrs: restAttrs, children }, { ...ctx, content: mergeItem(ctx.content, item) }, `${key}-${i}`),
        )}
      </Fragment>
    );
  }

  // <slot name="x" /> — render the slot field's value (the bricks). Defaults
  // to the `children` field (the convention entryHasSlot looks for). Uses
  // renderSlot so it works for both the live Puck DropZone and the export tree.
  //
  // Optional `<separator>` child element renders BETWEEN slot items (not
  // before the first, not after the last). Lets the parent template
  // emit a divider/spacer between bricks without each brick having to
  // know it isn't the first — the CSS `.brick + .brick` selector approach
  // gets stripped by Gmail's email-cleanup, so an inline-rendered
  // separator is the email-safe alternative.
  //
  //   <slot name="children">
  //     <separator><Hr style="border-top:1px solid #bbb;margin:16px 0" /></separator>
  //   </slot>
  //
  // Only takes effect when the slot resolves to an ARRAY of items (the
  // common publish-time + tree-walker case). When Puck hands a live
  // SlotComponent function (canvas), the separator is a no-op — Puck
  // owns the DropZone rendering and we can't intersperse from outside.
  // Acceptable: operators see the dividers in the published send and the
  // test send (both array path); canvas preview shows none.
  if (tag === 'slot') {
    const name = attrs['name'] ?? 'children';
    const slotValue = ctx.content[name];
    const separatorNode = children.find(
      (c) => c.kind === 'element' && c.tag === 'separator',
    ) as Extract<TemplateNode, { kind: 'element' }> | undefined;
    if (separatorNode && Array.isArray(slotValue) && slotValue.length > 1) {
      const renderedItems = renderSlot(slotValue);
      if (Array.isArray(renderedItems)) {
        const sep = (
          <Fragment>
            {separatorNode.children.map((c, i) =>
              renderNode(c, ctx, `${key}-sep-${i}`),
            )}
          </Fragment>
        );
        const interleaved: ReactNode[] = [];
        renderedItems.forEach((item, i) => {
          if (i > 0) interleaved.push(<Fragment key={`${key}-sep-${i}`}>{sep}</Fragment>);
          interleaved.push(<Fragment key={`${key}-item-${i}`}>{item as ReactNode}</Fragment>);
        });
        return <Fragment key={key}>{interleaved}</Fragment>;
      }
    }
    return <Fragment key={key}>{renderSlot(slotValue)}</Fragment>;
  }

  // <richtext field="x" class="y" /> or <richtext>{{x}}</richtext>
  if (tag === 'richtext') {
    const field = attrs['field'] ?? bindingKeyFromChildren(children);
    const value = field ? getPath(ctx.content, field) : undefined;
    return <RichText key={key} value={value} style={nodeStyle(node)} />;
  }

  const Comp = TAG_COMPONENTS[tag];
  const isIntrinsic = !Comp && INTRINSIC_TAGS.has(tag);
  if (!Comp && !isIntrinsic) {
    // Not allowlisted — drop the element but keep its (possibly bound) children
    // so authors can use a bare wrapper without breaking content.
    return <Fragment key={key}>{children.map((c, i) => renderNode(c, ctx, `${key}-${i}`))}</Fragment>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props: Record<string, any> = { style: nodeStyle(node), key };
  for (const a of PASSTHROUGH_ATTRS) {
    if (attrs[a] !== undefined) {
      const resolved = resolveBindings(attrs[a], ctx.content);
      props[a] = URL_ATTRS.has(a) ? safeUrlEncode(resolved) : resolved;
    }
  }

  // `html` attribute — render the bound text as sanitised HTML so admins can
  // use inline accents (`<s>`, `<em>`, `<strong>`, `<u>`, …) inside single-line
  // text fields without us promoting them to richtext. The field type stays
  // `text` (single-line input in the editor); only the renderer switches from
  // text children to dangerouslySetInnerHTML when the directive opts in.
  //
  //   <Heading if="title" html>{{title}}</Heading>
  //
  // The bound value is run through sanitiseInlineHtml — a tag allowlist that
  // drops everything outside INLINE_HTML_TAGS and ALL attributes. So a paste
  // of `<img onerror=...>` or `<script>...</script>` lands as empty text, not
  // executable HTML. Use only on text fields; richtext fields already have
  // their own (multi-line) path via <richtext field="...">.
  //
  // In the Puck canvas the field value is the inline contentEditable React
  // node, not a string — extractTextFromNode walks down to the underlying
  // text so we can still produce sanitised HTML for the canvas preview.
  // The trade-off: inline-edit on the canvas is disabled for `html` fields
  // (the sidebar input remains the edit surface). Without this the canvas
  // showed the literal "<strike>...</strike>" tags as text instead of the
  // formatted output the operator was expecting.
  if (attrs['html'] !== undefined && attrs['html'] !== 'false') {
    const field = bindingKeyFromChildren(children);
    const value = field ? getPath(ctx.content, field) : undefined;
    const text = extractTextFromNode(value);
    const html = sanitiseInlineHtml(text);
    props.dangerouslySetInnerHTML = { __html: html };
    return isIntrinsic
      ? createElement(tag, props)
      : createElement(Comp, props);
  }

  const kids = children.map((c, i) => renderNode(c, ctx, `${key}-${i}`));
  const childrenOrNone = kids.length > 0 ? kids : undefined;
  // Intrinsic HTML tag (div/span/strong/…) vs allowlisted react-email component.
  return isIntrinsic
    ? createElement(tag, props, childrenOrNone)
    : createElement(Comp, props, childrenOrNone);
}

/** Extract `field` from a single `{{field}}` text child (richtext shorthand). */
function bindingKeyFromChildren(children: TemplateNode[]): string | undefined {
  for (const c of children) {
    if (c.kind === 'text') {
      const m = c.value.match(/\{\{\s*([\w.$]+)\s*\}\}/);
      if (m) return m[1];
    }
  }
  return undefined;
}

const EMPTY_FIELDS: Set<string> = new Set();

export function DeclarativeBlock({
  nodes,
  content,
  editableFields = EMPTY_FIELDS,
}: {
  nodes: TemplateNode[];
  content: Content;
  editableFields?: Set<string>;
}): ReactNode {
  const ctx: RenderCtx = { content, editMode: content.editMode === true, editableFields };
  return <>{nodes.map((n, i) => renderNode(n, ctx, String(i)))}</>;
}
