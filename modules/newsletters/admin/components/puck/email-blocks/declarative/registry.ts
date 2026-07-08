/**
 * Build the per-edition email-block registry: the static hand-coded
 * react-email registry, plus any `render_kind='declarative'` blocks for this
 * newsletter (parsed from their html-ish source into EmailBlockEntry). The
 * combined map is used by the editor (Puck config) and the export/publish
 * render, so a git-authored declarative block behaves exactly like a
 * hand-coded one.
 *
 * Additive + safe: a newsletter with no declarative blocks gets the static
 * registry back by reference (identical behaviour — e.g. mlops/aaif).
 */

import { emailBlockRegistry } from '../index.js';
import type { EmailBlockEntry, EmailBlockRegistry } from '../registry-types.js';
import { declarativeBlockEntry } from './from-template.js';

interface DeclarativeSource {
  block_type?: string;
  brick_type?: string;
  name?: string;
  render_kind?: string;
  /**
   * Present on `render_kind='react-email'` rows (selected as a column, equal to
   * `block_type` for these). Lets us look the block up in the static
   * `emailBlockRegistry` when merging react-email blocks into a git-driven
   * newsletter's registry (see `addReactEmail`).
   */
  component_id?: string;
  content?: {
    html_template?: string;
    /**
     * The block's field schema, already extracted from the source file's
     * `<!-- SCHEMA: ... -->` comment by the server-side
     * `templates_apply_source` RPC. The HTML stored in `html_template` has
     * the comment stripped, so without this column the editor's parse step
     * can't recover the schema. The newsletter editor's loadTemplates
     * populates this from the `templates_block_defs.schema` JSONB column.
     */
    schema?: Record<string, unknown>;
  };
}

function addDeclarative(merged: Map<string, EmailBlockEntry>, items: ReadonlyArray<DeclarativeSource>): void {
  for (const t of items) {
    const id = t.block_type ?? t.brick_type;
    if (!id || t.render_kind !== 'declarative' || !t.content?.html_template) continue;
    try {
      const entry = declarativeBlockEntry({
        componentId: id,
        label: t.name ?? id,
        category: 'Template',
        source: t.content.html_template,
        // Pass the DB schema explicitly. parseTemplate() will only see a
        // SCHEMA comment if it's still present in the html source — which
        // it isn't, because templates_apply_source extracts it server-side
        // before storing the html column. Without this override every
        // declarative block lands in the editor with zero fields.
        ...(t.content.schema && Object.keys(t.content.schema).length > 0
          ? { schema: t.content.schema }
          : {}),
      });
      merged.set(entry.componentId, entry);
    } catch (err) {
      // A malformed declarative block/brick shouldn't break the editor — skip
      // it (shows as unconfigured) and log for the operator.
      // eslint-disable-next-line no-console
      console.warn('[declarative] failed to build', id, err);
    }
  }
}

/**
 * @param blockTemplates per-newsletter block defs (declarative ones are added)
 * @param brickTemplates per-newsletter brick defs (declarative ones are added,
 *        so slot containers can resolve their bricks)
 *
 * Behaviour:
 *   - Newsletter has a connected git source (any declarative block_def present
 *     in `blockTemplates`/`brickTemplates`): the editor's block library is
 *     fully controlled by the git repo. We return ONLY the declarative
 *     entries — the static hand-coded React-Email blocks (Hero, CTACard,
 *     IntroParagraph, …) are intentionally suppressed so they don't shadow,
 *     compete with, or duplicate git-authored ones.
 *   - Newsletter has no git source yet: fall back to the static built-in
 *     registry so the editor still has something to render. Once the
 *     boilerplate-git-repo feature lands every newsletter will pull its
 *     blocks from a repo and this fallback can be removed.
 */
export function buildEmailRegistry(
  blockTemplates: ReadonlyArray<DeclarativeSource>,
  brickTemplates: ReadonlyArray<DeclarativeSource> = [],
): EmailBlockRegistry {
  const hasDeclarative =
    blockTemplates.some((t) => t.render_kind === 'declarative' && t.content?.html_template) ||
    brickTemplates.some((t) => t.render_kind === 'declarative' && t.content?.html_template);
  if (!hasDeclarative) return emailBlockRegistry;

  const merged = new Map<string, EmailBlockEntry>();
  addDeclarative(merged, blockTemplates);
  addDeclarative(merged, brickTemplates);
  // React-email blocks can't be expressed declaratively (dynamic, send-time
  // data — e.g. Local/Virtual Events). A newsletter opts one in by seeding a
  // `render_kind='react-email'` block_def; we surface its static-registry
  // Component alongside the git-authored declarative blocks so it's available
  // in the editor AND resolves on the publish/send path. Without this, the
  // hasDeclarative branch would silently drop it.
  addReactEmail(merged, blockTemplates);
  addReactEmail(merged, brickTemplates);
  return merged;
}

/**
 * Merge `render_kind='react-email'` block_defs by pulling their Component from
 * the static `emailBlockRegistry` (keyed by component_id, which equals
 * block_type for these rows). Unknown ids are skipped — a seeded block_def with
 * no matching registry entry simply doesn't appear (safe, non-fatal).
 */
function addReactEmail(merged: Map<string, EmailBlockEntry>, items: ReadonlyArray<DeclarativeSource>): void {
  for (const t of items) {
    if (t.render_kind !== 'react-email') continue;
    const id = t.component_id ?? t.block_type ?? t.brick_type;
    if (!id || merged.has(id)) continue;
    const entry = emailBlockRegistry.get(id);
    if (entry) merged.set(id, entry);
  }
}
