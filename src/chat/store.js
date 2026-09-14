// The chat's reads and writes. Copy the folder as is; nothing here knows the
// service it lives in. Full URIs everywhere: the auth layer rejects a prefixed
// name with no PREFIX line with an opaque 500.
import { randomUUID } from 'crypto';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime } from 'mu';

const ENDPOINT = process.env.MU_SPARQL_ENDPOINT;
const HISTORY_LIMIT = Number(process.env.CHAT_HISTORY_LIMIT || 20);

// The mu template logs mu.query/mu.update the same way (helpers/mu/sparql.js);
// these fetch paths bypass it, so log here under the same switches.
const LOG_QUERIES = process.env.LOG_SPARQL_QUERIES != undefined
  ? /^(true|1)$/i.test(process.env.LOG_SPARQL_QUERIES)
  : /^(true|1)$/i.test(process.env.LOG_SPARQL_ALL || '');
const LOG_UPDATES = process.env.LOG_SPARQL_UPDATES != undefined
  ? /^(true|1)$/i.test(process.env.LOG_SPARQL_UPDATES)
  : /^(true|1)$/i.test(process.env.LOG_SPARQL_ALL || '');
function logSparql(kind, sparql) {
  console.log(`[sparql] ${kind}:\n${sparql}`);
}

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

// --- the two ways to talk to the auth layer ---------------------------------

// With the caller's session, inside the request. Returns the JSON result and
// the allowed-groups header, which is the identity we carry past the 202.
// A bare fetch rather than mu.query: the header is on the response, and this
// way we do not depend on what the template's helper chooses to return.
export async function sessionQuery(sparql, sessionId) {
  if (LOG_QUERIES) logSparql('query', sparql);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'mu-session-id': sessionId,
    },
    body: new URLSearchParams({ query: sparql }).toString(),
  });
  if (!res.ok) throw new Error(`query failed (${res.status}): ${firstLine(await res.text())}`);
  return { json: await res.json(), groups: res.headers.get('mu-auth-allowed-groups') };
}

// With the captured groups, after the 202.
export async function groupsQuery(sparql, groups) {
  if (LOG_QUERIES) logSparql('query', sparql);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'mu-auth-allowed-groups': groups,
    },
    body: new URLSearchParams({ query: sparql }).toString(),
  });
  if (!res.ok) throw new Error(`query failed (${res.status}): ${firstLine(await res.text())}`);
  return res.json();
}

export async function groupsUpdate(sparql, groups) {
  if (LOG_UPDATES) logSparql('update', sparql);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sparql-update', 'mu-auth-allowed-groups': groups },
    body: sparql,
  });
  if (!res.ok) throw new Error(`update failed (${res.status}): ${firstLine(await res.text())}`);
}

function firstLine(text) { return String(text).split('\n')[0].slice(0, 300); }
const bindings = (json) => json.results.bindings;

// --- reads --------------------------------------------------------------------

// The conversation by uuid, as the caller sees it. null when not readable.
// Also returns the allowed groups from the same round trip.
export async function readConversation(id, sessionId) {
  const { json, groups } = await sessionQuery(`
    SELECT ?conversation ?title ?creator WHERE {
      ?conversation ${u(T.type)} ${u(T.thread)} ;
        ${u(T.uuid)} ${s(id)} .
      OPTIONAL { ?conversation ${u(T.title)} ?title . }
      OPTIONAL { ?conversation ${u(T.maker)} ?creator . }
    } LIMIT 1`, sessionId);
  const b = bindings(json)[0];
  if (!b) return null;
  if (!groups) throw new Error('no mu-auth-allowed-groups header on the conversation read; cannot carry the identity past the 202');
  return { uri: b.conversation.value, id, title: b.title?.value, creator: b.creator?.value, groups };
}

// The last HISTORY_LIMIT messages, oldest first, as { role, content }.
export async function readHistory(queryFn, conversationUri, assistantUri) {
  const json = await queryFn(`
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
export async function findAssistant(queryFn) {
  const json = await queryFn(`
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
export async function writeMessage(updateFn, { conversationUri, content, maker, attachments = [], title }) {
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

  await updateFn(`
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
export async function setDocumentUrl(updateFn, documentUri, url, conversationUri) {
  const now = dt(new Date());
  await updateFn(`
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
export async function dropDocument(updateFn, documentUri) {
  await updateFn(`
    DELETE {
      ?message ${u(T.attachment)} ${u(documentUri)} .
      ${u(documentUri)} ?p ?o .
    }
    WHERE {
      ${u(documentUri)} ?p ?o .
      OPTIONAL { ?message ${u(T.attachment)} ${u(documentUri)} . }
    }`);
}
