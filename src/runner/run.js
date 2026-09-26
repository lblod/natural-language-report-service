import { seed } from './seed.js';
import { fetchColumns } from './columns.js';
import { assemble } from './assemble.js';
import { rowsToCsv, writeCsv, writeSpec } from './csv.js';
import { registerFile, registerReport } from './report.js';
import { startShape } from './profile.js';

// Ties the steps together: seed → columns → assemble → CSV → register.
// Returns { reportUri, fileUri, rowCount }.

export async function run(query, update, parsed, profile, title, extra = {}) {
  const shape = startShape(profile, parsed);
  const subjects = await seed(query, parsed, shape);

  const values = new Map();
  await fetchColumns(query, subjects, parsed, values);

  const rows = assemble(subjects, values, parsed);
  const fileName = extra.fileName || `${slug(title)}.csv`;
  const csv = rowsToCsv(rows);
  const filePath = writeCsv(fileName, csv);
  const specFile = extra.spec && writeSpec(fileName, extra.spec);

  const fileUri = await registerFile(update, fileName, filePath, { type: extra.fileType });
  const reportUri = await registerReport(update, title, fileUri,
    specFile ? { ...extra, specFile } : extra);

  return { reportUri, fileUri, rowCount: rows.length - 1, filePath };
}

// The file name must be known before the run starts, so the chat can show a
// pending card named after the report.
export function slug(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}