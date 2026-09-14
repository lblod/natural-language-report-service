import { query as muQuery, update as muUpdate,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool } from 'mu';

export { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool };

// All SPARQL goes through the template's own helpers, like
// ipdc-bookmarks-service. They attach the caller's session
// (mu-session-id, mu-call-id) from the request context, and
// mu-authorization decides graphs and visibility. The service never
// touches an auth header itself.
export async function sessionQuery(sparql)  { return muQuery(sparql); }
export async function sessionUpdate(sparql) { return muUpdate(sparql); }

// The store's error text may name graphs or internals we do not pass on.
export function stripStoreError(text) {
  return String(text).split('\n')[0].slice(0, 300);
}

// The per-request bundle the tools use: the template's query and update.
// The request context lives for the whole run, also past the 202 the chat
// turn answers with, so mu-authorization keeps rewriting with the caller's
// session. We add nothing to it.
export async function buildSession() {
  return { query: sessionQuery, update: sessionUpdate };
}
