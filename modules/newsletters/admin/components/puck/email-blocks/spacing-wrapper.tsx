/**
 * Universal outer-spacing wrapper for registry blocks.
 *
 * Both the editor canvas (via `puckEntryFromRegistry` in
 * merge-into-config.tsx) and the publish pipeline (via `BlockSlot` /
 * `renderTree` in EditionEmail.tsx) need to wrap each block in a
 * spacing div when `_spacing_padding` or `_spacing_margin` is set.
 * Centralising the logic ensures the canvas preview and the sent
 * email render identically — drift between the two paths is one of
 * the recurring shapes of email-template bugs in this codebase.
 *
 * `<div>` chosen as the wrapper element. Every modern email client
 * honours padding on a div; margin works in most clients (Outlook
 * ignores `margin` on a div but doesn't break layout). When both
 * values are the default `'0px'` we skip the wrapper entirely so the
 * rendered HTML matches the pre-spacing output and existing snapshots
 * don't drift.
 */

import type { ReactElement, ReactNode } from 'react';

export const SPACING_PROP_KEYS = ['_spacing_padding', '_spacing_margin'] as const;

export function extractSpacing(props: Record<string, unknown>): {
  padding: string;
  margin: string;
} {
  const padding = typeof props._spacing_padding === 'string' ? props._spacing_padding : '0px';
  const margin = typeof props._spacing_margin === 'string' ? props._spacing_margin : '0px';
  return { padding, margin };
}

export function isDefaultSpacing(padding: string, margin: string): boolean {
  return padding === '0px' && margin === '0px';
}

export function wrapWithSpacing(
  node: ReactNode,
  padding: string,
  margin: string,
): ReactElement | ReactNode {
  if (isDefaultSpacing(padding, margin)) return node;
  return <div style={{ padding, margin }}>{node}</div>;
}
