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
import type { EmailBlockRegistry } from './registry-types.js';

/** Resolve a component id against an optional per-edition registry, then the
 *  static one — so declarative (git-authored) blocks resolve in export too. */
function resolveEntry(id: string, registry: EmailBlockRegistry | undefined) {
  return registry?.get(id) ?? getEmailBlock(id);
}
import { renderTemplate } from '../../../../../sites/lib/canvas-render/mustache-subset.js';
import { extractSpacing, wrapWithSpacing } from './spacing-wrapper.js';
import { parseTemplate } from './declarative/parse-template.js';
import { DeclarativeBlock } from './declarative/render.js';

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
  /**
   * Declarative wrapper HTML from the newsletter's template repo
   * (`wrappers/default.html`, parsed by the templates module into a
   * `templates_wrappers` row). When present, the edition's body blocks render
   * inside a `<slot name="body" />` in the wrapper template. The wrapper carries
   * its own header/footer chrome — links, copy, layout, colours — so each
   * newsletter's repo controls its visual identity.
   *
   * Wrapper-template mustache namespace: `{{edition.date}}`, `{{edition.title}}`,
   * `{{edition.preheader}}`, `{{edition.view_online_link}}`,
   * `{{edition.unsubscribe_url}}`, `{{edition.manage_subscriptions_url}}`. Per-brand values
   * (shop links, partner email, social links, etc.) are baked into the
   * template HTML directly — no separate config layer.
   *
   * Absent → no chrome added (just the body blocks).
   */
  wrapperTemplate?: string | null;
  /**
   * Resolved "View Online" URL for the header link. Defaults to the
   * `{{web_version}}` token so the send pipeline substitutes it per recipient.
   */
  viewOnlineUrl?: string;
  /**
   * Suppress the header "View Online" link. Set by the publish pipeline: the
   * published page IS the online version, so a self-referential link is
   * redundant. The sent email and editor preview leave it on.
   */
  hideViewOnline?: boolean;
  /**
   * Per-edition registry (static code blocks + this newsletter's declarative
   * blocks). Looked up before the global registry so declarative blocks render
   * in export/publish/send. Absent → global registry only.
   */
  registry?: EmailBlockRegistry;
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
  const { edition, format, blockMeta, wrapperTemplate, viewOnlineUrl, hideViewOnline, registry } = props;

  const sorted = [...edition.blocks].sort((a, z) => a.sort_order - z.sort_order);

  // Legacy editions are 100% Mustache — imported email templates that already
  // carry their own 650px self-centering layout. For those we use a
  // transparent full-width wrapper and 10px inter-block spacers so the output
  // matches the original single-document email exactly. Editions that use
  // react-email registry blocks keep the standard 600px Container (those
  // blocks target 600px and self-space via the universal _spacing_* props).
  const allMustache = sorted.every(
    (b) => (blockMeta.get(b.id)?.render_kind ?? 'mustache') === 'mustache',
  );

  const blockEls = sorted.map((block) => (
    <BlockSlot key={block.id} block={block} format={format} meta={blockMeta.get(block.id)} registry={registry} />
  ));

  // Declarative wrapper from the newsletter's template repo (templates_wrappers
  // row, key='default'). When present the edition body renders inside the
  // wrapper's `<slot name="body" />`; per-edition mustache fields (date, title,
  // view_online_link, ...) are interpolated through `{{edition.*}}`. When
  // absent the body renders without chrome.
  const composed: ReactNode = wrapperTemplate
    ? (() => {
        const parsed = parseTemplate(wrapperTemplate);
        // `viewOnlineUrl == null` is the per-recipient SEND render: leave the
        // {{...}} tokens for the send pipeline to substitute. A real URL means a
        // publish/web render, where unsubscribe doesn't apply → blank.
        const isSendRender = viewOnlineUrl == null;
        const content: Record<string, unknown> = {
          edition: {
            date: formatEditionDate(edition.edition_date),
            title: edition.subject ?? '',
            preheader: edition.preheader ?? '',
            view_online_link: hideViewOnline ? '' : (viewOnlineUrl ?? '{{web_version}}'),
            // Subscription Centre links — the wrapper footer references these as
            // {{edition.unsubscribe_url}} / {{edition.manage_subscriptions_url}};
            // their VALUES are the send-time tokens the edge fn fills per
            // recipient (empty on a publish/web render).
            unsubscribe_url: isSendRender ? '{{unsubscribe_url}}' : '',
            manage_subscriptions_url: isSendRender ? '{{manage_subscriptions_url}}' : '',
          },
          body: <>{blockEls}</>,
        };
        return <DeclarativeBlock nodes={parsed.nodes} content={content} />;
      })()
    : blockEls;

  const body = allMustache ? (
    <Body style={{ margin: 0, padding: 0, backgroundColor: '#ffffff', fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif" }}>
      <Container style={{ width: '100%', maxWidth: '100%', margin: 0, padding: '10px' }}>
        {composed.flatMap((el, i) =>
          i < composed.length - 1 ? [el, <Spacer key={`sp-${i}`} />] : [el],
        )}
      </Container>
    </Body>
  ) : (
    <Body style={{ margin: 0, padding: 0, fontFamily: 'Helvetica, Arial, sans-serif' }}>
      <Container style={{ maxWidth: 600, margin: '0 auto', padding: '24px' }}>{composed}</Container>
    </Body>
  );

  return (
    <Html lang="en">
      <Head>
        <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
        {edition.subject && <title>{edition.subject}</title>}
      </Head>
      {edition.preheader && <Preview>{edition.preheader}</Preview>}
      {body}
    </Html>
  );
}

/** Format the edition date for `{{edition.date}}` interpolation in the
 *  declarative wrapper template (e.g. "June 15, 2026"). Falls back to the
 *  raw string if the date doesn't parse. */
function formatEditionDate(editionDate: string): string {
  const d = new Date(`${editionDate}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? String(editionDate ?? '')
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** 10px vertical spacer between blocks — matches the legacy SPACER_TEMPLATE. */
function Spacer(): ReactElement {
  return (
    <table width="100%" cellPadding={0} cellSpacing={0} role="presentation" style={{ borderCollapse: 'collapse' }}>
      <tbody>
        <tr>
          <td style={{ height: 10, fontSize: 1, lineHeight: '1px' }}>{' '}</td>
        </tr>
      </tbody>
    </table>
  );
}

interface BlockSlotProps {
  block: EditionBlock;
  format: 'email' | FormatId;
  meta: BlockRenderMeta | undefined;
  registry?: EmailBlockRegistry;
}

function BlockSlot({ block, format, meta, registry }: BlockSlotProps): ReactElement | null {
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
    const entry = resolveEntry(effective.component_id, registry);
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
    // Slot containers: render the recursive children tree. Prefer the
    // serialised tree under content.children (native authoring); fall back to
    // the edition block's legacy `bricks` (community blocks store their bricks
    // separately, not in content) so converted bricked blocks still render
    // their bricks in the export.
    if (entryHasSlot(entry)) {
      let tree: ReadonlyArray<unknown> | null = Array.isArray(props.children)
        ? (props.children as ReadonlyArray<unknown>)
        : null;
      if (!tree && Array.isArray(block.bricks) && block.bricks.length > 0) {
        tree = [...block.bricks]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((br) => ({
            type: br.brick_template.brick_type,
            props: { ...(br.content as Record<string, unknown>) },
          }));
      }
      props.children = tree ? renderTree(tree, format, registry) : undefined;
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

  // Render the block's bricks and expose them as `bricks` so a bricked
  // template's `{{{bricks}}}` placeholder is filled, mirroring the legacy
  // previewRenderer. Leaf blocks have no bricks and ignore it. Without
  // this, bricked mustache blocks (e.g. the community section) render the
  // wrapper only and drop all brick content.
  const bricksHtml = [...(block.bricks ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((brick) => {
      const tpl = brick.brick_template?.content?.html_template ?? '';
      if (!tpl) return '';
      try {
        return renderTemplate(tpl, brick.content, { partials: new Map<string, string>() });
      } catch {
        return '';
      }
    })
    .join('\n');

  let rendered: string;
  try {
    rendered = renderTemplate(
      html,
      { ...block.content, bricks: bricksHtml },
      { partials: new Map<string, string>() },
    );
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
  registry?: EmailBlockRegistry,
): ReactNode {
  return entries.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as { type?: unknown; props?: unknown };
    if (typeof e.type !== 'string') return null;
    const entry = resolveEntry(e.type, registry);
    if (!entry) {
      return <Fallback key={idx} message={`unknown component_id '${e.type}'`} />;
    }
    const Comp = pickFormatComponent(entry.Component, entry.formats, format);
    const propsRaw = e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {};
    const props = { ...propsRaw };
    // Mark the last sibling so slot bricks (e.g. MLOps Community sections) can
    // drop their trailing separator — a divider belongs BETWEEN bricks, not
    // after the final one. Ignored by components that don't read it.
    props._last = idx === entries.length - 1;
    const id = typeof props.id === 'string' ? props.id : `tree-${idx}`;
    delete props.id;
    const { padding, margin } = extractSpacing(props);
    delete props._spacing_padding;
    delete props._spacing_margin;
    if (entryHasSlot(entry) && Array.isArray(props.children)) {
      props.children = renderTree(props.children as ReadonlyArray<unknown>, format, registry);
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
