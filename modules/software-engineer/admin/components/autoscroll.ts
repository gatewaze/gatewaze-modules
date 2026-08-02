/**
 * Auto-scroll ("tail the live transcript") threshold logic for the Runs tab.
 *
 * This is a NON-COMPONENT module on purpose: SoftwareEngineerTab.tsx is a fast-refresh component
 * file, and `react-refresh/only-export-components` forbids value exports (constants, helpers) living
 * beside a component. Keeping the pure decision here lets the component import it without forcing a
 * full reload — and lets it be unit-tested directly in the module's node vitest env (no DOM). This
 * mirrors overview-filters.ts.
 *
 * The decision is deliberately tiny and pure so it can be exercised with synthetic numbers: given a
 * scroll container's geometry, is the viewport currently within `threshold` pixels of the bottom?
 * The component uses this to remember user intent — "the user scrolled up to read scrollback" — so a
 * burst of streamed events doesn't yank them back to the bottom.
 */

/** Slack (px) from the true bottom that still counts as "pinned". A large streamed step can add more
 *  than this in one commit, so the component ALSO pins imperatively on stick-to-bottom rather than
 *  relying on this distance alone; this only decides whether the user has deliberately scrolled up. */
export const PIN_THRESHOLD_PX = 120;

/** The three scroll geometry fields we read — an HTMLElement satisfies this structurally. */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * True when the scroll position is within `threshold` px of the bottom (or the content isn't tall
 * enough to scroll). A container that can't scroll (scrollHeight <= clientHeight) is always "at the
 * bottom", so tailing stays armed until the user actually scrolls up in a taller stream.
 */
export function isNearBottom(
  { scrollTop, scrollHeight, clientHeight }: ScrollGeometry,
  threshold: number = PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
