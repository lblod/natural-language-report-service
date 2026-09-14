import { seed } from './seed.js';
import { fetchColumns } from './columns.js';
import { assemble } from './assemble.js';
import { rowsToCsv, writeCsv } from './csv.js';
import { registerFile, registerReport } from './report.js';
import { touch } from './job.js';
import { groupsQuery, groupsUpdate } from '../db.js';

// Ties the six steps together. Runs with the captured groups (see
// captureGroups), returns { reportUri, fileUri, rowCount }. The task is
// touched once per column group so the dashboard shows movement.

export async function run(allowedGroups, parsed, profile, title, taskUri, extra = {}) {
  const queryFn = sparql => groupsQuery(sparql, allowedGroups);
  const updateFn = (sparql, extra) => groupsUpdate(sparql, allowedGroups, extra);

  const subjects = await seed(queryFn, parsed);

  const values = new Map();
  await fetchColumns(queryFn, subjects, parsed, values,
    taskUri ? () => touch(updateFn, taskUri) : null);

  const rows = assemble(subjects, values, parsed);
  const fileName = `${slug(title)}.csv`;
  const csv = rowsToCsv(rows);
  const filePath = writeCsv(fileName, csv);

  const fileUri = await registerFile((sparql) => updateFn(sparql), fileName, filePath);
  const reportUri = await registerReport((sparql) => updateFn(sparql), title, fileUri, extra);

  return { reportUri, fileUri, rowCount: rows.length - 1, filePath };
}

// Exported for run_report: the file name must be known before the run starts,
// so the chat can show a pending card named after the report.
export function slug(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}