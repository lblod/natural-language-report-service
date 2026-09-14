import { mkdirSync, writeFileSync } from 'fs';

// Rows to a CSV file. CSV_SEPARATOR is ';' by default. A cell is quoted
// only when it holds the separator, a quote or a newline; a quote inside a
// cell is doubled, per RFC 4180.

const CSV_SEPARATOR = process.env.CSV_SEPARATOR || ';';
const SHARE_DIR = process.env.SHARE_DIR || '/share';

export function rowsToCsv(rows) {
  return rows.map(row => row.map(escapeCell).join(CSV_SEPARATOR)).join('\n');
}

function escapeCell(cell) {
  const s = String(cell ?? '');
  return s.includes(CSV_SEPARATOR) || s.includes('"') || /[\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function writeCsv(name, csv) {
  mkdirSync(SHARE_DIR, { recursive: true });
  const file = `${SHARE_DIR}/${name}`;
  writeFileSync(file, csv, 'utf8');
  return file;
}