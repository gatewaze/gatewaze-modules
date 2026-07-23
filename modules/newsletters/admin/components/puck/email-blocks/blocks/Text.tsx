/**
 * Text email block — a rich-text paragraph.
 *
 * The `body` field is Puck's native `type: 'richtext'` (inline tiptap in the
 * editor canvas; stored as an HTML string). Rendered via the shared `RichText`
 * helper so the stored HTML round-trips through both the editor and the
 * export/send path (mirrors IntroParagraph and the other rich blocks). This
 * replaced the earlier plaintext `textarea` field so operators get real
 * formatting (bold/italic/links/lists) — a backward-compatible upgrade: a
 * legacy plaintext `body` string still renders unchanged.
 *
 * Styling defaults to a plain email look — Arial, ~10pt, left-aligned — the
 * zero-config body a broadcast lands on. `align` stays adjustable.
 */

import { Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { COLUMN } from './_shared.js';

interface TextProps extends Record<string, unknown> {
  body: string;
}

export const TextBlock: EmailBlockEntry<TextProps> = {
  componentId: 'text',
  label: 'Text',
  category: 'Content',
  // No block-level alignment field: alignment is per-paragraph inside the
  // rich-text editor (tiptap TextAlign on the selected paragraph/heading), so a
  // single Text block can mix left / centre / right. A whole-block `align`
  // radio would override that and force one alignment for everything.
  fields: {
    body: { type: 'richtext', label: 'Body' },
  },
  defaultProps: {
    body: '',
  },
  Component: ({ body }) => (
    <Section style={COLUMN}>
      <RichText
        value={body}
        style={{
          fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
          fontSize: '13px',
          lineHeight: 1.5,
          color: '#111111',
          margin: '0 0 16px',
          // No per-block padding — keeps the text block consistent with the
          // other email blocks (uniform body inset belongs on the shell, not
          // here).
        }}
      />
    </Section>
  ),
  formats: {
    substack: ({ body }) => <RichText value={body} />,
    beehiiv: ({ body }) => <RichText value={body} />,
  },
};
