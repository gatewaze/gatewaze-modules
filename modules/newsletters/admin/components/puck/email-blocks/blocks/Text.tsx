/**
 * Text email block — wraps `@react-email/components`'s `Text`.
 *
 * Body paragraph with standard email-safe styling. The `body` field is a
 * plain string (not RTE) for v1 — adding inline formatting (bold/italic/
 * link) means swapping in a richtext field which is a follow-up. For
 * now, a single paragraph with optional alignment.
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
    body: { type: 'textarea', label: 'Body' },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    body: 'Body text. Edit me in the right-hand panel.',
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
