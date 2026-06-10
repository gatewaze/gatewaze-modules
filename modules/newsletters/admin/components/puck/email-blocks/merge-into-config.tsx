/**
 * Merge react-email registry entries into a Puck Config built by sites'
 * `buildPuckConfig`. Per spec-builder-evaluation §3.6 (extended).
 *
 * The newsletter editor's library typically contains:
 *   - schema-driven Mustache blocks   (render_kind='mustache')
 *   - registry-driven react-email     (render_kind='react-email')
 *
 * `buildPuckConfig` already produces the Mustache half. This helper
 * appends the react-email half by walking the registry and synthesising
 * Puck `ComponentConfig` entries whose `render` returns the registry
 * entry's TSX — Puck calls them just like any other component, but the
 * JSX they produce is email-safe (table-based, inline styled, MSO ghost
 * wrappers via @react-email/components).
 *
 * Collisions: if a Mustache block_def and a registry entry share the
 * same key, the Mustache row wins (it's authored explicitly per-site;
 * the registry is platform-default). A console warning is emitted in
 * dev mode so authors can notice.
 */

import type { Config, Field } from '@puckeditor/core';
import type { EmailBlockEntry, EmailBlockRegistry } from './registry-types.js';
import { NewsletterPaddingSliderField } from './number-slider-field-adapter.js';
import { wrapWithSpacing } from './spacing-wrapper.js';
import { resolveCustomField } from '../../../../../sites/admin/components/canvas/puck/fields/index.js';
import type { CustomFormat } from '../../../../../sites/admin/components/canvas/puck/json-schema-to-puck-fields.js';
import type { PuckRenderHost } from '../../../../../sites/admin/components/canvas/puck/types.js';

/**
 * Wire `customFormat` → render for a registry block's fields, recursing
 * into array/object fields. The sites PuckConfigAdapter does this for
 * schema-driven blocks; registry blocks went through this merge layer
 * which previously skipped it, so a `{ type:'custom', customFormat:'richtext' }`
 * field shipped without a render and Puck threw. Fields that already carry
 * a `render` (e.g. the spacing sliders) are left untouched.
 */
function resolveCustomRenders(
  fields: Record<string, Field>,
  ctx: { renderHost: PuckRenderHost },
): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [k, f] of Object.entries(fields)) {
    const field = f as {
      type?: string;
      customFormat?: string;
      render?: unknown;
      arrayFields?: Record<string, Field>;
      objectFields?: Record<string, Field>;
    };
    if (field.type === 'custom' && field.customFormat && typeof field.render !== 'function') {
      out[k] = { ...f, render: resolveCustomField(field.customFormat as CustomFormat, ctx) } as Field;
    } else if (field.type === 'array' && field.arrayFields) {
      out[k] = { ...f, arrayFields: resolveCustomRenders(field.arrayFields, ctx) } as Field;
    } else if (field.type === 'object' && field.objectFields) {
      out[k] = { ...f, objectFields: resolveCustomRenders(field.objectFields, ctx) } as Field;
    } else {
      out[k] = f;
    }
  }
  return out;
}

/**
 * Uniform spacing fields auto-injected into every registry block. The
 * underscore prefix sets these apart from content fields (Container has
 * its own `padding` for inner spacing — that survives unchanged; the
 * `_spacing_*` pair adds outer spacing on a wrapper element).
 *
 * Both default to `'0px'` so existing blocks render identically until
 * an operator opts in. The same slider field that powers Container's
 * inner padding is reused — it handles single-axis and CSS-shorthand
 * values (e.g. `"16px 24px"`).
 */
const SPACING_FIELDS: Record<string, Field> = {
  _spacing_padding: {
    type: 'custom',
    label: 'Padding (outer)',
    render: NewsletterPaddingSliderField as never,
  },
  _spacing_margin: {
    type: 'custom',
    label: 'Margin',
    render: NewsletterPaddingSliderField as never,
  },
};

const SPACING_DEFAULTS = {
  _spacing_padding: '0px',
  _spacing_margin: '0px',
};

/**
 * Default `contentEditable: true` on every text / textarea field that
 * doesn't explicitly opt out. This is what makes the canvas an inline
 * editor: Puck wraps the field's rendered text node in an editable
 * span. If a field's value isn't rendered as visible text (URLs on
 * `href`, colors as `style` values, sizes in `px`), `contentEditable`
 * is a no-op for it, so defaulting universally is safe — it only
 * kicks in where the prop shows as visible text.
 *
 * Blocks can still opt out per-field by setting
 * `contentEditable: false` explicitly. Custom / select / number /
 * boolean fields are left untouched (they have their own UI).
 */
function enableInlineEditing(fields: Record<string, Field>): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [key, field] of Object.entries(fields)) {
    const type = (field as { type?: string }).type;
    const hasExplicit = (field as { contentEditable?: boolean }).contentEditable !== undefined;
    if ((type === 'text' || type === 'textarea') && !hasExplicit) {
      out[key] = { ...field, contentEditable: true } as Field;
    } else {
      out[key] = field;
    }
  }
  return out;
}

/**
 * Detect custom fields that are missing a `render` function. Puck v0.21's
 * AutoField throws "Field type for custom did not exist." the moment a
 * drawer tries to render such a field — a confusing error message that
 * surfaces only at runtime, only after a block is selected, and that
 * crashes the editor's drawer. This pre-flight check catches the
 * problem at merge time with a clear message instead.
 *
 * The trap is real: sites' PuckConfigAdapter has a resolver that maps
 * `{ type: 'custom', customFormat: 'richtext' }` to an actual render
 * function. The email-blocks merge layer doesn't run that resolver, so
 * a block authored with `customFormat` (no `render`) ships broken.
 * Pin the diagnostic here rather than relying on the per-block author
 * remembering the difference.
 */
function assertCustomFieldsHaveRender(componentId: string, fields: Record<string, Field>): void {
  for (const [key, field] of Object.entries(fields)) {
    const f = field as { type?: string; render?: unknown; customFormat?: string };
    if (f.type !== 'custom') continue;
    if (typeof f.render === 'function') continue;
    const hint = f.customFormat
      ? ` (declared customFormat='${f.customFormat}' but the email-blocks merge layer does not resolve customFormat → render; provide an explicit \`render\` function instead)`
      : '';
    throw new Error(
      `[email-blocks] Block '${componentId}' field '${key}' has type='custom' without a render function${hint}.`,
    );
  }
}

export interface MergeArgs {
  /** The Config already built from schema-driven block_defs. */
  base: Config;
  /** The registry to merge in. */
  registry: EmailBlockRegistry;
  /** Host hooks (media picker etc.) threaded into custom-field renders. */
  renderHost: PuckRenderHost;
  /**
   * Optional filter — only include registry entries whose componentId
   * appears in this set. Lets the caller scope the available react-email
   * blocks to those a particular library actually opted into (i.e.
   * matched by a `templates_block_defs` row with render_kind='react-email').
   * When undefined, every registry entry is included.
   */
  enabledComponentIds?: ReadonlySet<string>;
}

export interface MergeResult {
  config: Config;
  /** componentIds skipped because a Mustache block_def with the same key already won. */
  collisions: ReadonlyArray<string>;
}

export function mergeRegistryIntoConfig(args: MergeArgs): MergeResult {
  const collisions: string[] = [];
  // NOTE: We deliberately do NOT apply `enableInlineEditing` to the base
  // (Mustache) components. Their canvas render is string-template
  // substitution mounted via dangerouslySetInnerHTML, so Puck's
  // `contentEditable` can't inject an editable region — and worse, it makes
  // Puck pass the field value as a React node, which the template stringifies
  // to "[object Object]". Inline editing only works for react-email registry
  // blocks (whose render exposes the value as an editable text node).
  const components = { ...(args.base.components ?? {}) };
  const categories: Record<string, { components: string[]; title?: string; defaultExpanded?: boolean }> = {};

  // Preserve existing categories from any incoming Mustache block_defs
  // — sites builds Config without categories today, but if a future
  // change adds them at base-build time this preserves the structure.
  const baseCategories = (args.base as { categories?: Record<string, { components?: string[]; title?: string; defaultExpanded?: boolean }> }).categories;
  if (baseCategories) {
    for (const [k, v] of Object.entries(baseCategories)) {
      categories[k] = { components: [...(v.components ?? [])], ...(v.title ? { title: v.title } : {}), ...(v.defaultExpanded != null ? { defaultExpanded: v.defaultExpanded } : {}) };
    }
  }

  // Mustache block keys that aren't already in any base category go
  // under "Custom blocks" (so they remain visible alongside the
  // registry surface).
  const knownCategorisedKeys = new Set(
    Object.values(categories).flatMap((c) => c.components),
  );
  const mustacheLeftovers: string[] = [];
  for (const key of Object.keys(args.base.components ?? {})) {
    if (!knownCategorisedKeys.has(key)) {
      mustacheLeftovers.push(key);
    }
  }

  for (const entry of args.registry.values()) {
    if (args.enabledComponentIds && !args.enabledComponentIds.has(entry.componentId)) {
      continue;
    }
    if (components[entry.componentId]) {
      collisions.push(entry.componentId);
      // eslint-disable-next-line no-console
      console.warn(
        `[email-blocks] Mustache block_def with key '${entry.componentId}' shadows the registry component. Either rename the Mustache block or remove the registry entry.`,
      );
      continue;
    }

    components[entry.componentId] = puckEntryFromRegistry(entry, args.renderHost);

    // Bucket the registry entry into its declared category. Entries
    // without a `category` field fall under "Other" — Puck shows those
    // by default at the bottom of the drawer.
    const cat = entry.category && entry.category.length > 0 ? entry.category : 'Other';
    if (!categories[cat]) {
      categories[cat] = { components: [], title: cat, defaultExpanded: cat === 'Layout' || cat === 'Content' };
    }
    categories[cat].components.push(entry.componentId);
  }

  if (mustacheLeftovers.length > 0) {
    categories['Custom blocks'] = {
      components: mustacheLeftovers,
      title: 'Custom blocks',
      defaultExpanded: false,
    };
  }

  return {
    config: { ...args.base, components, categories } as Config,
    collisions,
  };
}

function puckEntryFromRegistry(
  entry: EmailBlockEntry,
  renderHost: PuckRenderHost,
): Config['components'][string] {
  const Component = entry.Component;
  // Components that declare a `children` slot field need the slot value
  // forwarded; primitive leaf components ignore it. Detect via the field
  // map so we can pass children through only when meaningful.
  const hasSlotChildren =
    entry.fields &&
    typeof (entry.fields as Record<string, { type?: string }>).children === 'object' &&
    (entry.fields as Record<string, { type?: string }>).children?.type === 'slot';
  // Merge the universal spacing fields. Registry-declared fields win on
  // key collision so a block that already exposes `_spacing_*` keeps its
  // own version (defensive — no block does today). After merging, walk
  // the field map and default `contentEditable: true` on every text /
  // textarea field — that's what gives every block in-canvas inline
  // editing without needing per-block `contentEditable: true` flags.
  const mergedFields = resolveCustomRenders(
    enableInlineEditing({
      ...SPACING_FIELDS,
      ...(entry.fields as Record<string, Field>),
    }),
    { renderHost },
  );
  assertCustomFieldsHaveRender(entry.componentId, mergedFields);
  const mergedDefaults = {
    ...SPACING_DEFAULTS,
    ...entry.defaultProps,
  };
  const config: Record<string, unknown> = {
    label: entry.label,
    fields: mergedFields,
    defaultProps: mergedDefaults,
    // Puck calls render(props) — the registry's Component already accepts
    // the same shape. We strip Puck-only structural props (`id`,
    // `variant_key`, `puck`) and the universal `_spacing_*` props
    // (consumed by the wrapper, not the block) before delegating.
    // `editMode` is forwarded so blocks can render preview content in
    // the editor vs. Mustache placeholders at publish time. The
    // `children` slot prop survives only for components that declared
    // a slot field.
    render: (rawProps: Record<string, unknown>) => {
      const {
        id,
        children,
        variant_key,
        puck,
        editMode,
        _spacing_padding,
        _spacing_margin,
        ...rest
      } = rawProps as {
        id?: string;
        children?: unknown;
        variant_key?: string;
        puck?: unknown;
        editMode?: unknown;
        _spacing_padding?: string;
        _spacing_margin?: string;
        [k: string]: unknown;
      };
      void id; void variant_key; void puck;
      const props = hasSlotChildren
        ? { ...rest, children, editMode }
        : { ...rest, editMode };
      // Shared wrapper helper — same logic the publish path uses, so
      // canvas and final email render identically.
      const padding = typeof _spacing_padding === 'string' ? _spacing_padding : '0px';
      const margin = typeof _spacing_margin === 'string' ? _spacing_margin : '0px';
      return wrapWithSpacing(<Component {...(props as never)} />, padding, margin);
    },
  };
  if (entry.resolveData) {
    // Puck's typing for resolveData is generic over the full ComponentData
    // shape; the registry contract narrows that to just `{ props }`. Cast
    // at the boundary so callers aren't forced to thread Puck generics.
    config.resolveData = entry.resolveData as unknown;
  }
  return config as Config['components'][string];
}
