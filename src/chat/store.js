// The chat's reads and writes. Copy the folder as is; nothing here knows the
// service it lives in. Full URIs everywhere: the auth layer rejects a prefixed
// name with no PREFIX line with an opaque 500.
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
  document: 'https://www.w3.org/ns/activitystreams#Document',
  name: 'https://www.w3.org/ns/activitystreams#name',
  mediaType: 'https://www.w3.org/ns/activitystreams#mediaType',
  url: 'https://www.w3.org/ns/activitystreams#url',
  softwareAgent: 'http://www.w3.org/ns/prov#SoftwareAgent',
};
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';
const DOCUMENT_BASE = 'http://data.lblod.info/id/chat-documents/';

const u = sparqlEscapeUri;
const s = sparqlEscapeString;
// The template helper writes ^^xsd:dateTime; the auth layer happens to bind
// xsd, but the rule here is full URIs, so spell the type out.
const dt = (value) => sparqlEscapeDateTime(value)
  .replace('xsd:dateTime', '<http://www.w3.org/2001/XMLSchema#dateTime>');

const bindings = (json) => json.results.bindings;

// --- reads --------------------------------------------------------------------

// The conversation by uuid, as the caller sees it (the query carries the
// caller's session; the auth layer answers with what they may read).
// null when not readable.
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

// The last HISTORY_LIMIT messages, oldest first, as { role, content }.
export async function readHistory(conversationUri, assistantUri) {
  const json = await muQuery(`
    SELECT ?content ?maker ?created WHERE {
      ?message ${u(T.hasContainer)} ${u(conversationUri)} ;
        ${u(T.content)} ?content ;
        ${u(T.maker)} ?maker ;
        ${u(T.created)} ?created .
    } ORDER BY DESC(?created) LIMIT ${HISTORY_LIMIT}`);
  return bindings(json).reverse().map(b => ({
    role: b.maker.value === assistantUri ? 'assistant' : 'user',
    content: b.content.value,
  }));
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

// One message, both types, its attachments, and the conversation touched, in
// one update. `title` is only written when given (the first question names
// an unnamed conversation). Returns { uri, id, documents: [{ uri, id }] }.
export async function writeMessage({ conversationUri, content, maker, attachments = [], title }) {
  const id = randomUUID();
  const uri = `${MESSAGE_BASE}${id}`;
  const now = dt(new Date());
  const documents = attachments.map(a => {
    const id = randomUUID();
    return { ...a, id, uri: `${DOCUMENT_BASE}${id}` };
  });

  // Predicate pairs are joined with a semicolon, so no list ever ends on one.
  const pairs = [
    `${u(T.type)} ${u(T.post)}`,
    `${u(T.type)} ${u(T.instantMessage)}`,
    `${u(T.uuid)} ${s(id)}`,
    `${u(T.hasContainer)} ${u(conversationUri)}`,
    `${u(T.content)} ${s(content)}`,
    `${u(T.created)} ${now}`,
  ];
  if (maker) pairs.push(`${u(T.maker)} ${u(maker)}`);
  for (const d of documents) pairs.push(`${u(T.attachment)} ${u(d.uri)}`);

  const conversationPairs = [`${u(T.lastActivity)} ${now}`];
  if (title) conversationPairs.push(`${u(T.title)} ${s(title)}`);

  await muUpdate(`
    DELETE {
      ${u(conversationUri)} ${u(T.lastActivity)} ?old .
    }
    INSERT {
      ${u(uri)} ${pairs.join(' ;\n        ')} .
      ${documents.map(d => `
      ${u(d.uri)} ${[
        `${u(T.type)} ${u(T.document)}`,
        `${u(T.uuid)} ${s(d.id)}`,
        `${u(T.name)} ${s(d.name)}`,
        `${u(T.mediaType)} ${s(d.mediaType || 'application/octet-stream')}`,
        ...(d.url ? [`${u(T.url)} ${s(d.url)}`] : []),
      ].join(' ;\n        ')} .`).join('')}
      ${u(conversationUri)} ${conversationPairs.join(' ;\n        ')} .
    }
    WHERE {
      OPTIONAL { ${u(conversationUri)} ${u(T.lastActivity)} ?old . }
    }`);

  return { uri, id, documents: documents.map(({ uri, id }) => ({ uri, id })) };
}

// The file is ready.
export async function setDocumentUrl(documentUri, url, conversationUri) {
  const now = dt(new Date());
  await muUpdate(`
    DELETE {
      ${u(documentUri)} ${u(T.url)} ?oldUrl .
      ${u(conversationUri)} ${u(T.lastActivity)} ?old .
    }
    INSERT {
      ${u(documentUri)} ${u(T.url)} ${s(url)} .
      ${u(conversationUri)} ${u(T.lastActivity)} ${now} .
    }
    WHERE {
      OPTIONAL { ${u(documentUri)} ${u(T.url)} ?oldUrl . }
      OPTIONAL { ${u(conversationUri)} ${u(T.lastActivity)} ?old . }
    }`);
}

// The file failed. The card disappears; the caller says why in a message.
export async function dropDocument(documentUri) {
  await muUpdate(`
    DELETE {
      ?message ${u(T.attachment)} ${u(documentUri)} .
      ${u(documentUri)} ?p ?o .
    }
    WHERE {
      ${u(documentUri)} ?p ?o .
      OPTIONAL { ?message ${u(T.attachment)} ${u(documentUri)} . }
    }`);
}
