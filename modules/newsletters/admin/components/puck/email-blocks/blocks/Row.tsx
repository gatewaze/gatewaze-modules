/**
 * Row primitive — react-email's `Row` (table-row wrapper that holds
 * `Column` children). One `Row` lays its children out side-by-side at
 * desktop widths; mobile clients (Outlook, Gmail iOS) collapse columns
 * via the `mobile:` Tailwind variant the Barebone templates ship.
 */

import { Row } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface RowProps extends Record<string, unknown> {
  children?: unknown;
}

export const RowBlock: EmailBlockEntry<RowProps> = {
  componentId: 'row',
  label: 'Row',
  category: 'Layout',
  fields: {
    children: { type: 'slot', label: 'Columns' },
  },
  defaultProps: {
    children: [],
  },
  Component: ({ children }) => <Row>{renderSlot(children)}</Row>,
};
