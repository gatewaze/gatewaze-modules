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

function mergeItem(content: Content, item: unknown): Content {
  if (item && typeof item === 'object') return { ...content, ...(item as Content), $item: item };
  return { ...content, $item: item };
}

// A text node that is exactly a single `{{field}}` (ignoring surrounding
// whitespace) → the bound field key, else null. Used to detect whole-value
// bindings that may carry a React node rather than a string.
const WHOLE_BINDING_RE = /^\s*\{\{\s*([\w.$]+)\s*\}\}\s*$/;

function renderNode(node: TemplateNode, ctx: RenderCtx, key: string): ReactNode {
  if (node.kind === 'text') {
    // Whole-value binding passthrough. In the editor canvas Puck swaps a
    // `contentEditable` field's string for a live inline-editor *node*; that
    // node must be rendered as-is (String()-ing it emits "[object Object]" and
    // the editor never mounts, so the field can't be clicked). This is what
    // lets text fields — e.g. <Heading>{{title}}</Heading> — be edited inline.
    const whole = node.value.match(WHOLE_BINDING_RE);
    if (whole) {
      const v = getPath(ctx.content, whole[1]);
      if (isValidElement(v)) return <Fragment key={key}>{v}</Fragment>;
    }
    const out = resolveBindings(node.value, ctx.content);
    return out === '' ? null : out;
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
  if (tag === 'slot') {
    const name = attrs['name'] ?? 'children';
    return <Fragment key={key}>{renderSlot(ctx.content[name])}</Fragment>;
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
    if (attrs[a] !== undefined) props[a] = resolveBindings(attrs[a], ctx.content);
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
  // TEMP DIAGNOSTIC — remove once the title inline-edit issue is understood.
  // Logs, per declarative block render, the edit-mode flag and the runtime
  // type of every field value (ELEMENT = Puck swapped in an inline editor).
  if (typeof window !== 'undefined') {
    const fieldTypes: Record<string, string> = {};
    for (const k of Object.keys(content)) {
      const v = (content as Record<string, unknown>)[k];
      fieldTypes[k] = isValidElement(v) ? 'ELEMENT' : v === '' ? "'' (empty)" : typeof v;
    }
    // eslint-disable-next-line no-console
    console.log('[declarative]', { editMode: content.editMode, editable: [...editableFields], fieldTypes });
  }
  return <>{nodes.map((n, i) => renderNode(n, ctx, String(i)))}</>;
}
