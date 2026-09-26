// The chat's reads and writes. Nothing here knows the service it lives in.
// Full URIs everywhere: the auth layer rejects a prefixed name with no
// PREFIX line with an opaque 500.
//
// A bijlage is a real file: a logical nfo:FileDataObject the file service
// serves at /files/<uuid>/download, over a physical share:// object with
// nie:dataSource back to the logical one. Every attachment carries the
// file's logical URI (see chat/attachment-file.js how those files are
// made); nothing here writes files.
import { randomUUID } from 'crypto';
import { query as muQuery, update as muUpdate,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime } from 'mu';

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
  softwareAgent: 'http://www.w3.org/ns/prov#SoftwareAgent',
};
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';

const u = sparqlEscapeUri;
const s = sparqlEscapeString;
// Full URIs, so spell the dateTime type out.
const dt = (value) => sparqlEscapeDateTime(value)
  .replace('xsd:dateTime', '<http://www.w3.org/2001/XMLSchema#dateTime>');

const bindings = (json) => json.results.bindings;

// --- reads --------------------------------------------------------------------

// The conversation by uuid, null when the caller may not read it.
export async function readConversation(id) {
  const json = await muQuery(`
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
  const json = await muQuery(`
    SELECT ?message ?content ?maker ?created ?doc ?docName ?docFormat ?docType WHERE {
      ?message ${u(T.hasContainer)} ${u(conversationUri)} ;
        ${u(T.content)} ?content ;
        ${u(T.maker)} ?maker ;
        ${u(T.created)} ?created .
      OPTIONAL {
        ?message ${u(T.attachment)} ?doc .
        OPTIONAL { ?doc ${u('http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#fileName')} ?docName . }
        OPTIONAL { ?doc ${u('http://purl.org/dc/terms/format')} ?docFormat . }
        OPTIONAL { ?doc ${u('http://purl.org/dc/terms/type')} ?docType . }
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

// The one assistant the caller can read. Throws unless there is exactly one.
export async function findAssistant() {
  const json = await muQuery(`
    SELECT ?agent WHERE { ?agent ${u(T.type)} ${u(T.softwareAgent)} . } LIMIT 2`);
  const rows = bindings(json);
  if (rows.length !== 1) {
    throw new Error(`expected one prov:SoftwareAgent, found ${rows.length}; seed one or set CHAT_ASSISTANT_URI`);
  }
  return rows[0].agent.value;
}

// --- writes -------------------------------------------------------------------

// One message, both types, its bijlagen, and the conversation touched, in
// one update. `title` is only written when given (the first question names
// an unnamed conversation). Every attachment is the logical uri of a file
// that already exists.
export async function writeMessage({ conversationUri, content, maker, attachments = [], title }) {
  const id = randomUUID();
  const uri = `${MESSAGE_BASE}${id}`;
  const now = dt(new Date());

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
  for (const attachment of attachments) {
    if (!attachment.uri) throw new Error('an attachment without a file uri');
    pairs.push(`${u(T.attachment)} ${u(attachment.uri)}`);
  }

  const conversationPairs = [`${u(T.lastActivity)} ${now}`];
  if (title) conversationPairs.push(`${u(T.title)} ${s(title)}`);

  await muUpdate(`
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
