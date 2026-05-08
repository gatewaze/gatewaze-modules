/**
 * Horizontal rule primitive — react-email's `Hr`. Divides email
 * sections; styled inline so it survives Outlook's CSS stripping.
 */

import { Hr } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface HrProps extends Record<string, unknown> {
  color: string;
  margin: string;
}

export const HrBlock: EmailBlockEntry<HrProps> = {
  componentId: 'hr',
  label: 'Divider',
  category: 'Layout',
  fields: {
    color: { type: 'text', label: 'Colour (hex)' },
    margin: { type: 'text', label: 'Margin (CSS)' },
  },
  defaultProps: {
    color: '#e0e0e0',
    margin: '24px 0',
  },
  Component: ({ color, margin }) => (
    <Hr style={{ borderTop: `1px solid ${color}`, margin }} />
  ),
};
