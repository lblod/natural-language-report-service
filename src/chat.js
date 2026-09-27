// The chat's reads and writes: conversations, messages and their bijlagen.
// Full URIs everywhere: the auth layer rejects a prefixed name with no
// PREFIX line with an opaque 500 (the xsd: types of mu's escape helpers are
// fine).
//
// A bijlage is a real file: a logical nfo:FileDataObject the file service
// serves at /files/<uuid>/download, over a physical share:// object with
// nie:dataSource back to the logical one.
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { query, update, uuid,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime } from 'mu';

const HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT || 20);

const T = {
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  uuid: 'http://mu.semte.ch/vocabularies/core/uuid',
  thread: 'http://rdfs.org/sioc/ns#Thread',
  post: 'http://rdfs.org/sioc/ns#Post',
  instantMessage: 'http://rdfs.org/sioc/types#InstantMessage',
  hasContainer: 'http://rdfs.org/sioc/ns#has_container',
  content: 'http://rdfs.org/sioc/ns#content',
  lastActivity: 'http://rdfs.org/sioc/ns#last_activity_date',
  title: 'http://purl.org/dc/terms/title',
  created: 'http://purl.org/dc/terms/created',
  maker: 'http://xmlns.com/foaf/0.1/maker',
  attachment: 'https://www.w3.org/ns/activitystreams#attachment',
  file: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#FileDataObject',
  fileName: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName',
  fileSize: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileSize',
  fileCreated: 'http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileCreated',
  format: 'http://purl.org/dc/terms/format',
  fileType: 'http://purl.org/dc/terms/type',
  dataSource: 'http://www.semanticdesktop.org/ontologies/2007/01/19/nie#dataSource',
  generated: 'http://www.w3.org/ns/prov#generated',
};
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';
const FILE_BASE = 'http://data.lblod.info/files/';
const SHARE_DIR = process.env.SHARE_DIR || '/share';

export const SPEC_MEDIA_TYPE = 'text/turtle';
// The bijlage types. Match the add-chat-attachment-types-codelist migration
// in the portal.
export const SPEC_TYPE = 'http://lblod.data.gift/concepts/6693014e-7b7d-448c-bb24-80c9758521f3';
export const RESULT_TYPE = 'http://lblod.data.gift/concepts/28d97698-e219-4a92-bdbd-7ab367a7524e';
// Every spec file is called like this; readSpecFile opens nothing else.
const SPEC_FILE_NAME = /^specificatie-[0-9a-f-]{36}\.ttl$/;

const u = sparqlEscapeUri;
const s = sparqlEscapeString;

const bindings = (json) => json.results.bindings;

// --- reads --------------------------------------------------------------------

// The conversation by uuid, null when the caller may not read it.
export async function readConversation(id) {
  const json = await query(`
    SELECT ?conversation ?title ?creator WHERE {
      ?conversation ${u(T.type)} ${u(T.thread)} ;
        ${u(T.uuid)} ${s(id)} .
      OPTIONAL { ?conversation ${u(T.title)} ?title . }
      OPTIONAL { ?conversation ${u(T.maker)} ?creator . }
    } LIMIT 1`);
  const b = bindings(json)[0];
  if (!b) return null;
  return { uri: b.conversation.value, id, title: b.title?.value, creator: b.creator?.value };
}

// The last HISTORY_LIMIT messages, oldest first, as
// { role, content, attachments: [{ uri, name, mediaType, type }] }.
export async function readHistory(conversationUri, assistantUri) {
  const json = await query(`
    SELECT ?message ?content ?maker ?created ?doc ?docName ?docFormat ?docType WHERE {
      ?message ${u(T.hasContainer)} ${u(conversationUri)} ;
        ${u(T.content)} ?content ;
        ${u(T.maker)} ?maker ;
        ${u(T.created)} ?created .
      OPTIONAL {
        ?message ${u(T.attachment)} ?doc .
        OPTIONAL { ?doc ${u(T.fileName)} ?docName . }
        OPTIONAL { ?doc ${u(T.format)} ?docFormat . }
        OPTIONAL { ?doc ${u(T.fileType)} ?docType . }
      }
    } ORDER BY DESC(?created) LIMIT ${HISTORY_LIMIT * 4}`);
  const messages = [];
  const byMessage = new Map();
  for (const b of bindings(json).reverse()) {
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

// --- writes -------------------------------------------------------------------

// One message, both types, its bijlagen, and the conversation touched, in
// one update. `title` is only written when given (the first question names
// an unnamed conversation). attachments are the logical uris of files that
// already exist.
export async function writeMessage({ conversationUri, content, maker, attachments = [], title }) {
  const id = uuid();
  const uri = `${MESSAGE_BASE}${id}`;
  const now = sparqlEscapeDateTime(new Date());

  // Predicate pairs joined with ';', never a trailing one: it breaks the Turtle.
  const pairs = [
    `${u(T.type)} ${u(T.post)}`,
    `${u(T.type)} ${u(T.instantMessage)}`,
    `${u(T.uuid)} ${s(id)}`,
    `${u(T.hasContainer)} ${u(conversationUri)}`,
    `${u(T.content)} ${s(content)}`,
    `${u(T.created)} ${now}`,
  ];
  if (maker) pairs.push(`${u(T.maker)} ${u(maker)}`);
  for (const fileUri of attachments) {
    pairs.push(`${u(T.attachment)} ${u(fileUri)}`);
  }

  const conversationPairs = [`${u(T.lastActivity)} ${now}`];
  if (title) conversationPairs.push(`${u(T.title)} ${s(title)}`);

  await update(`
    DELETE {
      ${u(conversationUri)} ${u(T.lastActivity)} ?old .
    }
    INSERT {
      ${u(uri)} ${pairs.join(' ;\n        ')} .
      ${u(conversationUri)} ${conversationPairs.join(' ;\n        ')} .
    }
    WHERE {
      OPTIONAL { ${u(conversationUri)} ${u(T.lastActivity)} ?old . }
    }`);

  return { uri, id };
}

// --- files --------------------------------------------------------------------

export function writeShareFile(fileName, content) {
  writeFileSync(`${SHARE_DIR}/${fileName}`, content, 'utf8');
}

// storeSpecFile(spec) → the file uri of a new spec bijlage. A spec file
// keeps one name for the logical and the physical file: readSpecFile finds
// it by the name in the history.
export async function storeSpecFile(spec) {
  const fileName = `specificatie-${uuid()}.ttl`;
  writeShareFile(fileName, spec);
  return registerFile(fileName, SPEC_MEDIA_TYPE, SPEC_TYPE);
}

// readSpecFile(fileName) → the Turtle of a spec bijlage, null when there is
// no such spec file.
export function readSpecFile(fileName) {
  if (!SPEC_FILE_NAME.test(fileName || '')) return null;
  try {
    return readFileSync(`${SHARE_DIR}/${fileName}`, 'utf8');
  } catch {
    return null;
  }
}

// registerFile(shareName, format, type, name) → the logical file uri. One
// logical file called `name` over the physical share file `shareName`, both
// nfo:FileDataObject, both typed with dct:type. A share name must be
// unique: two files on one share name overwrite each other.
export async function registerFile(shareName, format, type, name = shareName) {
  const id = uuid();
  const physicalId = uuid();
  const logical = `${FILE_BASE}${id}`;
  const physical = `share://${shareName}`;
  const size = statSync(`${SHARE_DIR}/${shareName}`).size;
  const now = sparqlEscapeDateTime(new Date());

  await update(`
    INSERT DATA {
      ${u(logical)} ${u(T.type)} ${u(T.file)} ;
        ${u(T.uuid)} ${s(id)} ;
        ${u(T.fileName)} ${s(name)} ;
        ${u(T.format)} ${s(format)} ;
        ${u(T.fileSize)} ${sparqlEscapeInt(size)} ;
        ${u(T.created)} ${now} ;
        ${u(T.fileType)} ${u(type)} .
      ${u(physical)} ${u(T.type)} ${u(T.file)} ;
        ${u(T.uuid)} ${s(physicalId)} ;
        ${u(T.fileName)} ${s(shareName)} ;
        ${u(T.format)} ${s(format)} ;
        ${u(T.fileSize)} ${sparqlEscapeInt(size)} ;
        ${u(T.fileCreated)} ${now} ;
        ${u(T.dataSource)} ${u(logical)} ;
        ${u(T.fileType)} ${u(type)} .
    }`);

  return logical;
}

// --- deletes -------------------------------------------------------------------

// deleteConversation(uri) → the share files it removed (a number). Deletes
// the conversation, its messages, their bijlagen (the logical file and the
// physical one under it) and the reports of those files, then removes the
// share files. Everything runs as the caller, so the auth layer keeps a
// user to their own conversation.
export async function deleteConversation(conversationUri) {
  // The bijlagen first: once the triples are gone their names cannot be
  // found back.
  const json = await query(`
    SELECT DISTINCT ?doc ?name WHERE {
      ?message ${u(T.hasContainer)} ${u(conversationUri)} ;
        ${u(T.attachment)} ?doc .
      OPTIONAL {
        ?physical ${u(T.dataSource)} ?doc ;
          ${u(T.fileName)} ?name .
      }
    }`);
  const rows = bindings(json);
  const docs = [...new Set(rows.map(b => b.doc.value))];
  const names = [...new Set(rows.filter(b => b.name).map(b => b.name.value))];

  await update(`
    DELETE {
      ?conversation ?cp ?co .
    } WHERE {
      VALUES ?conversation { ${u(conversationUri)} }
      ?conversation ?cp ?co .
    }`);

  await update(`
    DELETE {
      ?message ?mp ?mo .
    } WHERE {
      ?message ${u(T.hasContainer)} ${u(conversationUri)} ;
        ?mp ?mo .
    }`);

  if (docs.length) {
    await update(`
      DELETE {
        ?doc ?dp ?do .
        ?physical ?pp ?po .
        ?report ?rp ?ro .
      } WHERE {
        VALUES ?doc { ${docs.map(u).join(' ')} }
        ?doc ?dp ?do .
        OPTIONAL { ?physical ${u(T.dataSource)} ?doc ; ?pp ?po . }
        OPTIONAL { ?report ${u(T.generated)} ?doc ; ?rp ?ro . }
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
