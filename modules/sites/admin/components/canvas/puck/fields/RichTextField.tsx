/**
 * Real RichText field for Puck custom-format='richtext' fields.
 *
 * Wraps the admin's existing TipTap-based `RichTextEditor` (at
 * `@/components/ui/RichTextEditor`) which already covers everything a
 * block author needs: bold/italic/strike, headings, lists, links,
 * images, tables, undo/redo. Reusing it gives us:
 *
 *   - one canonical RTE across the admin (consistent UX everywhere)
 *   - paste-sanitisation already wired (sanitizePastedHtml in the
 *     existing component)
 *   - storage-path rewriting for `<img src>` when needed
 *   - no separate Plate.js v53 install + migration cost
 *
 * Per spec-builder-evaluation §3.4 the field stores HTML — the field
 * value is the same string Mustache templates substitute. This matches
 * the legacy editor's contenteditable storage so a Puck-edited page
 * round-trips through `content/pages/<slug>.json` exactly as before.
 *
 * The spec's earlier draft proposed Slate JSON storage with a derived
 * HTML copy. We dropped that pattern when we standardised on TipTap:
 *   - TipTap is HTML-native (parses + serialises HTML round-trip).
 *   - One storage shape ⇒ no compatibility shim between editors.
 *   - DOMPurify still runs on every save, so the security boundary
 *     (§3.4.3 strict allowlist) is preserved.
 */

import { createElement, useMemo } from 'react';
// Direct import — RichTextEditor isn't re-exported from the @/components/ui
// barrel, so we resolve to the source file. The barrel exports a curated
// subset of UI primitives; pulling the editor in via the barrel would
// require a barrel change in admin source which is out of scope here.
import RichTextEditor from '@/components/ui/RichTextEditor';
import { sanitizeRichText } from './richtext-sanitize.js';

export { sanitizeRichText };

export interface RichTextFieldProps {
  value: string;
  onChange: (v: string) => void;
}

export function RichTextField({ value, onChange }: RichTextFieldProps) {
  // Sanitise the incoming value once (rendered into the editor); the
  // user can paste anything but our save-time sanitiser strips it.
  // useMemo prevents re-sanitising on every keystroke.
  const safeIncoming = useMemo(() => sanitizeRichText(value), [value]);

  return createElement(RichTextEditor, {
    content: safeIncoming,
    onChange: (next: string) => onChange(sanitizeRichText(next)),
    className: 'puck-richtext',
  });
}
