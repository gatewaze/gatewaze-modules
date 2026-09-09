/**
 * Test-time stub for the host admin app's `@/components/shared/table/
 * DataTable` (see ui.tsx stub for why). Renders the same tanstack-table
 * instance as a plain HTML table so BroadcastsTable.test.tsx can query
 * header/cell text without needing the real app's sticky-column styling.
 */
import { Fragment, type ReactNode } from 'react';
import { flexRender, type Table as TanstackTable, type Row } from '@tanstack/react-table';

export function DataTable<T>({
  table,
  renderSubComponent,
}: {
  table: TanstackTable<T>;
  loading?: boolean;
  emptyState?: ReactNode;
  colSpan?: number;
  onRowDoubleClick?: (row: T) => void;
  renderSubComponent?: (row: Row<T>) => ReactNode;
}) {
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <Fragment key={row.id}>
            <tr>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
            {renderSubComponent && row.getIsExpanded() && (
              <tr>
                <td colSpan={row.getVisibleCells().length}>{renderSubComponent(row)}</td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
