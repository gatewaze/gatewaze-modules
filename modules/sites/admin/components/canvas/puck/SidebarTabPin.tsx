/**
 * Keeps the LEFT sidebar tab on the operator's choice (AI / Blocks / Outline)
 * when a block is selected.
 *
 * Puck tracks one active left-sidebar tab in `ui.plugin.current`. Selecting a
 * block flips it to the Fields plugin ("fields"); with Fields configured to the
 * right sidebar, that just empties the left (its Fields panel is CSS-hidden).
 * The RIGHT Fields panel is driven by the selection independently, so restoring
 * the left tab to its previous value does NOT hide the right panel.
 *
 * Mount: via `overrides.headerActions` — it's always in the React tree (the
 * header is only CSS-hidden) and is a LEAF, so this watcher's re-renders don't
 * touch the editor subtree. (Mounting via `overrides.puck` wrapped the whole
 * editor and reset inputs on every keystroke — do not do that.)
 *
 * Renders nothing.
 */

import { useEffect, useRef } from 'react';
import { usePuck } from '@puckeditor/core';

const FIELDS_PLUGIN = 'fields';

export function SidebarTabPin(): null {
  const puck = usePuck() as unknown as {
    appState?: {
      ui?: {
        plugin?: { current?: string } | null;
        rightSideBarVisible?: boolean;
      };
    };
    dispatch: (action: Record<string, unknown>) => void;
  };
  const current = puck.appState?.ui?.plugin?.current;
  const rightVisible = puck.appState?.ui?.rightSideBarVisible;
  const dispatch = puck.dispatch;
  const lastNonFields = useRef<string>('blocks');

  useEffect(() => {
    if (!current) return;
    if (current !== FIELDS_PLUGIN) {
      lastNonFields.current = current; // remember the operator's chosen tab
      return;
    }
    // current === 'fields': selecting a block flipped the left tab. Restore the
    // previous tab so the left keeps showing Blocks/AI/Outline. Only in the
    // two-rail desktop mode (rightSideBarVisible); on mobile the left fields tab
    // is intended. The right Fields panel is unaffected (driven by selection).
    if (!rightVisible) return;
    const restore = lastNonFields.current !== FIELDS_PLUGIN ? lastNonFields.current : 'blocks';
    dispatch({ type: 'setUi', ui: { plugin: { current: restore } } });
  }, [current, rightVisible, dispatch]);

  return null;
}
