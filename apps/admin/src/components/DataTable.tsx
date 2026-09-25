'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  /** Renders the cell as the row header (for screen readers): use for the primary identifier column. */
  rowHeader?: boolean;
}

/**
 * Accessible data table: a real <table> with a caption, column headers with scope, a keyboard-focusable scroll region
 * so wide tables stay usable at narrow widths and 400% zoom.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  visibleCaption,
}: {
  caption: string;
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  visibleCaption?: boolean;
}) {
  const t = useT();
  // The scroll region's name must differ from the section heading that usually sits right above the table (unique landmarks).
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label={t('table.region', { caption })}
      tabIndex={0}
    >
      <table className="data-table">
        <caption className={visibleCaption ? undefined : 'yl-sr-only'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} scope="col" className={c.numeric ? 'num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) =>
                c.rowHeader ? (
                  <th key={c.id} scope="row">
                    {c.cell(r)}
                  </th>
                ) : (
                  <td key={c.id} className={c.numeric ? 'num' : undefined}>
                    {c.cell(r)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
