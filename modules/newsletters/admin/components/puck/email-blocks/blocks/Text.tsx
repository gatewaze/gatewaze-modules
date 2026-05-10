/**
 * Text email block — wraps `@react-email/components`'s `Text`.
 *
 * The `body` field is `type: 'richtext'` so Puck v0.21 mounts an
 * inline TipTap editor directly on the rendered text in the canvas
 * (puckeditor.com-style click-to-edit). Stored value is HTML and
 * rendered via `dangerouslySetInnerHTML`. Backward compat: legacy
 * editions store plain strings, which dangerouslySetInnerHTML
 * accepts as-is — first inline edit round-trips through Puck's
 * richtext serializer to HTML.
 */

import { Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface TextProps extends Record<string, unknown> {
  body: string;
  align: 'left' | 'center' | 'right';
}

const ALIGN_OPTIONS: Array<{ label: string; value: TextProps['align'] }> = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
];

export const TextBlock: EmailBlockEntry<TextProps> = {
  componentId: 'text',
  label: 'Text',
  category: 'Content',
  fields: {
    body: { type: 'richtext', label: 'Body' },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    body: 'Body text. Click here to edit inline.',
    align: 'left',
  },
  Component: ({ body, align }) => (
    <Text
      style={{ textAlign: align, margin: '0 0 16px', lineHeight: 1.6 }}
      dangerouslySetInnerHTML={{ __html: typeof body === 'string' ? body : '' }}
    />
  ),
  formats: {
    substack: ({ body }) => (
      <div dangerouslySetInnerHTML={{ __html: typeof body === 'string' ? body : '' }} />
    ),
    beehiiv: ({ body }) => (
      <div dangerouslySetInnerHTML={{ __html: typeof body === 'string' ? body : '' }} />
    ),
  },
};
