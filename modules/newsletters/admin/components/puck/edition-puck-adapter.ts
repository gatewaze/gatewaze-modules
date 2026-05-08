/**
 * Newsletter edition ↔ Puck Data adapter.
 *
 * The newsletter editor is a *controlled* component (parent owns the
 * NewsletterEdition state, EditionCanvas/Puck don't talk to the server
 * directly). That makes the adapter simpler than sites' equivalent —
 * no baseline diffing or RefetchRequired sentinel; every change emits
 * a fresh NewsletterEdition that the parent persists.
 *
 * Per spec-builder-evaluation §3.6 (one editor for both website +
 * email channels) plus the JSX-tree extension (§3.6 follow-up): the
 * adapter is recursive for registry blocks that declare `slot` fields
 * (Container / Section / Row / Column / …). Nested children are
 * serialised into `block.content.children` as a tree of
 * `{ type, props }` entries — the publish-time composer walks that
 * tree to render the full JSX. Mustache blocks with `has_bricks` keep
 * their separate `bricks` column for backwards compatibility.
 */

import type {
  NewsletterEdition,
  EditionBlock,
  EditionBrick,
  BlockTemplate,
  BrickTemplate,
} from '../../utils/types.js';
import type {
  PuckData,
  PuckBlockEntry,
  PuckBrickEntry,
} from '../../../../sites/admin/components/canvas/puck/types.js';
import type { EmailBlockEntry, EmailBlockRegistry } from './email-blocks/registry-types.js';

const STRUCTURAL_PROPS = new Set(['id', 'children']);

/**
 * Tree entry shape used when serialising a registry block's nested
 * children into `block.content.children`. Each level may itself carry
 * `props.children` of the same shape.
 */
export interface RegistryTreeEntry {
  type: string;
  props: Record<string, unknown>;
}

/**
 * Convert an edition's blocks into the PuckData shape Puck mounts with.
 * sort_order ascending; nested children walk recursively for registry
 * blocks; bricks become a `children` slot for `has_bricks` Mustache
 * blocks (legacy path).
 */
export function editionToPuckData(
  edition: NewsletterEdition,
  registry?: EmailBlockRegistry,
): PuckData {
  const sortedBlocks = [...edition.blocks].sort((a, z) => a.sort_order - z.sort_order);
  const content: PuckBlockEntry[] = sortedBlocks.map((b) => {
    const blockType = b.block_template.block_type;
    const hasBricks = b.block_template.content.has_bricks ?? false;
    const props: PuckBlockEntry['props'] = {
      id: b.id,
      ...b.content,
    };

    if (hasBricks) {
      // Legacy Mustache `bricks` path — children come from b.bricks.
      props.children = (b.bricks ?? [])
        .slice()
        .sort((a, z) => a.sort_order - z.sort_order)
        .map<PuckBrickEntry>((br) => ({
          type: br.brick_template.brick_type,
          props: { id: br.id, ...br.content },
        }));
    } else if (registry && registry.has(blockType) && entryHasSlot(registry.get(blockType))) {
      // Registry block with a slot field — pull the recursive children
      // tree out of content.children. If absent, default to [] so Puck
      // still mounts a (possibly empty) DropZone.
      const stored = (b.content as { children?: unknown }).children;
      props.children = Array.isArray(stored)
        ? stored.map((entry) => normaliseTreeEntry(entry))
        : [];
    }

    return { type: blockType, props };
  });
  return {
    content,
    root: { props: {} },
  };
}

/**
 * Map a PuckData snapshot back to a NewsletterEdition. Looks up
 * block / brick templates by `block_type` / `brick_type` so the
 * editor can produce inserts as well as updates.
 *
 * Throws if a referenced block_type isn't in the catalogue OR the
 * registry — same fail-closed contract as sites' diff (the parent
 * should refresh the edition + templates before retrying).
 */
export function puckDataToEdition(args: {
  base: NewsletterEdition;
  data: PuckData;
  blockTemplates: ReadonlyArray<BlockTemplate>;
  brickTemplates: ReadonlyArray<BrickTemplate>;
  registry?: EmailBlockRegistry;
}): NewsletterEdition {
  const blockTplByType = new Map(args.blockTemplates.map((t) => [t.block_type, t]));
  const brickTplByType = new Map(args.brickTemplates.map((t) => [t.brick_type, t]));
  const prevBlocksById = new Map(args.base.blocks.map((b) => [b.id, b]));

  const newBlocks: EditionBlock[] = args.data.content.map((entry, idx) => {
    let tpl = blockTplByType.get(entry.type);
    if (!tpl && args.registry?.has(entry.type)) {
      const reg = args.registry.get(entry.type)!;
      tpl = {
        id: '',
        name: reg.label,
        block_type: reg.componentId,
        content: { html_template: '', schema: {}, has_bricks: false },
      };
    }
    if (!tpl) {
      throw new Error(`unknown block_type in PuckData: ${entry.type}`);
    }
    const id = extractStableId(entry.props.id);
    const prev = prevBlocksById.get(id);
    const hasBricks = tpl.content.has_bricks ?? false;

    // Two distinct child shapes meet here:
    //   - Mustache has_bricks: children is an array of PuckBrickEntry
    //     and goes into the `bricks` column.
    //   - Registry slot: children is a recursive tree and goes into
    //     content.children (JSON).
    let bricks: EditionBrick[] = [];
    let registryChildren: RegistryTreeEntry[] | undefined;

    if (hasBricks && Array.isArray(entry.props.children)) {
      bricks = (entry.props.children as ReadonlyArray<PuckBrickEntry>).map((br, brIdx) => {
        const brTpl = brickTplByType.get(br.type);
        if (!brTpl) {
          throw new Error(`unknown brick_type in PuckData: ${br.type}`);
        }
        const brickId = extractStableId(br.props.id);
        return {
          id: brickId,
          brick_template: brTpl,
          content: extractContent(br.props),
          sort_order: (brIdx + 1) * 1000,
        };
      });
    } else if (
      args.registry?.has(entry.type) &&
      entryHasSlot(args.registry.get(entry.type)) &&
      Array.isArray(entry.props.children)
    ) {
      registryChildren = (entry.props.children as ReadonlyArray<unknown>).map((child) =>
        serialiseTreeEntry(child, args.registry!),
      );
      // Carry over the previous block's bricks if any (registry blocks
      // never own bricks — a stable empty list is fine).
      bricks = prev?.bricks ?? [];
    } else {
      bricks = prev?.bricks ?? [];
    }

    const content = extractContent(entry.props);
    if (registryChildren !== undefined) {
      content.children = registryChildren;
    }

    return {
      id,
      block_template: tpl,
      content,
      sort_order: (idx + 1) * 1000,
      bricks,
    };
  });

  return { ...args.base, blocks: newBlocks };
}

// ---------------------------------------------------------------------------
// Registry-tree helpers
// ---------------------------------------------------------------------------

function entryHasSlot(entry: EmailBlockEntry | undefined): boolean {
  if (!entry) return false;
  const f = entry.fields as Record<string, { type?: string }> | undefined;
  return !!f && f.children?.type === 'slot';
}

/**
 * Trust-but-shape: convert an unknown JSON value into a RegistryTreeEntry.
 * Used on load (content.children → Puck props) so corrupted persisted
 * trees fail loud instead of crashing the renderer.
 */
function normaliseTreeEntry(value: unknown): RegistryTreeEntry {
  if (!value || typeof value !== 'object') {
    return { type: 'unknown', props: {} };
  }
  const v = value as { type?: unknown; props?: unknown };
  const type = typeof v.type === 'string' ? v.type : 'unknown';
  const propsRecord = v.props && typeof v.props === 'object' ? (v.props as Record<string, unknown>) : {};
  // Stamp an id so Puck round-trips the same identity. Children
  // recursively get the same treatment.
  const id = typeof propsRecord.id === 'string' ? propsRecord.id : freshUuid();
  const props: Record<string, unknown> = { ...propsRecord, id };
  const children = props.children;
  if (Array.isArray(children)) {
    props.children = children.map((c) => normaliseTreeEntry(c));
  }
  return { type, props };
}

/**
 * Walk a Puck tree entry (which may carry stable Puck-prefixed ids) and
 * emit a JSON-storable RegistryTreeEntry. Recurses into `props.children`
 * for nested slot containers.
 */
function serialiseTreeEntry(entry: unknown, registry: EmailBlockRegistry): RegistryTreeEntry {
  if (!entry || typeof entry !== 'object') {
    return { type: 'unknown', props: {} };
  }
  const e = entry as { type?: unknown; props?: unknown };
  const type = typeof e.type === 'string' ? e.type : 'unknown';
  const propsRecord =
    e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {};
  // Strip Puck-only structural fields except `id` (we keep that as the
  // stable identity) and `children` (recursive).
  const { children, variant_key, puck, editMode, ...rest } = propsRecord;
  void variant_key; void puck; void editMode;
  const stableId = extractStableId(rest.id);
  const out: Record<string, unknown> = { ...rest, id: stableId };
  // Recurse into children when this entry's registry definition has a
  // slot. Other entries' `children` (if any leaked through Puck) are
  // dropped — they'd be junk for non-slot leaf primitives.
  if (entryHasSlot(registry.get(type)) && Array.isArray(children)) {
    out.children = children.map((c) => serialiseTreeEntry(c, registry));
  }
  return { type, props: out };
}

// ---------------------------------------------------------------------------

function extractContent(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (STRUCTURAL_PROPS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Coerce a Puck-generated id to a stable UUID string suitable for the
 * `newsletters_edition_blocks.id` UUID column.
 *
 * Puck inserts new components with id of the form `<componentType>-<uuid>`
 * (e.g. `heading-0b1315d9-d921-4e22-b68d-42c70bd19391`). The DB column is
 * UUID — passing the prefixed string fails with `22P02 invalid input
 * syntax for type uuid`. Extract the UUID portion, which is the stable
 * piece across Puck onChange firings within a session.
 *
 * For ids that already ARE a bare UUID (round-tripped from a previous
 * load), the regex matches the whole string. For non-UUID strings or
 * non-string ids (defensive), falls back to a fresh UUID.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractStableId(maybeId: unknown): string {
  if (typeof maybeId === 'string') {
    const m = maybeId.match(UUID_RE);
    if (m) return m[0];
  }
  return freshUuid();
}

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback uuid-v4-shape for non-browser test environments.
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-${s.slice(16,20)}-${s.slice(20,32)}`;
}
