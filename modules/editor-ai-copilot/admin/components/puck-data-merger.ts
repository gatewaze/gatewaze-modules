/**
 * Pure merger — takes the AI's response and the existing Puck Data
 * and produces a new Data shape according to the mode.
 *
 * No I/O, no React imports. Easy to unit-test.
 *
 * Per spec-canvas-ai-copilot.md §3.6.
 */

export interface PuckBlockEntry {
  type: string;
  props: { id: string; [k: string]: unknown };
}

export interface PuckData {
  content: ReadonlyArray<PuckBlockEntry>;
  root: { props: Record<string, unknown> };
}

export type MergeMode = 'replace' | 'append' | 'insert-after' | 'edit' | 'edit-block';

export interface MergeArgs {
  mode: MergeMode;
  prev: PuckData;
  /** What the server returned. For edit-block, content[0] is the new state of the target block. */
  ai: PuckData;
  anchorBlockId?: string;
  blockId?: string;
}

export interface MergeWarning {
  code: string;
  message: string;
}

export interface MergeResult {
  data: PuckData;
  warnings: MergeWarning[];
}

function ensureId(b: PuckBlockEntry): PuckBlockEntry {
  if (b.props.id) return b;
  return { ...b, props: { ...b.props, id: newId() } };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback.
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)] ?? '';
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function mergeAiResponse(args: MergeArgs): MergeResult {
  switch (args.mode) {
    case 'replace':
      return {
        data: {
          content: args.ai.content.map(ensureId),
          root: args.prev.root,
        },
        warnings: [],
      };
    case 'append':
      return {
        data: {
          content: [...args.prev.content, ...args.ai.content.map(ensureId)],
          root: args.prev.root,
        },
        warnings: [],
      };
    case 'insert-after': {
      if (!args.anchorBlockId) {
        return {
          data: {
            content: [...args.prev.content, ...args.ai.content.map(ensureId)],
            root: args.prev.root,
          },
          warnings: [{ code: 'missing_anchor', message: 'insert-after without anchorBlockId; appended at end' }],
        };
      }
      const idx = args.prev.content.findIndex((b) => b.props.id === args.anchorBlockId);
      if (idx < 0) {
        return {
          data: {
            content: [...args.prev.content, ...args.ai.content.map(ensureId)],
            root: args.prev.root,
          },
          warnings: [{ code: 'anchor_not_found', message: `anchor ${args.anchorBlockId} not found; appended at end` }],
        };
      }
      return {
        data: {
          content: [
            ...args.prev.content.slice(0, idx + 1),
            ...args.ai.content.map(ensureId),
            ...args.prev.content.slice(idx + 1),
          ],
          root: args.prev.root,
        },
        warnings: [],
      };
    }
    case 'edit': {
      // For each AI entry: if its id matches an existing block → update.
      // For each AI entry without id → fresh insert at that position.
      // Existing blocks omitted from AI output → delete.
      // Final order is the AI's order.
      const warnings: MergeWarning[] = [];
      const out: PuckBlockEntry[] = args.ai.content.map((aiBlock) => {
        if (aiBlock.props.id) {
          const existing = args.prev.content.find((p) => p.props.id === aiBlock.props.id);
          if (existing) {
            // Preserve everything we own (variant_key etc.); AI owns props.
            return aiBlock;
          }
          warnings.push({ code: 'ai_unmatched_id', message: `AI sent id ${aiBlock.props.id} not on this page; treated as insert` });
          return ensureId({ ...aiBlock, props: { ...aiBlock.props, id: newId() } });
        }
        return ensureId(aiBlock);
      });
      // Deletes: anything in prev not in out.
      const aiIds = new Set(out.map((b) => b.props.id));
      const droppedCount = args.prev.content.filter((b) => !aiIds.has(b.props.id)).length;
      if (droppedCount > 0) {
        warnings.push({ code: 'edit_dropped_blocks', message: `${droppedCount} block(s) removed in edit` });
      }
      return { data: { content: out, root: args.prev.root }, warnings };
    }
    case 'edit-block': {
      if (!args.blockId) {
        return {
          data: args.prev,
          warnings: [{ code: 'missing_blockId', message: 'edit-block called without blockId; no merge' }],
        };
      }
      const aiBlock = args.ai.content[0];
      if (!aiBlock) {
        return {
          data: args.prev,
          warnings: [{ code: 'edit_block_empty_response', message: 'edit-block returned no block' }],
        };
      }
      const result = replaceBlockInPlace(args.prev.content, args.blockId, aiBlock);
      if (!result.found) {
        return {
          data: args.prev,
          warnings: [{ code: 'block_not_found_at_merge', message: `block ${args.blockId} not found in current data — was it deleted?` }],
        };
      }
      return { data: { content: result.content, root: args.prev.root }, warnings: [] };
    }
  }
}

interface ReplaceResult {
  found: boolean;
  content: PuckBlockEntry[];
}

function replaceBlockInPlace(
  content: ReadonlyArray<PuckBlockEntry>,
  blockId: string,
  newBlock: PuckBlockEntry,
): ReplaceResult {
  let found = false;
  const next = content.map((b) => {
    if (b.props.id === blockId) {
      found = true;
      // Preserve the id, swap props.
      return { type: b.type, props: { ...newBlock.props, id: blockId } };
    }
    // Recurse into children for nested bricks.
    if (Array.isArray(b.props.children)) {
      const child = replaceBlockInPlace(b.props.children as PuckBlockEntry[], blockId, newBlock);
      if (child.found) {
        found = true;
        return { ...b, props: { ...b.props, children: child.content } };
      }
    }
    return b;
  });
  return { found, content: next };
}
