/**
 * The one editor change spec §5.2 asks for. When `newsletters_save_edition`
 * refuses with version_conflict, the editor refetches the edition's blocks
 * and compares them with the snapshot it loaded (or last saved). If the ONLY
 * differences are the research layer of research blocks and/or their
 * `research_edits`, those fields are adopted into the in-memory blocks, the
 * new version is adopted, and the save is retried with the author's other
 * dirty state intact. Any other difference falls back to the reload toast.
 *
 * Pure; the page owns the fetching.
 */

export interface SnapshotBlock {
  id: string;
  content: Record<string, unknown>;
  sort_order: number;
  templates_block_def_id?: string | null;
}

export interface ResearchFieldReplacement {
  block_id: string;
  /** The research layer's field name and its fresh value (present when it changed). */
  field?: string;
  research?: unknown;
  /** Present when the edit layer changed. */
  research_edits?: unknown;
}

export interface ResearchDiff {
  /** True when every difference is a research field or an edit layer of a research block. */
  only_research: boolean;
  replacements: ResearchFieldReplacement[];
  /** Why not, for the console. */
  reason?: string;
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return v === undefined ? 'undefined' : JSON.stringify(v);
};

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * @param loaded   the blocks as last synced with the server (stored shape)
 * @param fresh    the blocks just refetched (stored shape)
 * @param researchFieldByBlock  block id → the binding's output field, for research blocks only
 */
export function diffResearchOnly(
  loaded: SnapshotBlock[],
  fresh: SnapshotBlock[],
  researchFieldByBlock: Record<string, string>,
): ResearchDiff {
  const no = (reason: string): ResearchDiff => ({ only_research: false, replacements: [], reason });
  if (loaded.length !== fresh.length) return no(`block count ${loaded.length} → ${fresh.length}`);
  const freshById = new Map(fresh.map((b) => [b.id, b]));
  // Equal counts are not equal sets: a duplicated id on either side, or a
  // fresh block the snapshot never had, is a structural change.
  const loadedIds = new Set(loaded.map((b) => b.id));
  if (loadedIds.size !== loaded.length || freshById.size !== fresh.length) return no('duplicate block ids');
  for (const b of fresh) if (!loadedIds.has(b.id)) return no(`block ${b.id} is new`);
  const replacements: ResearchFieldReplacement[] = [];

  for (const a of loaded) {
    const b = freshById.get(a.id);
    if (!b) return no(`block ${a.id} is gone`);
    if (a.sort_order !== b.sort_order) return no(`block ${a.id} moved`);
    if ((a.templates_block_def_id ?? null) !== (b.templates_block_def_id ?? null)) return no(`block ${a.id} changed template`);

    const field = researchFieldByBlock[a.id];
    const ac = a.content ?? {};
    const bc = b.content ?? {};
    const keys = new Set([...Object.keys(ac), ...Object.keys(bc)]);
    const rep: ResearchFieldReplacement = { block_id: a.id };
    let changed = false;
    for (const k of keys) {
      if (same(ac[k], bc[k])) continue;
      if (!field) return no(`block ${a.id}.${k} changed and it is not a research block`);
      if (k === field) { rep.field = field; rep.research = bc[k]; changed = true; continue; }
      if (k === 'research_edits') { rep.research_edits = bc[k]; changed = true; continue; }
      return no(`block ${a.id}.${k} changed`);
    }
    if (changed) replacements.push(rep);
  }
  return { only_research: true, replacements };
}

/** Apply replacements to the in-memory blocks (any shape with id + content), returning new objects. */
export function applyResearchReplacements<B extends { id: string; content: Record<string, unknown> }>(
  blocks: B[],
  replacements: ResearchFieldReplacement[],
  mapResearch: (v: unknown) => unknown = (v) => v,
): B[] {
  const byId = new Map(replacements.map((r) => [r.block_id, r]));
  return blocks.map((b) => {
    const r = byId.get(b.id);
    if (!r) return b;
    const content = { ...b.content };
    if (r.field) content[r.field] = mapResearch(r.research);
    if ('research_edits' in r) {
      if (r.research_edits === undefined) delete content.research_edits;
      else content.research_edits = r.research_edits;
    }
    return { ...b, content };
  });
}
