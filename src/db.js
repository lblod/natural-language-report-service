import { query as muQuery, update as muUpdate,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool } from 'mu';

export { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool };

export async function sessionQuery(sparql)  { return muQuery(sparql); }
export async function sessionUpdate(sparql) { return muUpdate(sparql); }

// The store's error text may name graphs or internals we do not pass on.
export function stripStoreError(text) {
  return String(text).split('\n')[0].slice(0, 300);
}

// The request context lives for the whole run, also past the 202 a chat turn
// answers with, so every write stays the caller's.
export async function buildSession() {
  return { query: sessionQuery, update: sessionUpdate };
}
