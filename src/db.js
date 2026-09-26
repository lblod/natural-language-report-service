// Thin re-export of mu's SPARQL helpers so the runner files share one import
// site. mu's query/update attach the caller's session from the request
// context, and mu-authorization decides graphs and visibility; the service
// never touches an auth header.
import {
  query as muQuery,
  update as muUpdate,
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeInt,
  sparqlEscapeDateTime,
  sparqlEscapeDate,
  sparqlEscapeBool,
} from 'mu';

export const sessionUpdate = muUpdate;
export {
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeInt,
  sparqlEscapeDateTime,
  sparqlEscapeDate,
  sparqlEscapeBool,
};

// The service's own scope. Reads the LLM drives during refinement (code
// lists, lookup_values) run under this scope, not the caller's session. The
// sparql-parser config grants this scope read access to the public graph
// only, so refinement reads only public data. Execution still runs as the
// caller. Set to match the with-scope grant in config.lisp.
export const SERVICE_SCOPE =
  process.env.SERVICE_SCOPE || 'http://services.semantic.works/natural-language-report';

// Wrap a mu query/update so it carries the service scope. mu's query/update
// accept { scope } on mu-javascript-template >= 1.9.0.
export function scopedQuery(q) { return muQuery(q, { scope: SERVICE_SCOPE }); }
export function scopedUpdate(q) { return muUpdate(q, { scope: SERVICE_SCOPE }); }