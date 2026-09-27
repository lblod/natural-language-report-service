// The chat's reads and writes: conversations, messages, their bijlagen and
// the reports. Everything runs as the caller.
//
// A bijlage is a real file: a logical nfo:FileDataObject the file service
// serves at /files/<uuid>/download, over a physical share:// object with
// nie:dataSource back to the logical one.
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { query, update, uuid,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime } from 'mu';

const HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT || 20);
const REPORT_CLASS = process.env.REPORT_CLASS || 'http://lblod.data.gift/vocabularies/reporting/Report';
const SHARE_DIR = process.env.SHARE_DIR || '/share';
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';
const FILE_BASE = 'http://data.lblod.info/files/';
const REPORT_BASE = 'http://data.lblod.info/id/reports/';

export const SPEC_MEDIA_TYPE = 'text/turtle';
// The bijlage types. Match the add-chat-attachment-types-codelist migration
// in the portal.
export const SPEC_TYPE = 'http://lblod.data.gift/concepts/6693014e-7b7d-448c-bb24-80c9758521f3';
export const RESULT_TYPE = 'http://lblod.data.gift/concepts/28d97698-e219-4a92-bdbd-7ab367a7524e';
// Every spec file is called like this. readSpecFile opens nothing else, so
// the LLM can never read a CSV or any other file on the share.
const SPEC_FILE_NAME = /^specificatie-[0-9a-f-]{36}\.ttl$/;

const PREFIXES = `
  PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  PREFIX sioc: <http://rdfs.org/sioc/ns#>
  PREFIX sioct: <http://rdfs.org/sioc/types#>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>
  PREFIX as: <https://www.w3.org/ns/activitystreams#>
  PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
  PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
  PREFIX prov: <http://www.w3.org/ns/prov#>
`;

// The conversation with this uuid, or null when the caller may not read it.
export async function readConversation(id) {
  const result = await query(`${PREFIXES}
    SELECT ?conversation ?title ?creator WHERE {
      ?conversation a sioc:Thread ;
        mu:uuid ${sparqlEscapeString(id)} .
      OPTIONAL { ?conversation dct:title ?title . }
      OPTIONAL { ?conversation foaf:maker ?creator . }
    } LIMIT 1`);
  const binding = result.results.bindings[0];
  if (!binding) return null;
  return { uri: binding.conversation.value, title: binding.title?.value, creator: binding.creator?.value };
}

// The last HISTORY_LIMIT messages, oldest first, as
// { role, content, attachments: [{ uri, name, mediaType, type }] }.
// A message comes back once per bijlage, hence the wider LIMIT.
export async function readHistory(conversationUri, assistantUri) {
  const result = await query(`${PREFIXES}
    SELECT ?message ?content ?maker ?created ?doc ?docName ?docFormat ?docType WHERE {
      ?message sioc:has_container ${sparqlEscapeUri(conversationUri)} ;
        sioc:content ?content ;
        foaf:maker ?maker ;
        dct:created ?created .
      OPTIONAL {
        ?message as:attachment ?doc .
        OPTIONAL { ?doc nfo:fileName ?docName . }
        OPTIONAL { ?doc dct:format ?docFormat . }
        OPTIONAL { ?doc dct:type ?docType . }
      }
    } ORDER BY DESC(?created) LIMIT ${HISTORY_LIMIT * 4}`);
  const messages = [];
  const byMessage = new Map();
  for (const b of result.results.bindings.reverse()) {
    const uri = b.message.value;
    let message = byMessage.get(uri);
    if (!message) {
      message = {
        role: b.maker.value === assistantUri ? 'assistant' : 'user',
        content: b.content.value,
        attachments: [],
      };
      byMessage.set(uri, message);
      messages.push(message);
    }
    if (b.doc) {
      message.attachments.push({
        uri: b.doc.value,
        name: b.docName?.value,
        mediaType: b.docFormat?.value,
        type: b.docType?.value,
      });
    }
  }
  return messages.slice(-HISTORY_LIMIT);
}

// One message with its bijlagen, in one update that also touches the
// conversation. A title is only given for the first question: it names the
// conversation. attachments are the logical uris of files that already exist.
// Returns the message uuid.
export async function writeMessage({ conversationUri, content, maker, attachments = [], title }) {
  const id = uuid();
  const message = sparqlEscapeUri(`${MESSAGE_BASE}${id}`);
  const conversation = sparqlEscapeUri(conversationUri);
  const now = sparqlEscapeDateTime(new Date());

  await update(`${PREFIXES}
    DELETE {
      ${conversation} sioc:last_activity_date ?old .
    }
    INSERT {
      ${message} a sioc:Post , sioct:InstantMessage ;
        mu:uuid ${sparqlEscapeString(id)} ;
        sioc:has_container ${conversation} ;
        sioc:content ${sparqlEscapeString(content)} ;
        dct:created ${now} .
      ${maker ? `${message} foaf:maker ${sparqlEscapeUri(maker)} .` : ''}
      ${attachments.map(file => `${message} as:attachment ${sparqlEscapeUri(file)} .`).join('\n      ')}
      ${conversation} sioc:last_activity_date ${now} .
      ${title ? `${conversation} dct:title ${sparqlEscapeString(title)} .` : ''}
    }
    WHERE {
      OPTIONAL { ${conversation} sioc:last_activity_date ?old . }
    }`);

  return id;
}

// The report of one run, pointing at the logical file of its CSV.
export async function registerReport(title, fileUri) {
  const id = uuid();
  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(`${REPORT_BASE}${id}`)} a ${sparqlEscapeUri(REPORT_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} ;
        dct:title ${sparqlEscapeString(title)} ;
        dct:created ${sparqlEscapeDateTime(new Date())} ;
        prov:generated ${sparqlEscapeUri(fileUri)} .
    }`);
}

export function writeShareFile(fileName, content) {
  writeFileSync(`${SHARE_DIR}/${fileName}`, content, 'utf8');
}

// A new spec bijlage; returns its logical file uri. The logical and the
// physical file carry the same name, so readSpecFile finds the file by the
// name the history shows.
export async function storeSpecFile(spec) {
  const fileName = `specificatie-${uuid()}.ttl`;
  writeShareFile(fileName, spec);
  return registerFile(fileName, SPEC_MEDIA_TYPE, SPEC_TYPE);
}

// The Turtle of a spec bijlage, or null when there is no such spec file.
export function readSpecFile(fileName) {
  if (!SPEC_FILE_NAME.test(fileName || '')) return null;
  try {
    return readFileSync(`${SHARE_DIR}/${fileName}`, 'utf8');
  } catch {
    return null;
  }
}

// One logical file called `name` over the physical share file `shareName`,
// both nfo:FileDataObject with the bijlage type as dct:type. Returns the
// logical file uri. A share name must be unique: two files on one share name
// overwrite each other.
export async function registerFile(shareName, format, type, name = shareName) {
  const id = uuid();
  const logical = `${FILE_BASE}${id}`;
  const size = sparqlEscapeInt(statSync(`${SHARE_DIR}/${shareName}`).size);
  const now = sparqlEscapeDateTime(new Date());

  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(logical)} a nfo:FileDataObject ;
        mu:uuid ${sparqlEscapeString(id)} ;
        nfo:fileName ${sparqlEscapeString(name)} ;
        dct:format ${sparqlEscapeString(format)} ;
        nfo:fileSize ${size} ;
        dct:created ${now} ;
        dct:type ${sparqlEscapeUri(type)} .
      ${sparqlEscapeUri(`share://${shareName}`)} a nfo:FileDataObject ;
        mu:uuid ${sparqlEscapeString(uuid())} ;
        nfo:fileName ${sparqlEscapeString(shareName)} ;
        dct:format ${sparqlEscapeString(format)} ;
        nfo:fileSize ${size} ;
        nfo:fileCreated ${now} ;
        nie:dataSource ${sparqlEscapeUri(logical)} ;
        dct:type ${sparqlEscapeUri(type)} .
    }`);

  return logical;
}

// Deletes the conversation, its messages, their bijlagen (the logical file
// and the physical one under it) and the reports on those files, then the
// share files. Returns how many share files it removed. It runs as the
// caller, so the auth layer keeps a user to their own conversation.
export async function deleteConversation(conversationUri) {
  const conversation = sparqlEscapeUri(conversationUri);

  // The file names first: once the triples are gone they cannot be found
  // back.
  const result = await query(`${PREFIXES}
    SELECT DISTINCT ?doc ?name WHERE {
      ?message sioc:has_container ${conversation} ;
        as:attachment ?doc .
      OPTIONAL {
        ?physical nie:dataSource ?doc ;
          nfo:fileName ?name .
      }
    }`);
  const rows = result.results.bindings;
  const docs = [...new Set(rows.map(b => b.doc.value))];
  const names = [...new Set(rows.filter(b => b.name).map(b => b.name.value))];

  await update(`
    DELETE {
      ?conversation ?cp ?co .
    } WHERE {
      VALUES ?conversation { ${conversation} }
      ?conversation ?cp ?co .
    }`);

  await update(`${PREFIXES}
    DELETE {
      ?message ?mp ?mo .
    } WHERE {
      ?message sioc:has_container ${conversation} ;
        ?mp ?mo .
    }`);

  if (docs.length) {
    await update(`${PREFIXES}
      DELETE {
        ?doc ?dp ?do .
        ?physical ?pp ?po .
        ?report ?rp ?ro .
      } WHERE {
        VALUES ?doc { ${docs.map(sparqlEscapeUri).join(' ')} }
        ?doc ?dp ?do .
        OPTIONAL { ?physical nie:dataSource ?doc ; ?pp ?po . }
        OPTIONAL { ?report prov:generated ?doc ; ?rp ?ro . }
      }`);
  }

  let removed = 0;
  for (const name of names) {
    try {
      unlinkSync(`${SHARE_DIR}/${name}`);
      removed++;
    } catch {
      // the file was already gone
    }
  }
  return removed;
}
