// A file made to sit on a message: written to the share, registered as a
// logical nfo:FileDataObject over a physical share:// object, typed with
// dct:type. The file service serves /files/<uuid>/download for it.
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { sessionUpdate, sparqlEscapeUri, sparqlEscapeString,
         sparqlEscapeInt, sparqlEscapeDateTime } from '../db.js';
import { ATTACHMENT_TYPES, SPEC_MEDIA_TYPE } from './vocab.js';

const SHARE_DIR = process.env.SHARE_DIR || '/share';
const FILE_BASE = 'http://data.lblod.info/files/';
const SHARE_BASE = 'share://';
const UUID = 'http://mu.semte.ch/vocabularies/core/uuid';

const NFO = 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#';
const FILE = `${NFO}FileDataObject`;
const FILE_NAME = `${NFO}fileName`;
const FILE_SIZE = `${NFO}fileSize`;
const FILE_CREATED = `${NFO}fileCreated`;
const FORMAT = 'http://purl.org/dc/terms/format';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FILE_TYPE = 'http://purl.org/dc/terms/type';
const DATA_SOURCE = 'http://www.semanticdesktop.org/ontologies/2007/01/19/nie#dataSource';

const file = sparqlEscapeUri;
const str = sparqlEscapeString;

// storeSpecFile(update, content) → { uri, name }. One spec, one unique file:
// spec bijlagen keep their name apart from the report's ttl-file. Every
// spec file starts with "specificatie-", the read_spec tool opens only
// those.
export async function storeSpecFile(update, content) {
  const fileName = `specificatie-${randomUUID()}.ttl`;
  writeFileSync(`${SHARE_DIR}/${fileName}`, content, 'utf8');
  return registerFileObject(update, {
    fileName,
    format: SPEC_MEDIA_TYPE,
    size: Buffer.byteLength(content),
    type: ATTACHMENT_TYPES.spec,
  });
}

// registerFileObject(update, { fileName, format, size, type }) → { uri, name }.
// One logical file over one physical share:// file, both nfo:FileDataObject,
// both carrying the dct:type when given.
export async function registerFileObject(update, { fileName, format, size, type }) {
  const id = randomUUID();
  const physicalId = randomUUID();
  const logical = `${FILE_BASE}${id}`;
  const physical = `${SHARE_BASE}${fileName}`;
  const now = sparqlEscapeDateTime(new Date()) // full URI, xsd spelled out
    .replace('xsd:dateTime', '<http://www.w3.org/2001/XMLSchema#dateTime>');

  const logicalPairs = [
    `${file(RDF_TYPE)} ${file(FILE)}`,
    `${file(UUID)} ${str(id)}`,
    `${file(FILE_NAME)} ${str(fileName)}`,
    `${file(FORMAT)} ${str(format)}`,
    `${file(FILE_SIZE)} ${sparqlEscapeInt(size)}`,
    `${file('http://purl.org/dc/terms/created')} ${now}`,
    ...(type ? [`${file(FILE_TYPE)} ${file(type)}`] : []),
  ];
  const physicalPairs = [
    `${file(RDF_TYPE)} ${file(FILE)}`,
    `${file(UUID)} ${str(physicalId)}`,
    `${file(FILE_NAME)} ${str(fileName)}`,
    `${file(FORMAT)} ${str(format)}`,
    `${file(FILE_SIZE)} ${sparqlEscapeInt(size)}`,
    `${file(FILE_CREATED)} ${now}`,
    `${file(DATA_SOURCE)} ${file(logical)}`,
    ...(type ? [`${file(FILE_TYPE)} ${file(type)}`] : []),
  ];

  await (update || sessionUpdate)(`
    INSERT DATA {
      ${file(logical)} ${logicalPairs.join(' ;\n        ')} .
      ${file(physical)} ${physicalPairs.join(' ;\n        ')} .
    }`);

  return { uri: logical, name: fileName };
}
