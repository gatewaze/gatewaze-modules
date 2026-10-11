/**
 * Link primitive — react-email's `Link`. Inline-style anchor; rarely
 * useful at top level (use `Button` for CTAs) but available for
 * footnotes, social-icon rows, etc.
 */

import { Link } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { getEmailShell } from '../shell-context.js';

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

const DEFAULT_LINK_COLOR = '#1a1a2e';

function LinkBody({ href, text, color, underline }: Pick<LinkProps, 'href' | 'text' | 'color' | 'underline'>) {
  // Plain shell: the stock colour means "not chosen" and the client's own
  // link colour applies (which also follows dark mode); a colour the
  // operator picked still wins.
  const plain = getEmailShell() === 'plain';
  const style = plain && color === DEFAULT_LINK_COLOR ? { textDecoration: underline } : { color, textDecoration: underline };
  return (
    <Link href={href} style={style}>
      {text}
    </Link>
  );
}

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
    color: DEFAULT_LINK_COLOR,
    underline: 'underline',
  },
  Component: ({ href, text, color, underline }) => <LinkBody href={href} text={text} color={color} underline={underline} />,
};
