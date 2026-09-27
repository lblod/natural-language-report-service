// Everything the LLM reads from the database: the code lists, inlined in
// describe_profile and searched by lookup_values. Every read goes through
// publicQuery: the service scope, not the caller's session. The app grants
// that scope the public graph only, so the LLM reads public data, the same
// for every caller, and never what a report would show. Nothing here counts
// or runs a spec.
import { query, sparqlEscapeString } from 'mu';

// Must match the with-scope grant in the app's config.lisp.
const SERVICE_SCOPE = process.env.SERVICE_SCOPE || 'http://services.semantic.works/natural-language-report';
export const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const VALUES_TTL = Number(process.env.VALUES_TTL || 3600) * 1000;
const LOOKUP_LIMIT = 25;

// class → { values, at }. Every prompt with a menu needs the code lists, and
// they rarely change.
const cache = new Map();

function publicQuery(q) {
  return query(q, { scope: SERVICE_SCOPE });
}

// Up to INLINE_VALUES_MAX values [{ uri, label }] of a code list, cached for
// VALUES_TTL. Empty when the read fails; the LLM then uses rep:anyOf with
// words.
export async function codeList(type) {
  const hit = cache.get(type);
  if (hit && Date.now() - hit.at < VALUES_TTL) return hit.values;
  let values = [];
  try {
    const r = await publicQuery(`SELECT ?uri ?label WHERE {
    ?uri a <${type}> .
    OPTIONAL { ?uri <http://www.w3.org/2004/02/skos/core#prefLabel> ?label . }
  } ORDER BY ?label LIMIT ${INLINE_VALUES_MAX + 1}`);
    values = r.results.bindings.slice(0, INLINE_VALUES_MAX).map(b => ({
      uri: b.uri.value,
      label: b.label?.value || b.uri.value,
    }));
  } catch {
    values = [];
  }
  cache.set(type, { values, at: Date.now() });
  return values;
}

// The code-list values that match a term, as text for the LLM: up to
// LOOKUP_LIMIT labels and URIs, an exact label (case aside) first. field is
// "shapeLabel.fieldLabel" as the LLM writes it.
export async function lookupValues(profile, field, term) {
  const type = resolveClass(profile, field);
  if (!type) return `field "${field}" not found in profile "${profile.title}"`;

  // Search within the class first. A common word ("gemeente") also sits in
  // hundreds of unrelated labels; an unscoped scan drowns the code.
  let rows = await labelQuery(term, type);
  // A code list may type its entries differently than the profile says. Then
  // scan every label in the public graph.
  if (!rows.length) rows = await labelQuery(term, null);
  // "Gent" must surface before "AGB Erfgoed Gent".
  const lower = term.toLowerCase();
  const exactRow = rows.find(r => r.label.toLowerCase() === lower);
  const matches = (exactRow ? [exactRow, ...rows.filter(r => r !== exactRow)] : rows).slice(0, LOOKUP_LIMIT);
  if (!matches.length) return `no value matches "${term}" in ${field}.`;

  const lines = matches.map(m => `${m.label}  <${m.uri}>`);
  if (matches.length >= LOOKUP_LIMIT) lines.push(`(${LOOKUP_LIMIT}+ matches, narrow the term)`);
  if (exactRow) lines.push(`exact: <${exactRow.uri}>`);
  return lines.join('\n');
}

// Regex on str(?label), so language-tagged labels match.
async function labelQuery(term, type) {
  const q = `SELECT DISTINCT ?uri ?label WHERE {
    ?uri a ${type ? `<${type}>` : '?anyType'} ;
         <http://www.w3.org/2004/02/skos/core#prefLabel> ?label .
    FILTER(REGEX(str(?label), ${sparqlEscapeString(escapeRegex(term))}, "i"))
  } ORDER BY ?label LIMIT ${LOOKUP_LIMIT * 8}`;
  const r = await publicQuery(q);
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
