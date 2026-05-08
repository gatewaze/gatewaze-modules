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

import type { Config } from '@puckeditor/core';
import type { EmailBlockEntry, EmailBlockRegistry } from './registry-types.js';

export interface MergeArgs {
  /** The Config already built from schema-driven block_defs. */
  base: Config;
  /** The registry to merge in. */
  registry: EmailBlockRegistry;
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

    components[entry.componentId] = puckEntryFromRegistry(entry);

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

function puckEntryFromRegistry(entry: EmailBlockEntry): Config['components'][string] {
  const Component = entry.Component;
  // Components that declare a `children` slot field need the slot value
  // forwarded; primitive leaf components ignore it. Detect via the field
  // map so we can pass children through only when meaningful.
  const hasSlotChildren =
    entry.fields &&
    typeof (entry.fields as Record<string, { type?: string }>).children === 'object' &&
    (entry.fields as Record<string, { type?: string }>).children?.type === 'slot';
  return {
    label: entry.label,
    fields: entry.fields,
    defaultProps: entry.defaultProps,
    // Puck calls render(props) — the registry's Component already accepts
    // the same shape. We strip Puck-only structural props (`id`,
    // `variant_key`, `puck`, `editMode`) before delegating; the `children`
    // slot prop survives only for components that declared a slot field.
    render: (rawProps: Record<string, unknown>) => {
      const { id, children, variant_key, puck, editMode, ...rest } = rawProps as {
        id?: string;
        children?: unknown;
        variant_key?: string;
        puck?: unknown;
        editMode?: unknown;
        [k: string]: unknown;
      };
      void id; void variant_key; void puck; void editMode;
      const props = hasSlotChildren ? { ...rest, children } : rest;
      return <Component {...(props as never)} />;
    },
  };
}
