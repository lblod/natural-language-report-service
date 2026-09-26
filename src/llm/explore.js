// The LLM's exploration of the public data, beyond the code lists. Both
// read under the service scope only (publicQuery, see lookup.js) and count
// nothing:
// - explore_data: the predicates, values and links of one target class;
// - sample_spec: the queries of a draft spec, for a few subjects.
// A suggestion, not a check: the report runs as the user and may find other
// data.
import { sparqlEscapeUri } from 'mu';
import { publicQuery } from './lookup.js';
import { startShape } from '../runner/profile.js';
import { seedPageQuery } from '../runner/seed.js';
import { groupColumns, groupQuery, collect } from '../runner/columns.js';
import { assemble } from '../runner/assemble.js';

const SAMPLE_SIZE = 10;
const MAX_ROWS = 30;
const EXAMPLES = 3;
const MAX_VALUE_LENGTH = 60;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

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

  const lines = [
    `A sample of ${subjects.length} <${cls}> from the public data. It shows what the data looks like;`,
    'it is no check of a spec, and the report may run on other data.',
    'Out = the instance points to it, In = something points to the instance.',
    '→ / ← give the class of the linked node: explore it to follow the path.',
    'A predicate "not in the profile" cannot be used in a spec.',
    '',
  ];

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

  return [
    `A sample from the public data: rows for up to ${SAMPLE_SIZE} subjects the spec finds there.`,
    'The report runs as the user and may find other rows. Use it to see whether paths and filters',
    'land where you expect, not to tell the user what the report will hold.',
    '',
    header.join(' | '),
    ...rows.slice(0, MAX_ROWS).map(row => row.map(showCell).join(' | ')),
  ].join('\n');
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
