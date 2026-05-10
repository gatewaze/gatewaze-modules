/**
 * Action-bar button rendered inside Puck's contextual chrome around
 * the selected component. Clicking it serialises the current
 * selection's subtree (including recursive `props.children` for slot
 * containers) and asks the toolbar's save modal — via the shared
 * UserBlocksContext — to open with the tree pre-populated.
 *
 * Why an action-bar button rather than a toolbar item: the toolbar
 * sits outside the Puck React tree, so it can't reach `usePuck()` for
 * the selected item. Puck's `actionBar` override IS rendered inside
 * Puck's context — `usePuck()` works there, and the affordance is
 * visually attached to whichever block the operator clicked.
 */
import { useGetPuck } from '@puckeditor/core';
import { BookmarkIcon } from '@heroicons/react/24/outline';
import { useUserBlocks } from './UserBlocksContext.js';

interface PuckItem {
  type?: unknown;
  props?: unknown;
}

export function SaveAsBlockAction() {
  // useGetPuck (vs usePuck) returns a getter so we read appState only
  // at click time. usePuck would subscribe to every Puck state change
  // — re-rendering this button on every keystroke in the canvas.
  // Puck's dev-mode warning ("usePuck without a selector — unnecessary
  // re-renders") flagged this on the live editor.
  const getPuck = useGetPuck();
  const userBlocks = useUserBlocks();

  const onClick = () => {
    const puck = getPuck();
    const selected = puck.selectedItem as PuckItem | null | undefined;
    if (!selected || typeof selected.type !== 'string') return;
    const props = selected.props && typeof selected.props === 'object'
      ? (selected.props as Record<string, unknown>)
      : {};
    // Strip Puck-only structural keys; keep `id` so saved trees retain
    // their stable ids (we replace them with fresh uuids on insert).
    const { variant_key, puck: _puck, editMode, ...rest } = props as Record<string, unknown>;
    void variant_key; void _puck; void editMode;
    userBlocks.requestSave({ type: selected.type, props: rest });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Save block to My Blocks"
      title="Save this block (and its contents) to My Blocks"
      style={{
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        padding: 0,
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <BookmarkIcon style={{ width: 16, height: 16 }} />
    </button>
  );
}
