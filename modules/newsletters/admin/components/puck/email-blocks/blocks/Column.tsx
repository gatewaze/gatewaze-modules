/**
 * Column primitive — react-email's `Column` (table-cell). Lives inside
 * `Row` and provides per-column width / vertical alignment.
 *
 * Email-safe alternative to flex/grid: clients render the underlying
 * `<td>` table cells reliably across Outlook / Gmail / Apple Mail.
 */

import { Column } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface ColumnProps extends Record<string, unknown> {
  width: string;
  verticalAlign: 'top' | 'middle' | 'bottom';
  padding: string;
  children?: unknown;
}

const VALIGN_OPTIONS = [
  { label: 'Top', value: 'top' as const },
  { label: 'Middle', value: 'middle' as const },
  { label: 'Bottom', value: 'bottom' as const },
];

export const ColumnBlock: EmailBlockEntry<ColumnProps> = {
  componentId: 'column',
  label: 'Column',
  category: 'Layout',
  fields: {
    width: { type: 'text', label: 'Width (CSS, e.g. 50% / 280px)' },
    verticalAlign: { type: 'radio', label: 'Vertical alignment', options: VALIGN_OPTIONS },
    padding: { type: 'text', label: 'Padding (CSS)' },
    children: { type: 'slot', label: 'Contents' },
  },
  defaultProps: {
    width: '100%',
    verticalAlign: 'top',
    padding: '0',
    children: [],
  },
  Component: ({ width, verticalAlign, padding, children }) => (
    <Column style={{ width, verticalAlign, padding }}>
      {renderSlot(children)}
    </Column>
  ),
};
