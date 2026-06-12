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
  block_type: string;
  name?: string;
  render_kind?: string;
  content?: { html_template?: string };
}

export function buildEmailRegistry(blockTemplates: ReadonlyArray<DeclarativeSource>): EmailBlockRegistry {
  const declarative = blockTemplates.filter(
    (t) => t.render_kind === 'declarative' && !!t.content?.html_template,
  );
  if (declarative.length === 0) return emailBlockRegistry;

  const merged = new Map<string, EmailBlockEntry>(emailBlockRegistry);
  for (const t of declarative) {
    try {
      const entry = declarativeBlockEntry({
        componentId: t.block_type,
        label: t.name ?? t.block_type,
        category: 'Template',
        source: t.content!.html_template!,
      });
      merged.set(entry.componentId, entry);
    } catch (err) {
      // A malformed declarative block shouldn't break the whole editor — skip
      // it (the block falls through to the mustache/registry path or shows as
      // unconfigured) and log for the operator.
      // eslint-disable-next-line no-console
      console.warn('[declarative] failed to build block', t.block_type, err);
    }
  }
  return merged;
}
