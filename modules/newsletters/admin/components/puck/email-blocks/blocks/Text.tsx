/**
 * Text email block — wraps `@react-email/components`'s `Text`.
 *
 * The `body` field is `type: 'textarea'` with `contentEditable: true`.
 * Puck routes that through its inline-text field transform: clicking
 * the rendered paragraph turns it into a contentEditable
 * (plaintext-only) span and edits dispatch back through Puck's
 * setItem path. Multiline allowed (textarea path doesn't have the
 * disableLineBreaks the `text` path enforces).
 *
 * The component must render the value as children — using
 * `dangerouslySetInnerHTML` bypasses the field transform and leaves
 * the paragraph non-editable.
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
    body: { type: 'textarea', label: 'Body', contentEditable: true },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    body: 'Body text. Click here to edit inline.',
    align: 'left',
  },
  Component: ({ body, align }) => (
    <Text style={{ textAlign: align, margin: '0 0 16px', lineHeight: 1.6 }}>
      {body}
    </Text>
  ),
  formats: {
    substack: ({ body }) => <p>{body}</p>,
    beehiiv: ({ body }) => <p>{body}</p>,
  },
};
