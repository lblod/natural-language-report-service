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

export const sessionQuery = muQuery;
export const sessionUpdate = muUpdate;
export {
  sparqlEscapeUri,
  sparqlEscapeString,
  sparqlEscapeInt,
  sparqlEscapeDateTime,
  sparqlEscapeDate,
  sparqlEscapeBool,
};

// The store's error text may name graphs or internals we do not pass on.
export function stripStoreError(text) {
  return String(text).split('\n')[0].slice(0, 300);
}