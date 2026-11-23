/**
 * One CSV cell. Text that a spreadsheet would treat as a formula (leading =, +, -, @,
 * tab or CR) is prefixed with an apostrophe so Excel/Sheets open it as plain text;
 * numbers and dates are written as-is.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
