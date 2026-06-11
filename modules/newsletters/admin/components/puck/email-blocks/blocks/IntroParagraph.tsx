/**
 * Intro Paragraph — a large rich-text opener with no card frame. Native
 * react-email port of the legacy `intro_paragraph` Mustache block.
 */

import { Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { COLUMN } from './_shared.js';

interface IntroParagraphProps extends Record<string, unknown> {
  text: string;
}

export const IntroParagraphBlock: EmailBlockEntry<IntroParagraphProps> = {
  componentId: 'intro_paragraph',
  label: 'Intro Paragraph',
  category: 'Content',
  fields: {
    text: { type: 'richtext', label: 'Intro Text' },
  },
  defaultProps: { text: '' },
  Component: ({ text }) => (
    <Section style={COLUMN}>
      <RichText
        value={text}
        style={{
          fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
          fontSize: '20px',
          lineHeight: 1.5,
          color: '#555',
          padding: '20px 15px',
        }}
      />
    </Section>
  ),
};
