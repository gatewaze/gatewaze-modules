/**
 * CSV cell escaping for the test-list export.
 *
 * Lives in lib/ rather than inline in the route so the escaping rules can be
 * tested directly: this file is opened in Excel or Sheets by an admin, and the
 * values in it come from people.attributes, which a test-data module writes.
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Prefixing with an apostrophe is the standard defence: the cell renders as
  // text and the leading quote is not displayed.
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}
