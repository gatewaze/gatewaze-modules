/**
 * EditionEmail — composes a NewsletterEdition into a single
 * react-email-renderable JSX tree. One `await render(<EditionEmail/>)`
 * call produces a complete email-safe HTML document. Per
 * spec-builder-evaluation §3.6 (extended).
 *
 * Mixed-mode: walks the edition's blocks and renders each via:
 *   - `render_kind='react-email'`  → look up the registry entry and
 *                                     mount the entry's `Component`
 *                                     (or `formats[format]` for non-
 *                                     email outputs). When the entry
 *                                     declares a `slot` field, the
 *                                     composer recursively renders
 *                                     `block.content.children` as
 *                                     react-email JSX and threads it
 *                                     through to the component as
 *                                     `children`.
 *   - `render_kind='mustache'`     → run the legacy Mustache template
 *                                     through `renderTemplate` and
 *                                     mount as `dangerouslySetInnerHTML`
 *                                     inside the same JSX tree.
 *
 * Both the publish-worker (server-side) and the editor's "Export" button
 * (browser-side) call `await render(<EditionEmail edition format/>)` —
 * react-email's `render` works in both environments.
 */

import { Body, Container, Head, Html, Preview } from '@react-email/components';
import { cloneElement, isValidElement } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { NewsletterEdition, EditionBlock } from '../../../utils/types.js';
import { getEmailBlock, type FormatId } from './index.js';
import { renderTemplate } from '../../../../../sites/lib/canvas-render/mustache-subset.js';
import { extractSpacing, wrapWithSpacing } from './spacing-wrapper.js';

export interface EditionEmailProps {
  edition: NewsletterEdition;
  format: 'email' | FormatId;
  /**
   * For each block: indicates whether this block was authored as a
   * react-email registry component or a legacy Mustache template.
   * Provided as a Map by the caller (publish-worker reads
   * `templates_block_defs.render_kind`/`component_id` for each
   * `block_template_id`); the editor reads the same join via the
   * loaded library.
   */
  blockMeta: ReadonlyMap<string, BlockRenderMeta>;
}

export interface BlockRenderMeta {
  render_kind: 'mustache' | 'react-email';
  /** When render_kind='react-email', the registry key. */
  component_id?: string;
  /** When render_kind='mustache', the template HTML for the requested
   *  format. The publish-worker resolves this per-format from
   *  templates_block_defs (html / substack_template / beehiiv_template). */
  mustache_html?: string;
}

export function EditionEmail(props: EditionEmailProps): ReactElement {
  const { edition, format, blockMeta } = props;

  return (
    <Html lang="en">
      <Head>
        <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
        {edition.subject && <title>{edition.subject}</title>}
      </Head>
      {edition.preheader && <Preview>{edition.preheader}</Preview>}
      <Body style={{ margin: 0, padding: 0, fontFamily: 'Helvetica, Arial, sans-serif' }}>
        <Container style={{ maxWidth: 600, margin: '0 auto', padding: '24px' }}>
          {[...edition.blocks]
            .sort((a, z) => a.sort_order - z.sort_order)
            .map((block) => (
              <BlockSlot
                key={block.id}
                block={block}
                format={format}
                meta={blockMeta.get(block.id)}
              />
            ))}
        </Container>
      </Body>
    </Html>
  );
}

interface BlockSlotProps {
  block: EditionBlock;
  format: 'email' | FormatId;
  meta: BlockRenderMeta | undefined;
}

function BlockSlot({ block, format, meta }: BlockSlotProps): ReactElement | null {
  // No metadata — fall back to treating it as Mustache with the
  // block_template's html_template, since that's the legacy default.
  const effective: BlockRenderMeta = meta ?? {
    render_kind: 'mustache',
    mustache_html: block.block_template.content.html_template ?? '',
  };

  if (effective.render_kind === 'react-email') {
    if (!effective.component_id) {
      return <Fallback message={`block ${block.id}: react-email render_kind missing component_id`} />;
    }
    const entry = getEmailBlock(effective.component_id);
    if (!entry) {
      return <Fallback message={`block ${block.id}: unknown component_id '${effective.component_id}'`} />;
    }
    const Comp = pickFormatComponent(entry.Component, entry.formats, format);
    const props = { ...(block.content as Record<string, unknown>) };
    // Pluck the universal spacing props off — they belong on the
    // wrapper, not on the block's render. Strip from props BEFORE the
    // slot/children handling so they don't leak through to the
    // component's own attribute set.
    const { padding, margin } = extractSpacing(props);
    delete props._spacing_padding;
    delete props._spacing_margin;
    // Slot containers: the `children` field is a serialised tree under
    // content.children. Recursively render it into JSX before passing
    // through to the component, so the component sees a ReactNode and
    // not raw entry data.
    if (entryHasSlot(entry) && Array.isArray(props.children)) {
      props.children = renderTree(props.children as ReadonlyArray<unknown>, format);
    } else if ('children' in props && !entryHasSlot(entry)) {
      // Leaf primitive accidentally carrying children — strip so the
      // component's own intrinsic `children` (if any) wins.
      delete props.children;
    }
    return <>{wrapWithSpacing(<Comp {...(props as never)} />, padding, margin)}</>;
  }

  // Mustache path
  const html = effective.mustache_html ?? '';
  if (!html) return null;
  let rendered: string;
  try {
    rendered = renderTemplate(html, block.content, { partials: new Map<string, string>() });
  } catch (e) {
    return <Fallback message={`block ${block.id}: mustache render error: ${e instanceof Error ? e.message : String(e)}`} />;
  }
  return <div dangerouslySetInnerHTML={{ __html: rendered }} />;
}

/**
 * Recursively render a slot tree (block.content.children) into JSX.
 * Each entry is `{ type: componentId, props: { id, ...content } }`;
 * nested slots come through `props.children` of the same shape.
 */
export function renderTree(
  entries: ReadonlyArray<unknown>,
  format: 'email' | FormatId,
): ReactNode {
  return entries.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as { type?: unknown; props?: unknown };
    if (typeof e.type !== 'string') return null;
    const entry = getEmailBlock(e.type);
    if (!entry) {
      return <Fallback key={idx} message={`unknown component_id '${e.type}'`} />;
    }
    const Comp = pickFormatComponent(entry.Component, entry.formats, format);
    const propsRaw = e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {};
    const props = { ...propsRaw };
    const id = typeof props.id === 'string' ? props.id : `tree-${idx}`;
    delete props.id;
    const { padding, margin } = extractSpacing(props);
    delete props._spacing_padding;
    delete props._spacing_margin;
    if (entryHasSlot(entry) && Array.isArray(props.children)) {
      props.children = renderTree(props.children as ReadonlyArray<unknown>, format);
    } else if ('children' in props && !entryHasSlot(entry)) {
      delete props.children;
    }
    const node = <Comp key={id} {...(props as never)} />;
    const wrapped = wrapWithSpacing(node, padding, margin);
    // When the wrapper introduces a real <div>, React needs a key on
    // the outer element (not the inner Comp). Clone the wrapper to
    // attach the key without disturbing its styling.
    if (wrapped === node) return node;
    return isValidElement(wrapped) ? cloneElement(wrapped, { key: id }) : wrapped;
  });
}

function entryHasSlot(entry: ReturnType<typeof getEmailBlock>): boolean {
  if (!entry) return false;
  const f = entry.fields as Record<string, { type?: string }>;
  return f.children?.type === 'slot';
}

function pickFormatComponent<P>(
  base: ComponentType<P>,
  formats: Partial<Record<FormatId, ComponentType<P>>> | undefined,
  format: 'email' | FormatId,
): ComponentType<P> {
  if (format === 'email') return base;
  return formats?.[format] ?? base;
}

function Fallback({ message }: { message: string }): ReactElement {
  return (
    <div
      style={{
        border: '1px dashed #ddd',
        padding: '12px',
        margin: '12px 0',
        color: '#888',
        fontFamily: 'monospace',
        fontSize: '12px',
      }}
    >
      ⚠ {message}
    </div>
  );
}
