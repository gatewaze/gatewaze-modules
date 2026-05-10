/**
 * Heading email block — wraps `@react-email/components`'s `Heading`.
 * Per spec-builder-evaluation §3.6 (extended).
 *
 * The `text` field is `type: 'richtext'` so Puck v0.21 mounts an
 * inline TipTap editor on the canvas — operators click the heading
 * text and edit it directly, like the puckeditor.com demo. The
 * stored value is HTML; the renderer writes it via
 * `dangerouslySetInnerHTML`.
 *
 * Backward compatibility: existing editions store the heading as a
 * plain string ("Hello world"). dangerouslySetInnerHTML accepts
 * plain text as-is, so legacy values render correctly. The first
 * inline edit by an operator round-trips the value back through
 * Puck's richtext serializer (HTML).
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
    // richtext makes Puck mount an inline TipTap editor on the
    // rendered heading in the canvas; clicking the text turns it
    // into a contentEditable surface.
    text: { type: 'richtext', label: 'Text' },
    level: { type: 'select', label: 'Level', options: HEADING_LEVELS },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
  },
  defaultProps: {
    text: 'Heading',
    level: 'h2',
    align: 'left',
  },
  Component: ({ text, level, align }) => (
    <Heading
      as={level}
      style={{ textAlign: align, margin: '0 0 16px' }}
      dangerouslySetInnerHTML={{ __html: typeof text === 'string' ? text : '' }}
    />
  ),
  // Substack + Beehiiv: simple semantic heading, no inline styles —
  // both platforms strip styling aggressively and apply their own
  // typography. No table wrapper, no MSO ghost.
  formats: {
    substack: ({ text, level }) => {
      const Tag = level;
      return <Tag dangerouslySetInnerHTML={{ __html: typeof text === 'string' ? text : '' }} />;
    },
    beehiiv: ({ text, level }) => {
      const Tag = level;
      return <Tag dangerouslySetInnerHTML={{ __html: typeof text === 'string' ? text : '' }} />;
    },
  },
};
