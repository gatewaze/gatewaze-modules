/**
 * Heading email block — wraps `@react-email/components`'s `Heading`.
 * Per spec-builder-evaluation §3.6 (extended).
 *
 * Renders a level-aware heading (h1/h2/h3). React-email's Heading
 * component emits the right Outlook-safe HTML: a `<table>` ghost wrapper
 * around the heading, inline styles for cross-client font support.
 */

import { Heading } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface HeadingProps extends Record<string, unknown> {
  text: string;
  level: 'h1' | 'h2' | 'h3';
  align: 'left' | 'center' | 'right';
}

const HEADING_LEVELS: Array<{ label: string; value: HeadingProps['level'] }> = [
  { label: 'Large (H1)', value: 'h1' },
  { label: 'Medium (H2)', value: 'h2' },
  { label: 'Small (H3)', value: 'h3' },
];

const ALIGN_OPTIONS: Array<{ label: string; value: HeadingProps['align'] }> = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
];

export const HeadingBlock: EmailBlockEntry<HeadingProps> = {
  componentId: 'heading',
  label: 'Heading',
  category: 'Content',
  fields: {
    text: { type: 'text', label: 'Text' },
    level: { type: 'select', label: 'Level', options: HEADING_LEVELS },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    text: 'Heading',
    level: 'h2',
    align: 'left',
  },
  Component: ({ text, level, align }) => (
    <Heading as={level} style={{ textAlign: align, margin: '0 0 16px' }}>
      {text}
    </Heading>
  ),
  // Substack + Beehiiv: simple semantic heading, no inline styles —
  // both platforms strip styling aggressively and apply their own
  // typography. No table wrapper, no MSO ghost.
  formats: {
    substack: ({ text, level }) => {
      const Tag = level;
      return <Tag>{text}</Tag>;
    },
    beehiiv: ({ text, level }) => {
      const Tag = level;
      return <Tag>{text}</Tag>;
    },
  },
};
