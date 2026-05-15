/**
 * Column primitive — wraps react-email's `Column` (table-cell) at publish
 * time, but renders a sized `<div>` flex item in edit mode so Puck's
 * outer DraggableComponent (`<div>`) can legally contain it. See
 * `../editor-safe-primitives.tsx` for the rationale.
 */

import { EmailColumn } from '../editor-safe-primitives.js';
import type { EmailBlockEntry } from '../registry-types.js';
import { renderSlot } from '../render-slot.js';

interface ColumnProps extends Record<string, unknown> {
  width: string;
  verticalAlign: 'top' | 'middle' | 'bottom';
  padding: string;
  children?: unknown;
  editMode?: boolean;
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
  Component: ({ width, verticalAlign, padding, children, editMode }) => (
    <EmailColumn
      editMode={editMode}
      width={width}
      verticalAlign={verticalAlign}
      padding={padding}
    >
      {renderSlot(children)}
    </EmailColumn>
  ),
};
