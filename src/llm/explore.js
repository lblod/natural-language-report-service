// Everything the LLM reads from the database: the code lists, inlined in
// describe_profile and searched by lookup_values. Every read goes through
// queryPublic: the service scope, not the caller's session. The app grants
// that scope the public graph only, so the LLM reads public data, the same
// for every caller, and never what a report would show. Nothing here counts
// or runs a spec.
import { query, sparqlEscapeString } from 'mu';

// Must match the with-scope grant in the app's config.lisp.
const SERVICE_SCOPE = process.env.SERVICE_SCOPE || 'http://services.semantic.works/natural-language-report';
const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const LOOKUP_LIMIT = 25;

// Every read of the LLM goes through here, under the service scope: public
// data only, the same for every caller.
function queryPublic(q) {
  return query(q, { scope: SERVICE_SCOPE });
}

// Up to INLINE_VALUES_MAX values [{ uri, label }] of a class, read fresh on
// every call, as { values, more }. more is true when the class holds more
// instances: the query asks one row extra to know that. No ORDER BY in the
// query: the menu asks this for every linked entity, and sorting a class of
// thousands to show nothing would cost the most; the few rows are sorted
// here. Empty when the read fails; the LLM then uses rep:anyOf with words.
export async function fetchCodeList(type) {
  let values = [];
  let more = false;
  try {
    const r = await queryPublic(`SELECT ?uri ?label WHERE {
    ?uri a <${type}> .
    OPTIONAL { ?uri <http://www.w3.org/2004/02/skos/core#prefLabel> ?label . }
  } LIMIT ${INLINE_VALUES_MAX + 1}`);
    values = r.results.bindings.slice(0, INLINE_VALUES_MAX).map(b => ({
      uri: b.uri.value,
      label: b.label?.value || b.uri.value,
    })).sort((a, b) => a.label.localeCompare(b.label));
    more = r.results.bindings.length > INLINE_VALUES_MAX;
  } catch {
    values = [];
  }
  return { values, more };
}

// The code-list values that match a term, as text for the LLM: up to
// LOOKUP_LIMIT labels and URIs, an exact label (case aside) first. field is
// "shapeLabel.fieldLabel" as the LLM writes it.
export async function lookupValues(profile, field, term) {
  const type = resolveClass(profile, field);
  if (!type) return `field "${field}" not found in profile "${profile.title}"`;

  // Only within the class: a common word ("gemeente") also sits in hundreds
  // of unrelated labels. Nothing found means the model falls back on a
  // sh:pattern on the name, as the prompt says; the answer tells it whether
  // the class has any readable instance at all, so a miss on a class the
  // service cannot read is not taken for a misspelling.
  const rows = await queryLabels(term, type);
  // "Gent" must surface before "AGB Erfgoed Gent".
  const lower = term.toLowerCase();
  const exactRow = rows.find(r => r.label.toLowerCase() === lower);
  const matches = (exactRow ? [exactRow, ...rows.filter(r => r !== exactRow)] : rows).slice(0, LOOKUP_LIMIT);
  if (!matches.length) {
    const any = await queryPublic(`ASK { ?uri a <${type}> }`);
    if (!any.boolean) return `nothing of ${field} is in the part of the database you read: match the name text with sh:pattern.`;
    return `no value matches "${term}" in ${field}. You read only part of the database, so the value may well exist where the report runs: match the name text with sh:pattern, or try another spelling first.`;
  }

  const lines = matches.map(m => `${m.label}  <${m.uri}>`);
  if (matches.length >= LOOKUP_LIMIT) lines.push(`(${LOOKUP_LIMIT}+ matches, narrow the term)`);
  if (exactRow) lines.push(`exact: <${exactRow.uri}>`);
  return lines.join('\n');
}

// The labels of one class that contain the term. Regex on str(?label), so
// language-tagged labels match.
async function queryLabels(term, type) {
  const q = `SELECT DISTINCT ?uri ?label WHERE {
    ?uri a <${type}> ;
         <http://www.w3.org/2004/02/skos/core#prefLabel> ?label .
    FILTER(REGEX(str(?label), ${sparqlEscapeString(escapeRegex(term))}, "i"))
  } ORDER BY ?label LIMIT ${LOOKUP_LIMIT * 8}`;
  const r = await queryPublic(q);
  return r.results.bindings.map(b => ({ label: b.label.value, uri: b.uri.value }));
}

// The class to search for "shapeLabel.fieldLabel": the field's sh:class, or
// for a link (sh:node) the linked shape's sh:targetClass
// ("melding.bestuurseenheid" gives besluit:Bestuurseenheid). For a value
// field it is the shape's own class: the model writes "bestuurseenheid.naam"
// when it looks for a bestuurseenheid.
function resolveClass(profile, field) {
  const dot = field.lastIndexOf('.');
  if (dot < 0) return null;
  const shape = profile.shapes.find(s => s.label === field.slice(0, dot));
  if (!shape) return null;
  const f = shape.fields.find(x => x.name === field.slice(dot + 1));
  if (f?.class) return f.class;
  if (f?.nodes.length) {
    // sh:or of several entities: only when they share one class
    const classes = new Set(f.nodes.map(n => profile.shapes.find(s => s.uri === n)?.targetClass || null));
    return classes.size === 1 ? [...classes][0] : null;
  }
  return shape.targetClass;
}

// The term as plain text inside a regex: a "(" in a name must not break the
// query.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
