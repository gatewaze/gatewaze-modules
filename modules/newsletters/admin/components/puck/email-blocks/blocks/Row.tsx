/**
 * Row primitive — wraps react-email's `Row` (table-row) at publish time,
 * but renders a `<div>` flex container in edit mode so Puck's DropZone
 * (`<div>`) can legally nest inside it. See `../editor-safe-primitives.tsx`
 * for the rationale.
 */

import { EmailRow } from '../editor-safe-primitives.js';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface RowProps extends Record<string, unknown> {
  children?: unknown;
  editMode?: boolean;
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
  Component: ({ children, editMode }) => (
    <EmailRow editMode={editMode}>{renderSlot(children)}</EmailRow>
  ),
};
