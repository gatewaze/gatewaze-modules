/**
 * PuckConfigAdapter — `templates_*` library rows → Puck `Config`.
 *
 * Per spec-builder-evaluation §3.2. Multi-tenant by construction:
 * one Config per `library_id`. Each `<PuckCanvasEditor>` instance
 * mounts its own Config. There is no global block registry — that
 * was the disqualifier for ChaiBuilder OSS, and we deliberately
 * avoid the same shape here.
 *
 * The adapter is deliberately thin: it walks block_defs, calls
 * `jsonSchemaToPuckFields` per row, attaches a `render` that
 * delegates to the iframe-host's renderBlock (so the canonical
 * renderPage pipeline still owns output), and adds a Slot field
 * named `children` for `has_bricks` blocks.
 *
 * Field-component injection (richtext / image / link / color) is
 * done at this layer because the choice of component is theme-
 * kind-aware (a richtext field renders differently in email vs
 * website). The `jsonSchemaToPuckFields` step only tags the
 * format; this layer wires up the React renderer.
 */

import type { Config, Field } from '@puckeditor/core';
// Puck ships its UI styles as a separate CSS file. Without this import
// the editor mounts but renders unstyled — toolbar labels appear as
// plain text, viewport selector flattens, etc. Imported here in the
// Config adapter so both consumers (sites' PuckCanvasEditor and
// newsletters' NewsletterPuckCanvas via the merge helper) pick it up
// transitively. Vite's CSS plugin injects it as a <style> tag.
import '@puckeditor/core/dist/index.css';
import {
  jsonSchemaToPuckFields,
  defaultsFromSchema,
  type PuckField,
  type CustomFormat,
  type FieldMapWarning,
} from './json-schema-to-puck-fields.js';
import type {
  BlockDefRow,
  BrickDefRow,
  WrapperRow,
  ThemeKind,
  PuckRenderHost,
} from './types.js';
import { resolveCustomField } from './fields/index.js';
import { PersonalizableFieldWrapper } from './fields/PersonalizableFieldWrapper.js';

/**
 * Universal outer-spacing fields injected on every block + brick. The
 * underscore prefix sets them apart from schema-declared content fields
 * — content fields come from `templates_block_defs.schema` and never
 * use the `_spacing_` namespace, so collisions can't happen by accident.
 *
 * Both default to `'0px'`. The render path wraps the iframe-bridged
 * block render in a `<div>` carrying `padding`/`margin` inline styles
 * when either value is non-default; identical-to-pre-spacing output
 * otherwise.
 *
 * Plain `text` fields here (not the slider used by the email registry)
 * because the slider component lives in the newsletters module and
 * we're avoiding a cross-module dependency. Operators type CSS values
 * directly: `"16px"`, `"16px 24px"`, etc.
 */
const SPACING_FIELDS: Record<string, Field> = {
  _spacing_padding: { type: 'text', label: 'Padding (outer)' },
  _spacing_margin: { type: 'text', label: 'Margin' },
};
const SPACING_DEFAULTS = { _spacing_padding: '0px', _spacing_margin: '0px' };

/** Extract spacing props from a raw Puck prop bag, stripping them from `rest`. */
function pickSpacing(props: Record<string, unknown>): {
  padding: string;
  margin: string;
  rest: Record<string, unknown>;
} {
  const padding = typeof props._spacing_padding === 'string' ? props._spacing_padding : '0px';
  const margin = typeof props._spacing_margin === 'string' ? props._spacing_margin : '0px';
  const rest = { ...props };
  delete rest._spacing_padding;
  delete rest._spacing_margin;
  return { padding, margin, rest };
}

/** Wrap an iframe-rendered block in a spacing div when non-default. */
function withSpacing(node: React.ReactNode, padding: string, margin: string): React.ReactNode {
  if (padding === '0px' && margin === '0px') return node;
  return <div style={{ padding, margin }}>{node}</div>;
}

export interface BuildConfigArgs {
  libraryId: string;
  blockDefs: ReadonlyArray<BlockDefRow>;
  brickDefs: ReadonlyArray<BrickDefRow>;
  wrappers: ReadonlyArray<WrapperRow>;
  themeKind: ThemeKind;
  renderHost: PuckRenderHost;
  /**
   * Theme styles extracted from the site's rendered page. Injected once
   * via the Puck `root.render` so every block in the iframe inherits
   * the site's visual identity (fonts, colors, layout).
   * Per spec-builder-evaluation §3.5.
   */
  themeCss?: {
    inline: string;
    externalLinks: ReadonlyArray<string>;
  };
}

export interface BuildConfigResult {
  config: Config;
  warnings: ReadonlyArray<FieldMapWarning & { blockDefKey: string }>;
  /**
   * sha256 of `library_id + sorted block_def_keys`, used by the
   * cross-tenant guard at save time (spec §3.7).
   */
  fingerprint: string;
}

export function buildPuckConfig(args: BuildConfigArgs): BuildConfigResult {
  // Filter by theme_kind — Per spec-builder-evaluation §3.6 a single
  // library can host both website and email blocks. The Config adapter
  // surfaces only the channel matching the current edit session.
  const currentBlocks = args.blockDefs.filter(
    (d) => d.is_current && d.theme_kind === args.themeKind,
  );
  const warnings: Array<FieldMapWarning & { blockDefKey: string }> = [];

  const components: Record<string, Config['components'][string]> = {};
  for (const def of currentBlocks) {
    const { fields: rawFields, warnings: blockWarnings } = jsonSchemaToPuckFields(def.schema);
    for (const w of blockWarnings) {
      warnings.push({ ...w, blockDefKey: def.key });
    }

    const fields = wrapFieldsWithComponents(rawFields, args);
    if (def.has_bricks) {
      // Slot field exposing the brick container.
      // Puck v0.20 supports the `slot` field type; the `allow` array
      // restricts which component types can be inserted into the slot.
      (fields as Record<string, Field>).children = {
        type: 'slot' as Field['type'],
        allow: brickKeysForBlock(def.key, args.brickDefs),
      } as Field;
    }

    components[def.key] = {
      label: def.name,
      fields: { ...SPACING_FIELDS, ...(fields as Record<string, Field>) },
      defaultProps: { ...SPACING_DEFAULTS, ...defaultsFromSchema(def.schema) },
      render: (props) => {
        const { padding, margin, rest } = pickSpacing(props as Record<string, unknown>);
        return withSpacing(
          args.renderHost.renderBlock({
            blockDefKey: def.key,
            variantKey: typeof rest.variant_key === 'string' ? rest.variant_key : 'default',
            content: stripStructural(rest),
          }),
          padding,
          margin,
        );
      },
    };
  }

  // Brick components get their own entries so Slots can resolve them.
  // Same theme_kind filter as blocks (a website session shouldn't see
  // email-flavored bricks, even when both live in one library).
  for (const brick of args.brickDefs.filter(
    (b) => b.is_current && b.theme_kind === args.themeKind,
  )) {
    if (components[brick.key]) continue; // brick key collides with a block — block wins
    const { fields: rawFields, warnings: brickWarnings } = jsonSchemaToPuckFields(brick.schema);
    for (const w of brickWarnings) {
      warnings.push({ ...w, blockDefKey: `${brick.parent_block_def_key}::${brick.key}` });
    }
    const fields = wrapFieldsWithComponents(rawFields, args);
    components[brick.key] = {
      label: brick.name,
      fields: { ...SPACING_FIELDS, ...(fields as Record<string, Field>) },
      defaultProps: { ...SPACING_DEFAULTS, ...defaultsFromSchema(brick.schema) },
      render: (props) => {
        const { padding, margin, rest } = pickSpacing(props as Record<string, unknown>);
        return withSpacing(
          args.renderHost.renderBlock({
            blockDefKey: brick.key,
            variantKey: typeof rest.variant_key === 'string' ? rest.variant_key : 'default',
            content: stripStructural(rest),
          }),
          padding,
          margin,
        );
      },
    };
  }

  const root = pickRootWrapper(args.wrappers);
  const rootFields: Record<string, Field> = root?.schema
    ? (wrapFieldsWithComponents(jsonSchemaToPuckFields(root.schema).fields, args) as Record<string, Field>)
    : {};

  const config: Config = {
    components,
    root: {
      fields: rootFields,
      render: buildRootRenderer(args.themeCss),
    },
  };

  return {
    config,
    warnings,
    fingerprint: fingerprintConfig(args.libraryId, currentBlocks),
  };
}

// ---------------------------------------------------------------------------

function wrapFieldsWithComponents(
  raw: Record<string, PuckField>,
  args: BuildConfigArgs,
): Record<string, PuckField> {
  const out: Record<string, PuckField> = {};
  for (const [k, f] of Object.entries(raw)) {
    out[k] = wrapField(f, k, args);
  }
  return out;
}

function wrapField(f: PuckField, propName: string, args: BuildConfigArgs): PuckField {
  // Personalizable fields get a custom wrapper that exposes the same
  // inline editor + a "Personalize" button. We compose this AFTER any
  // custom-format resolution so a personalizable image field still uses
  // the host's media picker inline.
  if (f.personalizable) {
    const inner = innerCustomFieldRender(f, args);
    return {
      type: 'custom',
      label: f.label,
      customFormat: 'richtext', // sentinel; render takes over
      render: ({ value, onChange }) => (
        <PersonalizableFieldWrapper
          field={f}
          propName={propName}
          value={value}
          onChange={onChange}
          {...(inner ? { resolveCustom: () => inner } : {})}
        />
      ),
    };
  }

  if (f.type === 'custom') {
    return {
      ...f,
      render: resolveCustomField(f.customFormat as CustomFormat, args),
    };
  }
  if (f.type === 'array') {
    return {
      ...f,
      arrayFields: wrapFieldsWithComponents(f.arrayFields, args),
    };
  }
  if (f.type === 'object') {
    return {
      ...f,
      objectFields: wrapFieldsWithComponents(f.objectFields, args),
    };
  }
  return f;
}

/**
 * When wrapping a personalizable `type: 'custom'` field, the wrapper
 * still needs the underlying custom-format render (richtext editor,
 * media picker, etc.) so it can mount it inline. Returns null when the
 * source field isn't a custom-format field.
 */
function innerCustomFieldRender(
  f: PuckField,
  args: BuildConfigArgs,
): ((p: { value: unknown; onChange: (v: unknown) => void }) => React.ReactNode) | null {
  if (f.type !== 'custom') return null;
  return resolveCustomField(f.customFormat as CustomFormat, args);
}

function brickKeysForBlock(parentKey: string, brickDefs: ReadonlyArray<BrickDefRow>): string[] {
  return brickDefs
    .filter((b) => b.parent_block_def_key === parentKey && b.is_current)
    .map((b) => b.key);
}

function pickRootWrapper(wrappers: ReadonlyArray<WrapperRow>): WrapperRow | undefined {
  return wrappers.find((w) => w.is_current && w.key === 'default')
    ?? wrappers.find((w) => w.is_current);
}

/**
 * Wrap the page-level children with a <style> tag carrying the site's
 * theme CSS plus <link> elements for any external stylesheets the
 * legacy renderer pulls in. The output mounts inside Puck's iframe; the
 * styles cascade to every nested block render.
 *
 * When `themeCss` is undefined the children are passed through; the
 * iframe will look unstyled but the editor still works.
 */
function buildRootRenderer(themeCss: BuildConfigArgs['themeCss']) {
  return function PuckRoot(props: { children?: React.ReactNode }) {
    if (!themeCss || (!themeCss.inline && themeCss.externalLinks.length === 0)) {
      return <>{props.children}</>;
    }
    return (
      <>
        {themeCss.externalLinks.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        {themeCss.inline && (
          <style
            data-puck-theme-css="inline"
            dangerouslySetInnerHTML={{ __html: themeCss.inline }}
          />
        )}
        {props.children}
      </>
    );
  };
}

function stripStructural(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'id' || k === 'variant_key' || k === 'children') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Stable fingerprint of the library shape. Used by the editor to detect
 * cross-tenant Config swaps at save time (§3.7).
 *
 * Pure JS — no `crypto` dependency; we use a small FNV-1a since the
 * input is short and we only need collision-resistance against
 * accidental reuse, not adversarial collisions (the server-side
 * fingerprint check is the real guard).
 */
function fingerprintConfig(libraryId: string, blocks: ReadonlyArray<BlockDefRow>): string {
  const keys = blocks.map((b) => b.key).sort().join(',');
  return fnv1a(`${libraryId}|${keys}`);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Convert to 8-char hex.
  return (h >>> 0).toString(16).padStart(8, '0');
}
