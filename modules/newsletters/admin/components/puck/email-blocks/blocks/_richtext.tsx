/**
 * Renderer for a Puck native `type: 'richtext'` field value.
 *
 * Puck's richtext field is dual-natured (its `RichText` type is
 * `string | ReactNode`):
 *   - In the editor canvas, Puck replaces the value with a live inline tiptap
 *     editor node — render it directly so the operator edits in place.
 *   - Everywhere else (publish worker, the editor's Export) the value is the
 *     stored HTML string — mount it via dangerouslySetInnerHTML, running it
 *     through `normalizeRichText` first to reconcile the legacy MLOps list
 *     styling (tight bullets, no left indent) the same way the Mustache
 *     blocks did.
 */

import type { CSSProperties, ReactNode } from 'react';
import { normalizeRichText } from '../rich-text.js';

export function RichText({ value, style, className }: { value: unknown; style?: CSSProperties; className?: string }): ReactNode {
  if (typeof value === 'string') {
    return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: normalizeRichText(value) }} />;
  }
  return <div className={className} style={style}>{value as ReactNode}</div>;
}
