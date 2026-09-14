// The template's helpers, shaped for the tests: query/update record every
// SPARQL string, and a test steers the answers with setQueryHandler.
// Registered for the 'mu' module by dev-stubs/register.js during tests only.
import express from 'express';

// The template's own app, stripped to what the tests mount routes on.
export const app = express();

export const state = { queries: [], updates: [], queryHandler: null };

// Steer the stub's answers: setQueryHandler(sparql => bindings[])
export function setQueryHandler(fn) { state.queryHandler = fn; }
// Clear the recordings only; the handler stays.
export function resetMu() {
  state.queries.length = 0;
  state.updates.length = 0;
}

export async function query(sparql) {
  state.queries.push(sparql);
  return { results: { bindings: state.queryHandler ? state.queryHandler(sparql) : [] }, head: { vars: [] } };
}

export async function update(sparql) {
  state.updates.push(sparql);
  return {};
}

export function sparqlEscapeString(value) {
  return '"""' + value.replace(/[\\"]/g, (m) => '\\' + m) + '"""';
}

export function sparqlEscapeUri(value) {
  return '<' + value.replace(/[\\"<>]/g, function (match) { return '\\' + match; }) + '>';
}

export function sparqlEscapeDateTime(value) {
  return '"' + new Date(value).toISOString() + '"^^xsd:dateTime';
}

// The remaining template helpers db.js imports, copied from
// helpers/mu/sparql.js in mu-javascript-template.
export function sparqlEscapeInt(value) {
  return '"' + Number.parseInt(value) + '"^^xsd:integer';
}
export function sparqlEscapeDate(value) {
  return '"' + new Date(value).toISOString().substring(0, 10) + '"^^xsd:date';
}
export function sparqlEscapeBool(value) {
  return value ? '"true"^^xsd:boolean' : '"false"^^xsd:boolean';
}
