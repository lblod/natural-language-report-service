import { update, uuid, sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime } from 'mu';
import { seed } from './seed.js';
import { fetchColumns } from './columns.js';
import { assemble } from './assemble.js';
import { startShape } from './profile.js';

const REPORT_CLASS = process.env.REPORT_CLASS || 'http://lblod.data.gift/vocabularies/reporting/Report';
const CSV_SEPARATOR = process.env.CSV_SEPARATOR || ';';

// run(spec, profile) → the CSV text. seed → columns → assemble → CSV.
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

// One report pointing at the logical file URI of its CSV.
export async function registerReport(title, fileUri) {
  const id = uuid();
  const reportUri = `http://data.lblod.info/id/reports/${id}`;

  await update(`
    INSERT DATA {
      ${sparqlEscapeUri(reportUri)} a ${sparqlEscapeUri(REPORT_CLASS)} ;
        ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/core/uuid')} ${sparqlEscapeString(id)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/title')} ${sparqlEscapeString(title)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/created')} ${sparqlEscapeDateTime(new Date())} ;
        ${sparqlEscapeUri('http://www.w3.org/ns/prov#generated')} ${sparqlEscapeUri(fileUri)} .
    }`);

  return reportUri;
}

export function slug(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
