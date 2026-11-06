// The chat's reads and writes: conversations, messages, their bijlagen and
// the reports. Everything runs as the caller.
//
// Every write and the delete run under WRITE_SCOPE when it is set. The app
// decides which graphs that scope may write, for example only the caller's
// own graph, so these types do not also land in other graphs the caller can
// write. Unset, no scope is sent.
//
// A bijlage is a real file: a logical nfo:FileDataObject the file service
// serves at /files/<uuid>/download, over a physical share:// object with
// nie:dataSource back to the logical one.
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { query, update, uuid,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime } from 'mu';

// Messages of history a turn reads.
const HISTORY_LIMIT = 20;
const REPORT_CLASS = 'http://lblod.data.gift/vocabularies/reporting/Report';
const REPORT_SPEC_CLASS = 'http://lblod.data.gift/vocabularies/reporting/ReportSpec';
const SHARE_DIR = process.env.SHARE_DIR || '/share';
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';
const FILE_BASE = 'http://data.lblod.info/files/';
const REPORT_BASE = 'http://data.lblod.info/id/reports/';
const REPORT_SPEC_BASE = 'http://data.lblod.info/id/report-specs/';
const WRITE_SCOPE = process.env.WRITE_SCOPE;
// The agent that signs the assistant's messages, seeded by the portal's
// chat-assistant migration. It is also the source (prov:wasAttributedTo) of
// every spec and report the service writes, never a person.
export const CHAT_ASSISTANT_URI = process.env.CHAT_ASSISTANT_URI || 'http://data.lblod.info/id/chat-agents/report-assistant';

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

// The conversation with this uuid, or null when it does not exist or the
// caller may not read it. This read is the access check: the caller's
// session decides what is readable.
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
// A message comes back once per bijlage, hence the wider LIMIT. The model
// needs the conversation so far; the assistant's messages are told apart by
// its agent URI (CHAT_ASSISTANT_URI).
export async function readHistory(conversationUri) {
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
        role: b.maker.value === CHAT_ASSISTANT_URI ? 'assistant' : 'user',
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
    }`, { scope: WRITE_SCOPE });

  return id;
}

// The ReportSpec of a run in the chat: the report's title, description and
// creation time, dct:isPartOf its conversation and prov:generated its
// Turtle file (the spec bijlage). The CSV belongs to the report, which
// links here with dct:conformsTo. The Turtle file is what the spec tab
// downloads and what runs again later, outside the chat. Its source
// (prov:wasAttributedTo) is the assistant agent. Returns the spec uri.
export async function registerReportSpec(title, description, conversationUri, specFileUri) {
  const id = uuid();
  const spec = `${REPORT_SPEC_BASE}${id}`;
  const descriptionLine = description
    ? `dct:description ${sparqlEscapeString(description)} ;\n        `
    : '';
  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(spec)} a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} ;
        dct:title ${sparqlEscapeString(title)} ;
        ${descriptionLine}prov:wasAttributedTo ${sparqlEscapeUri(CHAT_ASSISTANT_URI)} ;
        dct:created ${sparqlEscapeDateTime(new Date())} ;
        dct:isPartOf ${sparqlEscapeUri(conversationUri)} ;
        prov:generated ${sparqlEscapeUri(specFileUri)} .
    }`, { scope: WRITE_SCOPE });
  return spec;
}

// The report of one run, pointing at the logical file of its CSV, so it
// shows up in the reports list. The description is the short Dutch text
// written from the conversation. The report conforms to its ReportSpec
// (dct:conformsTo); a spec that runs again gets one report per run. Its
// source (prov:wasAttributedTo) is the assistant agent, also on a re-run.
export async function registerReport(title, fileUri, description, specUri) {
  const id = uuid();
  const descriptionLine = description
    ? `dct:description ${sparqlEscapeString(description)} ;\n        `
    : '';
  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(`${REPORT_BASE}${id}`)} a ${sparqlEscapeUri(REPORT_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} ;
        dct:title ${sparqlEscapeString(title)} ;
        ${descriptionLine}prov:wasAttributedTo ${sparqlEscapeUri(CHAT_ASSISTANT_URI)} ;
        dct:created ${sparqlEscapeDateTime(new Date())} ;
        prov:generated ${sparqlEscapeUri(fileUri)} ;
        dct:conformsTo ${sparqlEscapeUri(specUri)} .
    }`, { scope: WRITE_SCOPE });
}

// The ReportSpec with this uuid as { uri, title, description, specFileName },
// or null when it does not exist or the caller may not read it. This read
// is the access check: the caller's session decides what is readable.
// specFileName is the name of its Turtle file (prov:generated). A spec made
// before that pointed at its CSV there; readSpecFile refuses that name, so
// such a spec cannot run again.
export async function readReportSpec(id) {
  const result = await query(`${PREFIXES}
    SELECT ?spec ?title ?description ?specFileName WHERE {
      ?spec a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} .
      OPTIONAL { ?spec dct:title ?title . }
      OPTIONAL { ?spec dct:description ?description . }
      OPTIONAL {
        ?spec prov:generated ?specFile .
        ?specFile nfo:fileName ?specFileName .
      }
    } LIMIT 1`);
  const binding = result.results.bindings[0];
  if (!binding) return null;
  return {
    uri: binding.spec.value,
    title: binding.title?.value,
    description: binding.description?.value,
    specFileName: binding.specFileName?.value,
  };
}

// Writes a file to the share folder, where the file service serves it
// from.
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
// Only spec file names pass (SPEC_FILE_NAME): read_spec lets the model name
// the file, and it must never open a CSV.
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
// logical file uri. That is the shape the file service expects. A share
// name must be unique: two files on one share name overwrite each other.
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
        nfo:fileCreated ${now} ;
        dct:type ${sparqlEscapeUri(type)} .
      ${sparqlEscapeUri(`share://${shareName}`)} a nfo:FileDataObject ;
        mu:uuid ${sparqlEscapeString(uuid())} ;
        nfo:fileName ${sparqlEscapeString(shareName)} ;
        dct:format ${sparqlEscapeString(format)} ;
        nfo:fileSize ${size} ;
        nfo:fileCreated ${now} ;
        nie:dataSource ${sparqlEscapeUri(logical)} ;
        dct:type ${sparqlEscapeUri(type)} .
    }`, { scope: WRITE_SCOPE });

  return logical;
}

// Deletes the conversation, its messages, its report specs and the bijlagen
// no report needs (the spec files: the logical file, the physical one under
// it and the share file). The reports stay, with their CSV: they are
// results, listed under Reports. The CSV of a chat run is a bijlage of the
// answer, so a bijlage a report generated is skipped. A kept report's
// dct:conformsTo then points at a deleted spec. Returns how many share files
// it removed. It runs as the caller, so the auth layer keeps a user to their
// own conversation.
//
// Every query here runs under WRITE_SCOPE, the scope the reports and files
// were written with. Without a scope, a type the user may write in several
// graphs (reports, files) is deleted in only one of them by sparql-parser
// 0.0.15, often not the one the data is in: the spec stayed while its share
// file was removed.
export async function deleteConversation(conversationUri) {
  const conversation = sparqlEscapeUri(conversationUri);

  // The bijlagen and their share names first: once the triples are gone
  // they cannot be found back. ?report is set when a report generated the
  // bijlage; the filter happens here, not in SPARQL, to keep the query plain
  // for sparql-parser.
  const result = await query(`${PREFIXES}
    SELECT DISTINCT ?doc ?name ?report WHERE {
      ?message sioc:has_container ${conversation} ;
        as:attachment ?doc .
      OPTIONAL {
        ?physical nie:dataSource ?doc ;
          nfo:fileName ?name .
      }
      OPTIONAL {
        ?report a ${sparqlEscapeUri(REPORT_CLASS)} ;
          prov:generated ?doc .
      }
    }`, { scope: WRITE_SCOPE });
  const rows = result.results.bindings;
  const resultFiles = new Set(rows.filter(b => b.report).map(b => b.doc.value));
  const rowsToDelete = rows.filter(b => !resultFiles.has(b.doc.value));
  const docs = [...new Set(rowsToDelete.map(b => b.doc.value))];
  const names = [...new Set(rowsToDelete.filter(b => b.name).map(b => b.name.value))];

  await update(`
    DELETE {
      ?conversation ?cp ?co .
    } WHERE {
      VALUES ?conversation { ${conversation} }
      ?conversation ?cp ?co .
    }`, { scope: WRITE_SCOPE });

  await update(`${PREFIXES}
    DELETE {
      ?message ?mp ?mo .
    } WHERE {
      ?message sioc:has_container ${conversation} ;
        ?mp ?mo .
    }`, { scope: WRITE_SCOPE });

  // The specs by their conversation, not by their file: an older spec points
  // at its CSV, which stays.
  await update(`${PREFIXES}
    DELETE {
      ?spec ?sp ?so .
    } WHERE {
      ?spec a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        dct:isPartOf ${conversation} ;
        ?sp ?so .
    }`, { scope: WRITE_SCOPE });

  if (docs.length) {
    await update(`${PREFIXES}
      DELETE {
        ?doc ?dp ?do .
        ?physical ?pp ?po .
      } WHERE {
        VALUES ?doc { ${docs.map(sparqlEscapeUri).join(' ')} }
        ?doc ?dp ?do .
        OPTIONAL { ?physical nie:dataSource ?doc ; ?pp ?po . }
      }`, { scope: WRITE_SCOPE });
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
