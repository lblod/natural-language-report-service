// The LLM's own reads: code lists. They run under the service scope, not
// the caller's session; the sparql-parser config grants that scope read
// access to the public graph only, so they read the same for every caller.
// Execution still runs as the caller.
//
// lookup_values is a suggest helper, not a spec check. It reads candidate
// values the LLM can put in a filter; it never runs the spec and never sees
// report rows.
import { query, sparqlEscapeString } from 'mu';

// Must match the with-scope grant in the app's config.lisp.
const SERVICE_SCOPE = process.env.SERVICE_SCOPE || 'http://services.semantic.works/natural-language-report';
export const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const VALUES_TTL = Number(process.env.VALUES_TTL || 3600) * 1000;
const LIMIT = 25;

// class → { values, at }. Refreshed lazily when stale.
const cache = new Map();

function publicQuery(q) {
  return query(q, { scope: SERVICE_SCOPE });
}

// codeList(type) → up to INLINE_VALUES_MAX [{ uri, label }], cached for
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
  } catch (e) {
    values = [];
  }
  cache.set(type, { values, at: Date.now() });
  return values;
}

// lookupValues(profile, field, term) → the matches as text for the LLM: up
// to LIMIT labels and URIs, an exact label (case aside) first. field is
// "shapeLabel.fieldLabel" as the LLM writes it; it resolves to the class to
// search.
export async function lookupValues(profile, field, term) {
  const type = resolveClass(profile, field);
  if (!type) return `field "${field}" not found in profile "${profile.title}"`;

  // Search within the class first. A common word ("gemeente") also sits in
  // hundreds of unrelated labels; an unscoped scan drowns the code.
  let rows = await labelQuery(term, type);
  // Code lists sometimes type their entries differently than the profile
  // says (MAR codes are ext:supervision/Nomenclature, the profile says
  // skos:Concept). Fall back to a scan over everything.
  if (!rows.length) rows = await labelQuery(term, null);
  // "Gent" must surface before "AGB Erfgoed Gent".
  const lower = term.toLowerCase();
  const exactRow = rows.find(r => r.label.toLowerCase() === lower);
  let matches = (exactRow ? [exactRow, ...rows.filter(r => r !== exactRow)] : rows).slice(0, LIMIT);
  if (!matches.length) matches = await codeQuery(term);
  if (!matches.length) return `no value matches "${term}" in ${field}.`;

  const lines = matches.map(m => `${m.label}  <${m.uri}>`);
  if (matches.length >= LIMIT) lines.push(`(${LIMIT}+ matches, narrow the term)`);
  const exact = matches.find(m => m.label.toLowerCase() === lower);
  if (exact) lines.push(`exact: <${exact.uri}>`);
  return lines.join('\n');
}

// Regex on str(?label), so language-tagged labels match.
async function labelQuery(term, type) {
  const q = `SELECT DISTINCT ?uri ?label WHERE {
    ?uri a ${type ? `<${type}>` : '?anyType'} ;
         <http://www.w3.org/2004/02/skos/core#prefLabel> ?label .
    FILTER(REGEX(str(?label), ${sparqlEscapeString(escapeRegex(term))}, "i"))
  } ORDER BY ?label LIMIT ${LIMIT * 8}`;
  const r = await publicQuery(q);
  return r.results.bindings.map(b => ({ label: b.label.value, uri: b.uri.value }));
}

// MAR codes: the label says "MAR7300 - …" but the searchable code sits on
// ext:supervision/nomenclatureCode. One extra query, only when the label
// search came up empty.
async function codeQuery(term) {
  const q = `SELECT ?uri ?label WHERE {
    ?uri <http://mu.semte.ch/vocabularies/ext/supervision/nomenclatureCode> ?code ;
         <http://www.w3.org/2004/02/skos/core#prefLabel> ?label .
    FILTER(CONTAINS(LCASE(str(?code)), LCASE(${sparqlEscapeString(term)})))
  } ORDER BY ?label LIMIT ${LIMIT}`;
  try {
    const r = await publicQuery(q);
    return r.results.bindings.map(b => ({ label: b.label.value, uri: b.uri.value }));
  } catch {
    return [];
  }
}

// "shapeLabel.fieldLabel" → the class to search: the field's sh:class, or
// for a link (sh:node) the linked shape's sh:targetClass
// ("melding.bestuurseenheid" → besluit:Bestuurseenheid).
function resolveClass(profile, field) {
  if (field.includes('/')) return null;
  const dot = field.lastIndexOf('.');
  if (dot < 0) return null;
  const shapeLabel = field.slice(0, dot);
  const fieldLabel = field.slice(dot + 1);
  const shape = profile.shapes.find(s => s.label === shapeLabel);
  if (!shape) return null;
  const f = shape.fields.find(x => x.name === fieldLabel);
  if (f?.class) return f.class;
  if (f?.node) {
    const linked = profile.shapes.find(s => s.uri === f.node);
    return linked?.targetClass || null;
  }
  // The model sometimes writes shape.field on a linked shape
  // ("bestuurseenheid.naam"); resolve it to that shape's target class.
  for (const s of profile.shapes) {
    if (s.label === shapeLabel || shortType(s.targetClass) === shapeLabel) {
      return s.targetClass;
    }
  }
  return null;
}

function shortType(cls) {
  return cls.split('#').pop() || cls.split('/').pop();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
