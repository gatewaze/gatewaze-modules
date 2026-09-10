/**
 * Whether a keypress should delete the selected table.
 *
 * The board is full of text fields — the table name, its dimensions, the guest
 * search — where Backspace means "delete a character". Getting this wrong eats
 * people's typing, so the decision lives here on its own and is tested
 * directly rather than inferred from the component.
 */

const TEXT_ENTRY_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

export interface DeleteShortcutState {
  /** A table or guest is mid-drag; Escape is the way out of that, not Backspace. */
  dragging: boolean;
  /** A dialog owns the keyboard. */
  dialogOpen: boolean;
  /** Nothing selected, nothing to delete. */
  hasSelection: boolean;
}

export function isDeleteTableShortcut(
  event: Pick<KeyboardEvent, 'key'> & { target: EventTarget | null },
  state: DeleteShortcutState,
): boolean {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
  if (!state.hasSelection || state.dragging || state.dialogOpen) return false;

  const el = event.target as HTMLElement | null;
  if (!el) return true;
  if (typeof el.tagName === 'string' && TEXT_ENTRY_TAGS.includes(el.tagName)) return false;

  // `isContentEditable` is the direct answer and handles inheritance, but it
  // is not implemented everywhere (jsdom, for one), so fall back to walking up
  // for an editable ancestor rather than trusting a possibly-absent property.
  if (el.isContentEditable) return false;
  if (typeof el.closest === 'function'
      && el.closest('[contenteditable]:not([contenteditable="false"])')) {
    return false;
  }

  return true;
}
