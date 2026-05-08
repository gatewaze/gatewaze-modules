/**
 * Section primitive — react-email's `Section` table-wrapper. The
 * unstyled building block for any rectangular email region. Composite
 * blocks like Header / ContentSection / HelixAiContent build on top of
 * this primitive but pre-fill the styling and the inner field schema;
 * `SectionBlock` is the bare primitive that authors compose by hand
 * via the slash palette.
 */

import { Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface SectionProps extends Record<string, unknown> {
  padding: string;
  background: string;
  align: 'left' | 'center' | 'right';
  rounded: string;
  children?: unknown;
}

const ALIGN_OPTIONS = [
  { label: 'Left', value: 'left' as const },
  { label: 'Center', value: 'center' as const },
  { label: 'Right', value: 'right' as const },
];

export const SectionBlock: EmailBlockEntry<SectionProps> = {
  componentId: 'section',
  label: 'Section',
  category: 'Layout',
  fields: {
    padding: { type: 'text', label: 'Padding (CSS)' },
    background: { type: 'text', label: 'Background colour' },
    align: { type: 'radio', label: 'Text alignment', options: ALIGN_OPTIONS },
    rounded: { type: 'text', label: 'Border radius (CSS)' },
    children: { type: 'slot', label: 'Contents' },
  },
  defaultProps: {
    padding: '20px 40px',
    background: 'transparent',
    align: 'left',
    rounded: '0',
    children: [],
  },
  Component: ({ padding, background, align, rounded, children }) => (
    <Section
      style={{
        padding,
        backgroundColor: background,
        textAlign: align,
        borderRadius: rounded,
      }}
    >
      {renderSlot(children)}
    </Section>
  ),
};
