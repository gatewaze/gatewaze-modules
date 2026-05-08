/**
 * Button (call-to-action) email block — wraps `@react-email/components`'s `Button`.
 *
 * `Button` emits a `<table>` ghost-wrapper plus an `<a>` tag with
 * Outlook-compatible padding via VML — this is exactly the pattern
 * email block authors today have to hand-roll.
 */

import { Button, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ButtonProps extends Record<string, unknown> {
  label: string;
  href: string;
  align: 'left' | 'center' | 'right';
  bgColor: string;
  textColor: string;
}

const ALIGN_OPTIONS: Array<{ label: string; value: ButtonProps['align'] }> = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
];

export const ButtonBlock: EmailBlockEntry<ButtonProps> = {
  componentId: 'button',
  label: 'Button',
  category: 'Action',
  fields: {
    label: { type: 'text', label: 'Label' },
    href: { type: 'text', label: 'Link URL' },
    align: { type: 'radio', label: 'Alignment', options: ALIGN_OPTIONS },
    bgColor: { type: 'text', label: 'Background colour (hex)' },
    textColor: { type: 'text', label: 'Text colour (hex)' },
  },
  defaultProps: {
    label: 'Read more',
    href: 'https://example.com',
    align: 'left',
    bgColor: '#1f6feb',
    textColor: '#ffffff',
  },
  Component: ({ label, href, align, bgColor, textColor }) => (
    <Section style={{ textAlign: align, margin: '24px 0' }}>
      <Button
        href={safeHref(href)}
        style={{
          backgroundColor: safeColor(bgColor, '#1f6feb'),
          color: safeColor(textColor, '#ffffff'),
          padding: '12px 24px',
          borderRadius: '6px',
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        {label}
      </Button>
    </Section>
  ),
  // Substack + Beehiiv: simple <a> link inside a paragraph. Both
  // platforms render buttons as plain links anyway when imported.
  formats: {
    substack: ({ label, href }) => (
      <p><a href={safeHref(href)}>{label}</a></p>
    ),
    beehiiv: ({ label, href }) => (
      <p><a href={safeHref(href)}>{label}</a></p>
    ),
  },
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const SAFE_HREF = /^(https?:|mailto:|tel:|\/)/i;

function safeColor(value: string, fallback: string): string {
  return HEX.test(value) ? value : fallback;
}

function safeHref(value: string): string {
  if (typeof value !== 'string') return '#';
  return SAFE_HREF.test(value) ? value : '#';
}

