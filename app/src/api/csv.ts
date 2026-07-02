export function csvCell(value: string): string {
  // Neutralize spreadsheet formula prefixes before quoting untrusted export cells.
  const guarded = guardSpreadsheetFormula(value);
  return `"${guarded.replace(/"/g, "\"\"")}"`;
}

export function csvRow(values: readonly (string | number | boolean | null | undefined)[]): string {
  return values.map((value) => csvCell(value === null || value === undefined ? "" : String(value))).join(",");
}

export function csvWithBom(csv: string): string {
  return `${String.fromCharCode(0xfeff)}${csv}`;
}

export function guardSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
