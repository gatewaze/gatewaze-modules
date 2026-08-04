/**
 * Project-avatar resolution — the pure branch behind the SE module's outline-icon pass (issue #27).
 *
 * A project's `avatar_emoji` is a user-configurable field (Setup panel → `se_projects.avatar_emoji`).
 * When set, we honour the operator's chosen emoji; when empty/null we fall back to a monochrome
 * outline `FolderIcon` (rendered by <ProjectAvatar>) so the mark matches the rest of admin instead
 * of an OS-coloured `📁` emoji. This module holds only the decision + the plain-text label used in
 * <select><option> contexts (which cannot render SVG) so both can be unit-tested under vitest's
 * `node` environment without heroicons/jsdom in the module's dependency graph.
 */

export type ProjectAvatarResolution =
  | { kind: 'emoji'; value: string }
  | { kind: 'icon' };

/** Trim so an all-whitespace stored value falls through to the outline icon, not a blank span. */
export function resolveProjectAvatar(emoji?: string | null): ProjectAvatarResolution {
  const trimmed = typeof emoji === 'string' ? emoji.trim() : '';
  return trimmed ? { kind: 'emoji', value: trimmed } : { kind: 'icon' };
}

/**
 * Label for a `<select><option>` row. Options are plain text (no SVG possible), so we keep a
 * user-set emoji as a prefix but drop the `📁` default entirely rather than leave an inconsistent
 * coloured glyph in the dropdown.
 */
export function projectOptionLabel(emoji: string | null | undefined, name: string | null | undefined): string {
  const resolved = resolveProjectAvatar(emoji);
  const label = name ?? '';
  return resolved.kind === 'emoji' ? `${resolved.value} ${label}`.trim() : label;
}
