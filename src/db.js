import { query as muQuery, update as muUpdate,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool } from 'mu';

export { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt,
         sparqlEscapeDateTime, sparqlEscapeDate, sparqlEscapeBool };

// The caller's session. Everything that touches report data.
// mu attaches mu-session-id / mu-auth-allowed-groups from the incoming
// request itself; we never set headers here.
export async function sessionQuery(sparql)  { return muQuery(sparql); }
export async function sessionUpdate(sparql) { return muUpdate(sparql); }

// The fetch paths below bypass the template's query helpers, so their
// logging (LOG_SPARQL_ALL / LOG_SPARQL_QUERIES / LOG_SPARQL_UPDATES, the
// same switches helpers/mu/sparql.js reads) is mirrored here.
const LOG_QUERIES = process.env.LOG_SPARQL_QUERIES != undefined
  ? /^(true|1)$/i.test(process.env.LOG_SPARQL_QUERIES)
  : /^(true|1)$/i.test(process.env.LOG_SPARQL_ALL || '');
const LOG_UPDATES = process.env.LOG_SPARQL_UPDATES != undefined
  ? /^(true|1)$/i.test(process.env.LOG_SPARQL_UPDATES)
  : /^(true|1)$/i.test(process.env.LOG_SPARQL_ALL || '');
function logSparql(kind, sparql) {
  console.log(`[sparql] ${kind}:\n${sparql}`);
}

// No session. Only what the stack makes public. Everything shown to the LLM.
// Bare HTTP POST: muQuery always attaches the request's session, which would
// widen or narrow the answer depending on the caller.
export async function publicQuery(sparql) {
  if (LOG_QUERIES) logSparql('query', sparql);
  const res = await fetch(`${process.env.MU_SPARQL_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query: sparql }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`public query failed (${res.status}): ${stripStoreError(text)}`);
  }
  return res.json();
}

// A bare update, the same trick as publicQuery. muUpdate would attach the
// request's session; job writes after the 202 must not depend on it.
export async function plainUpdate(sparql, extraHeaders = {}) {
  if (LOG_UPDATES) logSparql('update', sparql);
  const res = await fetch(`${process.env.MU_SPARQL_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-update',
      ...extraHeaders,
    },
    body: sparql,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`update failed (${res.status}): ${stripStoreError(text)}`);
  }
}

// Background half of a run. Call captureGroups() once inside the request,
// then send the captured header on every query after the 202: the template
// stops attaching the session once the request is answered, and the auth
// layer would silently answer from the public graph.
export async function captureGroups(sessionQueryFn) {
  const probe = await sessionQueryFn('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');
  const header = probe.headers?.['mu-auth-allowed-groups'];
  if (!header) {
    throw new Error('no mu-auth-allowed-groups header on the first response; cannot carry the identity past the 202');
  }
  return header;
}

export async function groupsQuery(sparql, allowedGroups) {
  if (LOG_QUERIES) logSparql('query', sparql);
  const res = await fetch(`${process.env.MU_SPARQL_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/sparql-results+json',
      'mu-auth-allowed-groups': allowedGroups,
    },
    body: new URLSearchParams({ query: sparql }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`query failed (${res.status}): ${stripStoreError(text)}`);
  }
  return res.json();
}

export async function groupsUpdate(sparql, allowedGroups, extraHeaders = {}) {
  if (LOG_UPDATES) logSparql('update', sparql);
  const res = await fetch(`${process.env.MU_SPARQL_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-update',
      'mu-auth-allowed-groups': allowedGroups,
      ...extraHeaders,
    },
    body: sparql,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`update failed (${res.status}): ${stripStoreError(text)}`);
  }
  return res.json();
}

// The store's error text may name graphs or internals we do not pass on.
export function stripStoreError(text) {
  return String(text).split('\n')[0].slice(0, 300);
}

// The per-request session bundle the MCP tools use. Built here (next to the
// other mu-touching code) so llm/ never imports from 'mu' or sessionQuery
// (CI checks 1 and 2). Read tools use the caller's session through muQuery;
// run_report captures the groups once and runs in the background with them.
export async function buildSession() {
  const query = async (sparql) => muQuery(sparql);
  let groupsCache = null;
  return {
    query,
    get groups() {
      if (!groupsCache) groupsCache = captureGroups(query);
      return groupsCache;
    },
  };
}