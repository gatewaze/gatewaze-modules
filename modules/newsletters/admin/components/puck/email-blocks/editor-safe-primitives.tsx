/**
 * Editor-safe wrappers around `@react-email/components` primitives that
 * emit `<tr>` / `<td>` (Row, Column).
 *
 * Why: Puck v0.21 wraps every draggable component in a `<div>`
 * (`DraggableComponent`) and renders each slot field via a `<div>`
 * DropZone. When a block's render output is a `<tr>` or `<td>`, the
 * resulting DOM is invalid HTML:
 *
 *   <div>           ← Puck's DraggableComponent wrapper
 *     <td>...</td>  ← invalid: <td> can only sit inside <tr>
 *   </div>
 *
 *   <tr>
 *     <div>...</div>   ← invalid: <tr> can only contain <td>/<th>
 *   </tr>
 *
 * Both fire DOM-nesting warnings AND hydration mismatches under React 19's
 * stricter checks. At publish time none of this matters — we render the
 * tree via `await render(<EditionEmail/>)` (server-side, no Puck wrapping)
 * and the table-based HTML is exactly what email clients need.
 *
 * Solution: blocks that emit `<tr>`/`<td>` import THESE wrappers instead
 * of `@react-email/components` directly. In edit mode they render a
 * visually-equivalent `<div>` layout (CSS flex for rows, sized flex
 * children for columns); at publish time the real `<Row>` / `<Column>`
 * primitives emit the canonical table markup.
 *
 * `editMode` is the discriminator — `merge-into-config.tsx` passes it
 * through from Puck. Outside Puck (publish-time render) it's undefined,
 * which we treat as "not editing" → render the real primitives.
 */

import type { CSSProperties, ReactNode } from 'react';
import {
  Row as ReactEmailRow,
  Column as ReactEmailColumn,
} from '@react-email/components';

interface EmailRowProps {
  editMode?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}

export function EmailRow({ editMode, style, children }: EmailRowProps) {
  if (editMode) {
    // Flexbox approximation of `<table><tbody><tr>{cells}</tr></tbody></table>`.
    // `align-items: stretch` mirrors `<td valign="top">`'s default cell
    // stretching; per-column verticalAlign is applied on each EmailColumn
    // when the editor needs to override.
    return (
      <div
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'stretch',
          ...style,
        }}
      >
        {children}
      </div>
    );
  }
  return <ReactEmailRow style={style}>{children}</ReactEmailRow>;
}

interface EmailColumnProps {
  editMode?: boolean;
  width?: string;
  verticalAlign?: 'top' | 'middle' | 'bottom';
  padding?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const VALIGN_TO_FLEX: Record<'top' | 'middle' | 'bottom', CSSProperties['alignSelf']> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
};

export function EmailColumn({ editMode, width, verticalAlign, padding, style, children }: EmailColumnProps) {
  if (editMode) {
    // `<td width="50%" valign="top" style="padding:0">` → flex item with the
    // same width / cross-axis alignment / padding. `flex: 0 0 <width>`
    // lets percentages flow naturally; for px widths it still works because
    // flex-basis accepts any CSS length.
    return (
      <div
        style={{
          flex: width ? `0 0 ${width}` : '1 1 0',
          width,
          alignSelf: verticalAlign ? VALIGN_TO_FLEX[verticalAlign] : undefined,
          padding,
          boxSizing: 'border-box',
          ...style,
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <ReactEmailColumn
      style={{
        width,
        verticalAlign,
        padding,
        ...style,
      }}
    >
      {children}
    </ReactEmailColumn>
  );
}
