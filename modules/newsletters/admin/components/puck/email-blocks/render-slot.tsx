/**
 * Helper for registry blocks that declare a Puck `slot` field.
 *
 * Puck v0.21 hands slot values to the component as a Slot component
 * (callable / render-able). In our renderer (used both at edit-time
 * inside Puck and at publish-time inside `await render(<EditionEmail/>)`)
 * we need a single helper that accepts whatever Puck passed and emits
 * a ReactNode safely.
 *
 * Cases:
 *   - undefined / null → render nothing.
 *   - function (Puck slot component): call it; return the result.
 *   - ReactNode (already rendered, e.g. publish-time tree walker
 *     pre-renders children into JSX): return as-is.
 *   - array of slot entries (shape we serialise into
 *     block.content.children for nested registry blocks): recurse via
 *     `renderTreeNodes`.
 */

import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

export function renderSlot(children: unknown): ReactNode {
  if (children == null || children === false) return null;
  if (Array.isArray(children)) return children as ReactNode;
  if (typeof children === 'function') {
    // Edit-time inside Puck: slot value is a SlotComponent (React FC).
    // Mount via createElement so React owns reconciliation + hooks.
    return createElement(children as ComponentType);
  }
  return children as ReactNode;
}

/**
 * Type predicate — does this prop carry actual children content (an
 * array of nested entries, a Puck slot component, or pre-rendered JSX)?
 * Used by registry components that want to skip whitespace/padding
 * defaults when a slot is empty.
 */
export function hasSlotContent(children: unknown): children is ReactElement | ReadonlyArray<unknown> | (() => ReactNode) {
  if (children == null || children === false) return false;
  if (Array.isArray(children)) return children.length > 0;
  return typeof children === 'function' || typeof children === 'object';
}
