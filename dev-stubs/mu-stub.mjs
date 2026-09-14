// Byte-for-byte copies of the three mu helpers the chat store uses, so the
// unit test asserts on the same strings the container produces.
// Registered for the 'mu' module by dev-stubs/register.js during tests only.
export function sparqlEscapeString(value) {
  return '"""' + value.replace(/[\\"]/g, (m) => '\\' + m) + '"""';
}

// The loop test drives ask() end to end; describe/lookup tools reach the
// session helpers, so the stub implements them as no-ops.
export async function query() {
  return { results: { bindings: [] }, head: { vars: [] } };
}
export async function update() {}

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
