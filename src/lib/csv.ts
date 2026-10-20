// CSV text for the report and register downloads.

export type CsvValue = string | number | null | undefined

/**
 * One CSV cell. Text an admin typed (names, addresses, reference numbers)
 * that starts like a formula gets a leading apostrophe, so a spreadsheet
 * shows it instead of running it (CSV/formula injection); numbers — also
 * negative ones written as text — stay numbers.
 */
export function csvCell(v: CsvValue): string {
  let s = String(v ?? '')
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: CsvValue[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}
