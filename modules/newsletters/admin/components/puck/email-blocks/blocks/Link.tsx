/**
 * Link primitive — react-email's `Link`. Inline-style anchor; rarely
 * useful at top level (use `Button` for CTAs) but available for
 * footnotes, social-icon rows, etc.
 */

import { Link } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface LinkProps extends Record<string, unknown> {
  href: string;
  text: string;
  color: string;
  underline: 'underline' | 'none';
}

const UNDERLINE_OPTIONS = [
  { label: 'Underline', value: 'underline' as const },
  { label: 'No underline', value: 'none' as const },
];

export const LinkBlock: EmailBlockEntry<LinkProps> = {
  componentId: 'link',
  label: 'Link',
  category: 'Content',
  fields: {
    href: { type: 'text', label: 'URL' },
    text: { type: 'text', label: 'Link text' },
    color: { type: 'text', label: 'Colour (hex)' },
    underline: { type: 'radio', label: 'Underline', options: UNDERLINE_OPTIONS },
  },
  defaultProps: {
    href: 'https://example.com',
    text: 'Read more',
    color: '#1a1a2e',
    underline: 'underline',
  },
  Component: ({ href, text, color, underline }) => (
    <Link href={href} style={{ color, textDecoration: underline }}>
      {text}
    </Link>
  ),
};
