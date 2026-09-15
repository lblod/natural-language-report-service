import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { sessionUpdate, sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime } from '../db.js';

const REPORT_CLASS = process.env.REPORT_CLASS || 'http://lblod.data.gift/vocabularies/reporting/Report';

// Register the CSV: a logical file (http://data.lblod.info/files/<uuid>) plus
// a physical share:// file pointing back with nie:dataSource. The logical
// URI is what you link to.
export async function registerFile(sessionUpdateFn, fileName, filePath) {
  const size = statSync(filePath).size;
  const uuid = randomUUID();
  const uuid2 = randomUUID();
  const now = new Date();
  const logicalUri = `http://data.lblod.info/files/${uuid}`;
  const physicalUri = `share://${fileName}`;

  await (sessionUpdateFn || sessionUpdate)(`
    INSERT DATA {
      ${sparqlEscapeUri(logicalUri)} a ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#FileDataObject')} ;
        ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/core/uuid')} ${sparqlEscapeString(uuid)} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName')} ${sparqlEscapeString(fileName)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/format')} ${sparqlEscapeString('text/csv')} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileSize')} ${sparqlEscapeInt(size)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/created')} ${sparqlEscapeDateTime(now)} .
      ${sparqlEscapeUri(physicalUri)} a ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#FileDataObject')} ;
        ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/core/uuid')} ${sparqlEscapeString(uuid2)} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName')} ${sparqlEscapeString(fileName)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/format')} ${sparqlEscapeString('text/csv')} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileSize')} ${sparqlEscapeInt(size)} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileCreated')} ${sparqlEscapeDateTime(now)} ;
        ${sparqlEscapeUri('http://www.semanticdesktop.org/ontologies/2007/01/19/nie#dataSource')} ${sparqlEscapeUri(logicalUri)} .
    }`);

  return logicalUri;
}

// One report pointing at the logical file URI.
export async function registerReport(sessionUpdateFn, title, fileUri, extra = {}) {
  const uuid = randomUUID();
  const now = new Date();
  const reportUri = `http://data.lblod.info/id/reports/${uuid}`;

  const extraTriples = [];
  if (extra.question) extraTriples.push(`${sparqlEscapeUri(reportUri)} ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/ext/question')} ${sparqlEscapeString(extra.question)} .`);
  if (extra.specFile) extraTriples.push(`${sparqlEscapeUri(reportUri)} ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/ext/specFile')} ${sparqlEscapeString(extra.specFile)} .`);
  if (extra.creator) extraTriples.push(`${sparqlEscapeUri(reportUri)} ${sparqlEscapeUri('http://purl.org/dc/terms/creator')} ${sparqlEscapeUri(extra.creator)} .`);

  await (sessionUpdateFn || sessionUpdate)(`
    INSERT DATA {
      ${sparqlEscapeUri(reportUri)} a ${sparqlEscapeUri(REPORT_CLASS)} ;
        ${sparqlEscapeUri('http://mu.semte.ch/vocabularies/core/uuid')} ${sparqlEscapeString(uuid)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/title')} ${sparqlEscapeString(title)} ;
        ${sparqlEscapeUri('http://purl.org/dc/terms/created')} ${sparqlEscapeDateTime(now)} ;
        ${sparqlEscapeUri('http://www.w3.org/ns/prov#generated')} ${sparqlEscapeUri(fileUri)} .
      ${extraTriples.join('\n      ')}
    }`);

  return reportUri;
}