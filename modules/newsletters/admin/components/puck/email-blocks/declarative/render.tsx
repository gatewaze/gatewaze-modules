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

import { Fragment, type ReactNode } from 'react';
import type { TemplateNode } from './parse-template.js';
import { TAG_COMPONENTS, classStyle, parseInlineStyle, PASSTHROUGH_ATTRS } from './component-map.js';
import { RichText } from '../blocks/_richtext.js';

export type Content = Record<string, unknown>;

interface RenderCtx {
  content: Content;
  /** Named slot content (for <slot name="…" />), e.g. the slot children tree. */
  slots?: Record<string, ReactNode>;
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

function renderNode(node: TemplateNode, ctx: RenderCtx, key: string): ReactNode {
  if (node.kind === 'text') {
    const out = resolveBindings(node.value, ctx.content);
    return out === '' ? null : out;
  }

  const { tag, attrs, children } = node;

  // Conditional
  if (attrs['if'] !== undefined && !truthy(getPath(ctx.content, attrs['if']))) return null;

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

  // <slot name="x" /> — caller-provided content
  if (tag === 'slot') {
    const name = attrs['name'] ?? 'default';
    return <Fragment key={key}>{ctx.slots?.[name] ?? null}</Fragment>;
  }

  // <richtext field="x" class="y" /> or <richtext>{{x}}</richtext>
  if (tag === 'richtext') {
    const field = attrs['field'] ?? bindingKeyFromChildren(children);
    const value = field ? getPath(ctx.content, field) : undefined;
    const style = { ...classStyle(attrs['class']), ...parseInlineStyle(attrs['style']) };
    return <RichText key={key} value={value} style={style} />;
  }

  const Comp = TAG_COMPONENTS[tag];
  if (!Comp) {
    // Not allowlisted — drop the element but keep its (possibly bound) children
    // so authors can use a bare wrapper without breaking content.
    return <Fragment key={key}>{children.map((c, i) => renderNode(c, ctx, `${key}-${i}`))}</Fragment>;
  }

  const style = { ...classStyle(attrs['class']), ...parseInlineStyle(attrs['style']) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props: Record<string, any> = { style };
  for (const a of PASSTHROUGH_ATTRS) {
    if (attrs[a] !== undefined) props[a] = resolveBindings(attrs[a], ctx.content);
  }

  const kids = children.map((c, i) => renderNode(c, ctx, `${key}-${i}`));
  return (
    <Comp key={key} {...props}>
      {kids.length > 0 ? kids : undefined}
    </Comp>
  );
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

export function DeclarativeBlock({
  nodes,
  content,
  slots,
}: {
  nodes: TemplateNode[];
  content: Content;
  slots?: Record<string, ReactNode>;
}): ReactNode {
  return <>{nodes.map((n, i) => renderNode(n, { content, slots }, String(i)))}</>;
}
