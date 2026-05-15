/**
 * Two-button CTA row — primary + secondary buttons side by side.
 * Variant of the bare Button primitive that ships two CTAs as a pair,
 * which is the common "Sign up / Learn more" pattern at the end of
 * announcement emails.
 */

import { Button, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ButtonGroupProps extends Record<string, unknown> {
  primary_label: string;
  primary_url: string;
  secondary_label: string;
  secondary_url: string;
  primary_bg: string;
  primary_color: string;
  align: 'left' | 'center' | 'right';
}

export const ButtonGroupBlock: EmailBlockEntry<ButtonGroupProps> = {
  componentId: 'button_group',
  label: 'Button group',
  category: 'Action',
  fields: {
    primary_label: { type: 'text', label: 'Primary button label', contentEditable: true },
    primary_url: { type: 'text', label: 'Primary button URL' },
    secondary_label: { type: 'text', label: 'Secondary button label', contentEditable: true },
    secondary_url: { type: 'text', label: 'Secondary button URL' },
    primary_bg: { type: 'text', label: 'Primary background' },
    primary_color: { type: 'text', label: 'Primary text colour' },
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
    primary_label: 'Get started',
    primary_url: '#',
    secondary_label: 'Learn more',
    secondary_url: '#',
    primary_bg: '#14171E',
    primary_color: '#FFFFFF',
    align: 'center',
  },
  Component: ({
    primary_label,
    primary_url,
    secondary_label,
    secondary_url,
    primary_bg,
    primary_color,
    align,
  }) => (
    <Section style={{ padding: '20px 0', textAlign: align }}>
      <Button
        href={primary_url}
        style={{
          display: 'inline-block',
          backgroundColor: primary_bg,
          color: primary_color,
          padding: '12px 22px',
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
          marginRight: 12,
        }}
      >
        {primary_label}
      </Button>
      <Button
        href={secondary_url}
        style={{
          display: 'inline-block',
          color: primary_bg,
          padding: '12px 22px',
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 600,
          border: `1px solid ${primary_bg}`,
          textDecoration: 'none',
        }}
      >
        {secondary_label}
      </Button>
    </Section>
  ),
};
