/**
 * Keeps the LEFT sidebar tab pinned to the operator's choice (AI / Blocks /
 * Outline) when a block is selected.
 *
 * Why: Puck tracks one active left-sidebar tab in `ui.plugin.current`, shared by
 * the nav rail and the left panels. Selecting a block flips it to the Fields
 * plugin ("fields"). With Fields configured to the *right* sidebar
 * (desktopSideBar:'right'), that fields tab is mobile-only on the left — but its
 * panel still activates there on desktop, so the left rail switches to Fields
 * even though the operator was on Blocks/AI/Outline. (See CanvasShell.)
 *
 * This watcher restores the last non-Fields tab whenever selection flips the
 * left tab to "fields", but only in the two-rail desktop mode
 * (rightSideBarVisible) — on mobile the fields tab legitimately lives on the
 * left, so we leave it alone. The right Fields panel is driven separately, so
 * pinning the left tab doesn't hide it.
 *
 * Renders nothing; mounted always via `overrides.puck`.
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
      // Remember whatever tab the operator actually chose.
      lastNonFields.current = current;
      return;
    }
    // current === 'fields': a selection flipped the left tab. Only correct it in
    // the desktop two-rail layout (fields belongs on the right there); on mobile
    // the left fields tab is intended.
    if (!rightVisible) return;
    const restore = lastNonFields.current !== FIELDS_PLUGIN ? lastNonFields.current : 'blocks';
    dispatch({ type: 'setUi', ui: { plugin: { current: restore } } });
  }, [current, rightVisible, dispatch]);

  return null;
}
