// Everything the LLM reads from the database in refine mode. Every query
// goes through publicQuery: the service scope, not the caller's session.
// The sparql-parser config grants that scope read access to the public
// graph only, so these reads are the same for every caller. Nothing here
// counts, and execution still runs as the caller.
// - code lists: inlined in describe_profile, searched by lookup_values;
// - explore_data: the predicates, values and links of one target class;
// - sample_spec: the queries of a draft spec, for a few subjects.
// A suggestion, not a check: the report runs as the user and may find other
// data.
import { query, sparqlEscapeUri, sparqlEscapeString } from 'mu';
import { startShape } from '../runner/profile.js';
import { seedPageQuery } from '../runner/seed.js';
import { groupColumns, groupQuery, collect } from '../runner/columns.js';
import { assemble } from '../runner/assemble.js';

// Must match the with-scope grant in the app's config.lisp.
const SERVICE_SCOPE = process.env.SERVICE_SCOPE || 'http://services.semantic.works/natural-language-report';
export const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const VALUES_TTL = Number(process.env.VALUES_TTL || 3600) * 1000;
const LOOKUP_LIMIT = 25;
const SAMPLE_SIZE = 10;
const MAX_ROWS = 30;
const EXAMPLES = 3;
const MAX_VALUE_LENGTH = 60;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

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
// to LOOKUP_LIMIT labels and URIs, an exact label (case aside) first. field is
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
  let matches = (exactRow ? [exactRow, ...rows.filter(r => r !== exactRow)] : rows).slice(0, LOOKUP_LIMIT);
  if (!matches.length) matches = await codeQuery(term);
  if (!matches.length) return `no value matches "${term}" in ${field}.`;

  const lines = matches.map(m => `${m.label}  <${m.uri}>`);
  if (matches.length >= LOOKUP_LIMIT) lines.push(`(${LOOKUP_LIMIT}+ matches, narrow the term)`);
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
  } ORDER BY ?label LIMIT ${LOOKUP_LIMIT * 8}`;
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
  } ORDER BY ?label LIMIT ${LOOKUP_LIMIT}`;
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

// exploreClass(profile, cls) → text for the LLM. cls must be a
// sh:targetClass of the profile.
export async function exploreClass(profile, cls) {
  const shapes = profile.shapes.filter(s => s.targetClass === cls);
  if (!shapes.length) {
    const classes = [...new Set(profile.shapes.map(s => s.targetClass).filter(Boolean))];
    return `<${cls}> is no sh:targetClass in "${profile.title}". You can explore: ${classes.map(c => `<${c}>`).join(', ')}.`;
  }

  const sample = await publicQuery(`SELECT DISTINCT ?s WHERE {
    ?s a ${sparqlEscapeUri(cls)} .
  } LIMIT ${SAMPLE_SIZE}`);
  const subjects = sample.results.bindings.map(b => sparqlEscapeUri(b.s.value));
  if (!subjects.length) {
    return `no <${cls}> in the public data. That says nothing about the report: it runs as the user.`;
  }

  const outgoing = await publicQuery(`SELECT DISTINCT ?p ?o ?type WHERE {
    VALUES ?s { ${subjects.join(' ')} }
    ?s ?p ?o .
    OPTIONAL { ?o a ?type . }
  }`);
  const incoming = await publicQuery(`SELECT DISTINCT ?p ?type WHERE {
    VALUES ?s { ${subjects.join(' ')} }
    ?x ?p ?s .
    OPTIONAL { ?x a ?type . }
  }`);

  const lines = [`A sample of ${subjects.length} <${cls}> from the public data. It shows what the data looks like;
it is no check of a spec, and the report may run on other data.
Out = the instance points to it, In = something points to the instance.
→ / ← give the class of the linked node: explore it to follow the path.
A predicate "not in the profile" cannot be used in a spec.
`];

  const out = new Map();
  for (const b of outgoing.results.bindings) {
    if (b.p.value === RDF_TYPE) continue;
    const entry = out.get(b.p.value) || { examples: new Set(), types: new Set() };
    if (entry.examples.size < EXAMPLES) entry.examples.add(showValue(b.o));
    if (b.type) entry.types.add(`<${b.type.value}>`);
    out.set(b.p.value, entry);
  }
  for (const [p, { examples, types }] of out) {
    const linked = types.size ? `  → ${[...types].join(', ')}` : '';
    lines.push(`Out <${p}>  ${fieldName(shapes, p, false)}${linked}  e.g. ${[...examples].join(' | ')}`);
  }

  const inc = new Map();
  for (const b of incoming.results.bindings) {
    const types = inc.get(b.p.value) || new Set();
    if (b.type) types.add(`<${b.type.value}>`);
    inc.set(b.p.value, types);
  }
  for (const [p, types] of inc) {
    const linked = types.size ? `  ← ${[...types].join(', ')}` : '';
    lines.push(`In  <${p}>  ${fieldName(shapes, p, true)}${linked}`);
  }

  return lines.join('\n');
}

// sampleSpec(spec, profile) → text for the LLM: the rows of up to
// SAMPLE_SIZE subjects the spec finds in the public data. The spec has
// passed checkSpec. Same query builders as the run, other identity.
export async function sampleSpec(spec, profile) {
  const seed = await publicQuery(seedPageQuery(spec, SAMPLE_SIZE, 0, startShape(profile, spec)));
  const subjects = seed.results.bindings.map(b => b.s.value);
  if (!subjects.length) {
    return 'the spec finds nothing in the public data. That says nothing about the report: it runs as the user, on data you cannot see.';
  }

  const values = new Map();
  for (const group of groupColumns(spec.columns)) {
    collect(await publicQuery(groupQuery(group, subjects)), group, values);
  }
  const [header, ...rows] = assemble(subjects, values, spec);

  const table = [header.join(' | '), ...rows.slice(0, MAX_ROWS).map(row => row.map(showCell).join(' | '))];
  return `A sample from the public data: rows for up to ${SAMPLE_SIZE} subjects the spec finds there.
The report runs as the user and may find other rows. Use it to see whether paths and filters
land where you expect, not to tell the user what the report will hold.

${table.join('\n')}`;
}

function showCell(cell) {
  const text = String(cell ?? '');
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
}

// The profile field a predicate is, on any entity with this class.
function fieldName(shapes, predicate, inverse) {
  const names = [];
  for (const shape of shapes) {
    const f = shape.fields.find(x => x.path === predicate && !!x.inverse === inverse);
    if (f) names.push(shapes.length > 1 ? `"${f.name}" of ${shape.label}` : `"${f.name}"`);
  }
  return names.length ? `field ${names.join(', ')}${inverse ? ' (inverse)' : ''}` : 'not in the profile';
}

// A SPARQL JSON term as the LLM would write it in Turtle.
function showValue(term) {
  if (term.type === 'uri') return `<${term.value}>`;
  if (term.type === 'bnode') return '[blank node]';
  const text = term.value.length > MAX_VALUE_LENGTH ? `${term.value.slice(0, MAX_VALUE_LENGTH)}…` : term.value;
  if (term['xml:lang']) return `${JSON.stringify(text)}@${term['xml:lang']}`;
  if (!term.datatype) return JSON.stringify(text);
  const datatype = term.datatype.startsWith(XSD) ? term.datatype.replace(XSD, 'xsd:') : `<${term.datatype}>`;
  return `${JSON.stringify(text)}^^${datatype}`;
}
