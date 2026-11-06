import N3 from 'n3';

// Parse a spec (rep:ReportSpec + sh:NodeShape) into a plain object.
// No checks against the profile here; that is check.js. Only Turtle that
// cannot become one plain spec is refused.

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

// One spec: title, profile, start class or entity, filters and columns.
// Refuses Turtle with no rep:ReportSpec or with two: one answer is one
// report.
export function parseSpec(turtle) {
  const parser = new N3.Parser();
  const quads = parser.parse(turtle);
  const store = new N3.Store(quads);

  const specNodes = store.getQuads(null, RDF + 'type', REP + 'ReportSpec').map(q => q.subject);
  if (!specNodes.length) throw new Error('spec has no rep:ReportSpec');
  // One spec is one report. A second one would pass unchecked and never run.
  if (specNodes.length > 1) {
    throw new Error(`one spec per answer. This Turtle has ${specNodes.length} rep:ReportSpec. Keep one, and offer the other as the next report.`);
  }
  const specNode = specNodes[0];

  const one = (s, pred) => store.getQuads(s, pred, null)[0]?.object || null;

  const targetClass = one(specNode, SH + 'targetClass')?.value || null;
  const entity = one(specNode, REP + 'entity')?.value || null;
  const profileUri = one(specNode, REP + 'profile')?.value || null;
  const title = one(specNode, 'http://purl.org/dc/terms/title')?.value || null;

  const filters = store.getQuads(specNode, SH + 'property', null).map(q => parseFilter(store, q.object));

  const columnsQuad = one(specNode, REP + 'columns');
  const columns = columnsQuad ? readRdfList(store, columnsQuad).map(col => parseColumn(store, col)) : [];

  return { uri: specNode.value, title, profileUri, targetClass, entity, filters, columns };
}

// One filter: its path, its constraints and its rep:where conditions.
// Profile discriminators are written the same way, so profile.js uses this
// too.
export function parseFilter(store, p) {
  let path = [];
  const pathQuad = store.getQuads(p, SH + 'path', null)[0]?.object;
  if (pathQuad) path = parsePath(store, pathQuad);
  return {
    path,
    constraints: readConstraints(store, p),
    where: readWhere(store, p),
  };
}

// rep:where: conditions on the nodes a filter or column walks through. Each
// is written like a filter, from the row; check.js refuses one nested in
// another.
function readWhere(store, node) {
  return store.getQuads(node, REP + 'where', null).map(q => parseFilter(store, q.object));
}

// The number of steps two paths have in common from the row. A rep:where
// shares those nodes with its filter or column.
export function countSharedSteps(a, b) {
  let k = 0;
  while (k < a.length && k < b.length
    && a[k].predicate === b[k].predicate && !!a[k].inverse === !!b[k].inverse) k++;
  return k;
}

// One column: its path (rep:self is the row's own subject), header label,
// collect mode, separator and nodeKind. Constraints are read too, only so
// check.js can refuse them.
function parseColumn(store, col) {
  let path = [];
  const pathQuad = store.getQuads(col, SH + 'path', null)[0]?.object;
  if (pathQuad) {
    if (pathQuad.termType === 'NamedNode' && pathQuad.value === REP + 'self') {
      path = [];   // rep:self: the row's own subject
    } else {
      path = parsePath(store, pathQuad);
    }
  }
  return {
    path,
    label: store.getQuads(col, RDFS_LABEL, null)[0]?.object.value || null,
    collect: store.getQuads(col, REP + 'collect', null)[0]?.object.value || null,
    separator: store.getQuads(col, SH + 'separator', null)[0]?.object.value || null,
    // sh:nodeKind sh:IRI: the column shows the URI of the node it ends on
    nodeKind: store.getQuads(col, SH + 'nodeKind', null)[0]?.object.value || null,
    constraints: readConstraints(store, col),   // kept so check.js can refuse it
    where: readWhere(store, col),
  };
}

// A path is a single node (predicate, or a blank with sh:inversePath)
// or an RDF list of steps, each a predicate or [ sh:inversePath <p> ].
// Returns Hop[] = { predicate, inverse }.
function parsePath(store, pathQuad) {
  if (pathQuad.termType === 'BlankNode') {
    const inv = store.getQuads(pathQuad, SH + 'inversePath', null)[0]?.object;
    if (inv) return [{ predicate: inv.value, inverse: true }];
    const first = store.getQuads(pathQuad, RDF + 'first', null)[0]?.object;
    if (!first) throw new Error('sh:path blank node without sh:inversePath is not supported');
  }
  if (pathQuad.termType === 'NamedNode') {
    return [{ predicate: pathQuad.value, inverse: false }];
  }
  // RDF list of predicates
  return readRdfList(store, pathQuad).map(item => {
    if (item.termType !== 'BlankNode') return { predicate: item.value, inverse: false };
    const inv = store.getQuads(item, SH + 'inversePath', null)[0]?.object;
    if (!inv) throw new Error('sh:path list items must be URIs or [ sh:inversePath <predicate> ]');
    return { predicate: inv.value, inverse: true };
  });
}

// The conditions on a filter, column or rep:where as plain values: the
// counts, sh:hasValue, sh:in, the ranges, sh:pattern and rep:anyOf.
function readConstraints(store, p) {
  const one = (pred) => store.getQuads(p, pred, null)[0]?.object || null;
  const constraints = {};
  const minCount = one(SH + 'minCount');
  if (minCount) constraints.minCount = Number(minCount.value);
  const maxCount = one(SH + 'maxCount');
  if (maxCount) constraints.maxCount = Number(maxCount.value);
  const hasValue = one(SH + 'hasValue');
  if (hasValue) constraints.hasValue = toTerm(hasValue);
  const inList = one(SH + 'in');
  if (inList) constraints.in = readRdfList(store, inList).map(toTerm);
  for (const [key, pred] of [
    ['minInclusive', SH + 'minInclusive'], ['maxInclusive', SH + 'maxInclusive'],
    ['minExclusive', SH + 'minExclusive'], ['maxExclusive', SH + 'maxExclusive'],
  ]) {
    const q = one(pred);
    if (q) constraints[key] = toTerm(q);
  }
  const pattern = one(SH + 'pattern');
  if (pattern) constraints.pattern = pattern.value;
  const flags = one(SH + 'flags');
  if (flags) constraints.flags = flags.value;
  const anyOf = one(REP + 'anyOf');
  if (anyOf) constraints.anyOf = readRdfList(store, anyOf).map(toTerm)
    .map(t => ({ type: t.type, value: t.value }));
  return constraints;
}

// The items of an RDF list, in order. A list item without rdf:first is
// broken Turtle: refuse it rather than drop items.
export function readRdfList(store, node) {
  const items = [];
  let cur = node;
  while (cur && cur.value !== RDF + 'nil') {
    const item = store.getQuads(cur, RDF + 'first', null)[0]?.object;
    if (!item) throw new Error('RDF list is broken');
    items.push(item);
    cur = store.getQuads(cur, RDF + 'rest', null)[0]?.object;
  }
  return items;
}

// An N3 term as a plain { type, value, datatype, language }, the shape the
// query builders and check.js work on.
function toTerm(object) {
  if (object.termType === 'NamedNode') return { type: 'uri', value: object.value };
  return {
    type: 'literal',
    value: object.value,
    datatype: object.datatype ? object.datatype.value : null,
    language: object.language || null,
  };
}