/**
 * Section with explicit background colour + optional heading + body
 * slot. Distinct from the bare Section primitive (which is just a
 * react-email <Section> wrapper) in that this one is a styled card —
 * coloured panel with internal padding and an optional headline.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface SectionWithBackgroundProps extends Record<string, unknown> {
  background: string;
  text_color: string;
  heading: string;
  children?: unknown;
}

export const SectionWithBackgroundBlock: EmailBlockEntry<SectionWithBackgroundProps> = {
  componentId: 'section_background',
  label: 'Section (colored background)',
  category: 'Layout',
  fields: {
    background: { type: 'text', label: 'Background colour' },
    text_color: { type: 'text', label: 'Text colour' },
    heading: { type: 'text', label: 'Heading (optional)' },
    children: { type: 'slot', label: 'Contents' },
  },
  defaultProps: {
    background: '#0F172A',
    text_color: '#FFFFFF',
    heading: 'Highlight',
    children: [],
  },
  Component: ({ background, text_color, heading, children }) => (
    <Section
      style={{
        padding: '40px 32px',
        backgroundColor: background,
        color: text_color,
        borderRadius: 8,
      }}
    >
      {heading ? (
        <Text style={{ margin: '0 0 16px', fontSize: 22, fontWeight: 600, color: text_color }}>
          {heading}
        </Text>
      ) : null}
      {renderSlot(children)}
    </Section>
  ),
};
