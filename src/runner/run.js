import { seed } from './seed.js';
import { fetchColumns } from './columns.js';
import { assemble } from './assemble.js';
import { rowsToCsv, writeCsv, writeSpec } from './csv.js';
import { registerFile, registerReport } from './report.js';
import { touch } from './job.js';

// Ties the steps together: seed → columns → assemble → CSV → register.
// Returns { reportUri, fileUri, rowCount }. The task is touched once per
// column group so the dashboard shows movement. onProgress fires on every
// answered query with what the phase knows — { subjects } per seed page,
// { done, total } per column batch — so a waiter can tell a live run from
// a stalled one.

export async function run(query, update, parsed, profile, title, taskUri, extra = {}, onProgress = null) {
  const subjects = await seed(query, parsed,
    onProgress ? (n) => onProgress({ subjects: n }) : null);

  const values = new Map();
  await fetchColumns(query, subjects, parsed, values,
    taskUri ? () => touch(update, taskUri) : null, onProgress);

  const rows = assemble(subjects, values, parsed);
  const fileName = `${slug(title)}.csv`;
  const csv = rowsToCsv(rows);
  const filePath = writeCsv(fileName, csv);
  const specFile = extra.spec && writeSpec(fileName, extra.spec);

  const fileUri = await registerFile(update, fileName, filePath);
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
