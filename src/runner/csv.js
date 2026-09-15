import { mkdirSync, writeFileSync, readFileSync } from 'fs';

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

// The spec of the run, next to its CSV (same base name, .ttl), so a report
// can be debugged afterwards. The store keeps only the pointer.
export function writeSpec(csvName, spec) {
  mkdirSync(SHARE_DIR, { recursive: true });
  const name = csvName.replace(/\.csv$/, '') + '.ttl';
  writeFileSync(`${SHARE_DIR}/${name}`, spec, 'utf8');
  return `share://${name}`;
}

export function readSpec(pointer) {
  if (!pointer.startsWith('share://')) throw new Error(`not a share:// pointer: ${pointer}`);
  return readFileSync(`${SHARE_DIR}/${pointer.slice('share://'.length)}`, 'utf8');
}