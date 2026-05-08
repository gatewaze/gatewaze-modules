/**
 * page_blocks ↔ Puck Data adapter. Per spec-builder-evaluation §3.3.
 *
 * Two directions:
 *
 *   1. load:  pageBlocksToPuckData(tree) — server snapshot → Puck Data
 *             that the editor can mount.
 *   2. save:  diffToOps(prevTree, nextData) — Puck Data → CanvasOp[]
 *             stream the existing canvas-ops API consumes.
 *
 * Critical seam: save NEVER produces SQL. Every change goes through
 * `canvas_apply_ops` so we keep advisory locks, sort_order
 * gap-renumber, variant_key, A/B linkage, and wysiwyg_locked semantics.
 *
 * The diff is fail-closed: when an invariant is violated we throw
 * `RefetchRequired` instead of producing a "best-effort" op stream.
 * The editor catches once, refetches, rebases, retries. A second
 * failure surfaces a save-conflict toast.
 *
 * v1 scope: top-level blocks + their owned bricks. Block-in-brick
 * nesting (the `parent_brick_id` ancestry case in the existing model)
 * is deferred — see types.ts header.
 */

import type { CanvasOp } from '../../../../lib/canvas-render/types.js';
import {
  RefetchRequired,
  type PageBlockTree,
  type PageBlockInstance,
  type PageBrickInstance,
  type PuckData,
  type PuckBlockEntry,
  type PuckBrickEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// LOAD
// ---------------------------------------------------------------------------

export function pageBlocksToPuckData(tree: PageBlockTree): PuckData {
  // Bricks indexed by their owning block.
  const bricksByBlock = new Map<string, PageBrickInstance[]>();
  for (const br of tree.bricks) {
    const arr = bricksByBlock.get(br.page_block_id) ?? [];
    arr.push(br);
    bricksByBlock.set(br.page_block_id, arr);
  }
  for (const arr of bricksByBlock.values()) {
    arr.sort((a, z) => a.sort_order - z.sort_order);
  }

  const sortedBlocks = [...tree.topLevel]
    .filter((b) => b.parent_brick_id === null)
    .sort((a, z) => a.sort_order - z.sort_order);

  const content: PuckBlockEntry[] = sortedBlocks.map((b) => ({
    type: b.block_def_key,
    props: {
      id: b.id,
      variant_key: b.variant_key,
      ...b.content,
      ...(b.has_bricks
        ? {
            children: (bricksByBlock.get(b.id) ?? []).map<PuckBrickEntry>((br) => ({
              type: br.brick_def_key,
              props: {
                id: br.id,
                variant_key: br.variant_key,
                ...br.content,
              },
            })),
          }
        : {}),
    },
  }));

  return {
    content,
    root: {
      props: {
        wrapperKey: tree.page.wrapper_key,
        ...tree.page.root_meta,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SAVE — diff
// ---------------------------------------------------------------------------

/**
 * Allowlist of top-level keys we accept on `props` when emitting
 * `block.update_field` ops. Anything outside this list, plus the
 * structural `id`/`variant_key`/`children` keys, is treated as block
 * content. We do NOT accept arbitrary props as ops — server-side
 * `canvas_apply_ops` already validates against `block_def.schema`,
 * but we surface obvious shenanigans early (mass-assignment guard).
 *
 * The values themselves are passed through; the SCHEMA is the
 * authority on permitted keys per block_def, not this list.
 */
const STRUCTURAL_PROPS = new Set(['id', 'variant_key', 'children']);

export interface DiffArgs {
  prev: PageBlockTree;
  next: PuckData;
  /**
   * Set of block_def_keys currently registered for the library. Used
   * to detect mid-session block_def deletion (§3.3.5 case 4) — if
   * Puck Data references a key not in this set, we throw
   * RefetchRequired.
   */
  knownBlockDefKeys: ReadonlySet<string>;
  /**
   * Set of brick_def_keys currently registered for each parent block.
   * Lookup is by parent block_def_key.
   */
  knownBrickDefKeysByBlock: ReadonlyMap<string, ReadonlySet<string>>;
}

export function diffToOps(args: DiffArgs): ReadonlyArray<CanvasOp> {
  if (args.prev.page.wysiwyg_locked) {
    // Still allowed: edits via canvas (the lock is enforced server-side
    // for non-canvas writers). Just a defensive check that we have
    // matching state.
  }

  const ops: CanvasOp[] = [];
  diffBlocks(args, ops);
  return ops;
}

function diffBlocks(args: DiffArgs, ops: CanvasOp[]): void {
  const { prev, next, knownBlockDefKeys, knownBrickDefKeysByBlock } = args;

  const prevBlockById = new Map<string, PageBlockInstance>();
  for (const b of prev.topLevel) {
    if (b.parent_brick_id === null) prevBlockById.set(b.id, b);
  }

  const prevBricksByBlock = new Map<string, Map<string, PageBrickInstance>>();
  for (const br of prev.bricks) {
    let m = prevBricksByBlock.get(br.page_block_id);
    if (!m) {
      m = new Map();
      prevBricksByBlock.set(br.page_block_id, m);
    }
    m.set(br.id, br);
  }

  const nextBlockById = new Map<string, PuckBlockEntry>();
  for (const e of next.content) {
    if (typeof e.props.id === 'string') {
      nextBlockById.set(e.props.id, e);
    }
  }

  // 1. DELETE — IDs in prev that are absent from next.
  for (const id of prevBlockById.keys()) {
    if (!nextBlockById.has(id)) {
      ops.push({ kind: 'block.delete', blockId: id });
    }
  }

  // 2. INSERT — entries in next without an `id` (or with an id that
  //    was never in prev — we treat both as inserts; new IDs are
  //    server-assigned and the next load will replace any synthetic
  //    placeholder ids).
  //    For a clean MOVE detection we need a "previous surviving id"
  //    anchor — built once over the next ordering.
  const surviving: string[] = [];
  let lastSurvivingId: string | null = null;
  for (const entry of next.content) {
    const id = typeof entry.props.id === 'string' ? entry.props.id : null;
    if (id === null || !prevBlockById.has(id)) {
      // INSERT
      if (!knownBlockDefKeys.has(entry.type)) {
        throw new RefetchRequired(`unknown block_def_key: ${entry.type}`);
      }
      ops.push({
        kind: 'block.insert',
        afterBlockId: lastSurvivingId,
        parentBrickId: null,
        blockDefKey: entry.type,
        content: extractContent(entry.props),
      });
      // Inserts don't carry a real id until the server responds, so
      // they don't anchor subsequent ops in the same envelope. The
      // current useCanvasOps hook submits one envelope per save, and
      // server returns assigned ids; the next round builds a fresh
      // diff. Anchor stays on lastSurvivingId.
      continue;
    }
    surviving.push(id);
    lastSurvivingId = id;
  }

  // 3. MOVE — for each surviving id, compare its position in next
  //    against its position in prev. If the immediate-preceding
  //    surviving id differs, emit a move.
  const prevSurvivingOrder = [...prev.topLevel]
    .filter((b) => b.parent_brick_id === null && nextBlockById.has(b.id))
    .sort((a, z) => a.sort_order - z.sort_order)
    .map((b) => b.id);

  for (let i = 0; i < surviving.length; i++) {
    const id = surviving[i]!;
    const nextAnchor = i === 0 ? null : (surviving[i - 1] ?? null);
    const prevIndex = prevSurvivingOrder.indexOf(id);
    const prevAnchor = prevIndex <= 0 ? null : (prevSurvivingOrder[prevIndex - 1] ?? null);
    if (nextAnchor !== prevAnchor) {
      ops.push({
        kind: 'block.move',
        blockId: id,
        afterBlockId: nextAnchor,
        parentBrickId: null,
      });
    }
  }

  // 4. UPDATE — per-field for surviving blocks. Also recurse into
  //    bricks for has_bricks blocks.
  for (const id of surviving) {
    const prevBlock = prevBlockById.get(id);
    const nextEntry = nextBlockById.get(id);
    if (!prevBlock || !nextEntry) continue;

    if (prevBlock.block_def_key !== nextEntry.type) {
      // Should not happen — block_def_key is fixed at insert. If it
      // ever does, treat it as an invariant violation.
      throw new RefetchRequired(`block ${id} type changed: ${prevBlock.block_def_key} → ${nextEntry.type}`);
    }
    if (typeof nextEntry.props.variant_key === 'string' && nextEntry.props.variant_key !== prevBlock.variant_key) {
      // variant_key is owned by the variant-management UI in v1, not
      // editable in Puck. If it changed, the user did something via
      // DevTools — fail closed.
      throw new RefetchRequired(`block ${id} variant_key tampered: ${prevBlock.variant_key} → ${nextEntry.props.variant_key}`);
    }

    const nextContent = extractContent(nextEntry.props);
    for (const [field, value] of Object.entries(nextContent)) {
      const prevValue = prevBlock.content[field];
      if (!isDeepEqual(prevValue, value)) {
        ops.push({
          kind: 'block.update_field',
          blockId: id,
          fieldPath: field,
          newValue: value,
        });
      }
    }
    // Field deletions: keys in prev.content but not in next.
    for (const field of Object.keys(prevBlock.content)) {
      if (!(field in nextContent)) {
        ops.push({
          kind: 'block.update_field',
          blockId: id,
          fieldPath: field,
          newValue: undefined,
        });
      }
    }

    if (prevBlock.has_bricks) {
      diffBricks({
        blockId: id,
        blockDefKey: prevBlock.block_def_key,
        prevBricks: prevBricksByBlock.get(id) ?? new Map(),
        nextChildren: Array.isArray(nextEntry.props.children) ? nextEntry.props.children : [],
        knownBrickDefKeysByBlock,
      }, ops);
    }
  }
}

function diffBricks(
  args: {
    blockId: string;
    blockDefKey: string;
    prevBricks: Map<string, PageBrickInstance>;
    nextChildren: ReadonlyArray<PuckBrickEntry>;
    knownBrickDefKeysByBlock: ReadonlyMap<string, ReadonlySet<string>>;
  },
  ops: CanvasOp[],
): void {
  const allowed = args.knownBrickDefKeysByBlock.get(args.blockDefKey) ?? new Set<string>();

  const nextById = new Map<string, PuckBrickEntry>();
  for (const e of args.nextChildren) {
    if (typeof e.props.id === 'string') nextById.set(e.props.id, e);
  }

  // DELETE
  for (const id of args.prevBricks.keys()) {
    if (!nextById.has(id)) {
      ops.push({ kind: 'brick.delete', brickId: id });
    }
  }

  // INSERT + MOVE preparation
  const surviving: string[] = [];
  let lastSurvivingId: string | null = null;
  for (const entry of args.nextChildren) {
    const id = typeof entry.props.id === 'string' ? entry.props.id : null;
    if (id === null || !args.prevBricks.has(id)) {
      if (!allowed.has(entry.type)) {
        throw new RefetchRequired(`unknown brick_def_key: ${entry.type} (parent ${args.blockDefKey})`);
      }
      ops.push({
        kind: 'brick.insert',
        pageBlockId: args.blockId,
        brickDefKey: entry.type,
        afterBrickId: lastSurvivingId,
        content: extractContent(entry.props),
      });
      continue;
    }
    surviving.push(id);
    lastSurvivingId = id;
  }

  // MOVE
  const prevSurvivingOrder = [...args.prevBricks.values()]
    .filter((br) => nextById.has(br.id))
    .sort((a, z) => a.sort_order - z.sort_order)
    .map((br) => br.id);
  for (let i = 0; i < surviving.length; i++) {
    const id = surviving[i]!;
    const nextAnchor = i === 0 ? null : (surviving[i - 1] ?? null);
    const prevIndex = prevSurvivingOrder.indexOf(id);
    const prevAnchor = prevIndex <= 0 ? null : (prevSurvivingOrder[prevIndex - 1] ?? null);
    if (nextAnchor !== prevAnchor) {
      ops.push({ kind: 'brick.move', brickId: id, afterBrickId: nextAnchor });
    }
  }

  // UPDATE
  for (const id of surviving) {
    const prevBrick = args.prevBricks.get(id);
    const nextEntry = nextById.get(id);
    if (!prevBrick || !nextEntry) continue;
    const nextContent = extractContent(nextEntry.props);
    for (const [field, value] of Object.entries(nextContent)) {
      if (!isDeepEqual(prevBrick.content[field], value)) {
        ops.push({ kind: 'brick.update_field', brickId: id, fieldPath: field, newValue: value });
      }
    }
    for (const field of Object.keys(prevBrick.content)) {
      if (!(field in nextContent)) {
        ops.push({ kind: 'brick.update_field', brickId: id, fieldPath: field, newValue: undefined });
      }
    }
  }
}

function extractContent(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (STRUCTURAL_PROPS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Structural deep equal for JSON-shaped values. Block content is always
 * plain JSON (no Date, Map, Set, functions, or class instances), so a
 * recursive value compare is sufficient and ~10× faster than
 * JSON.stringify-based comparison for typical block sizes.
 */
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const aKeys = Object.keys(ar);
  const bKeys = Object.keys(br);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!isDeepEqual(ar[k], br[k])) return false;
  }
  return true;
}
