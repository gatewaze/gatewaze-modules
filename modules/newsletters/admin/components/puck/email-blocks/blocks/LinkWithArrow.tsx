/**
 * "Read more →" style link. Variant of the bare Link primitive with an
 * inline arrow glyph and underline-on-bottom-only styling. Common
 * trailing element after article previews.
 */

import { Link, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface LinkWithArrowProps extends Record<string, unknown> {
  label: string;
  url: string;
  color: string;
  align: 'left' | 'center' | 'right';
}

export const LinkWithArrowBlock: EmailBlockEntry<LinkWithArrowProps> = {
  componentId: 'link_with_arrow',
  label: 'Link (with arrow)',
  category: 'Action',
  fields: {
    label: { type: 'text', label: 'Label', contentEditable: true },
    url: { type: 'text', label: 'URL' },
    color: { type: 'text', label: 'Colour' },
    align: {
      type: 'select',
      label: 'Alignment',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
      ],
    },
  },
  defaultProps: {
    label: 'Read more',
    url: '#',
    color: '#2563EB',
    align: 'left',
  },
  Component: ({ label, url, color, align }) => (
    <Section style={{ padding: '12px 0', textAlign: align }}>
      <Link
        href={url}
        style={{
          color,
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
          borderBottom: `1px solid ${color}`,
          paddingBottom: 2,
        }}
      >
        {label} →
      </Link>
    </Section>
  ),
};
