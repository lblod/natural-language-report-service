import { seed } from './seed.js';
import { fetchColumns } from './columns.js';
import { assemble } from './assemble.js';
import { startShape } from './profile.js';

const CSV_SEPARATOR = process.env.CSV_SEPARATOR || ';';

// A spec to CSV text: pick the subjects, fetch the column values, pair them
// into rows. Reads only, as the caller.
export async function run(spec, profile) {
  const subjects = await seed(spec, startShape(profile, spec));
  const values = await fetchColumns(subjects, spec);
  const rows = assemble(subjects, values, spec);
  return rows.map(row => row.map(csvCell).join(CSV_SEPARATOR)).join('\n');
}

// A cell is quoted only when it holds the separator, a quote or a newline;
// a quote inside a cell is doubled, per RFC 4180.
function csvCell(cell) {
  const s = String(cell ?? '');
  return s.includes(CSV_SEPARATOR) || s.includes('"') || /[\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}
