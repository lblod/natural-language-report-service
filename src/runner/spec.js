import N3 from 'n3';

// Parse a spec (rep:ReportSpec + sh:NodeShape) into a plain object.
// No validation here; that is check.js.

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export function parseSpec(turtle) {
  const parser = new N3.Parser();
  const quads = parser.parse(turtle);
  const store = new N3.Store(quads);

  const specNode = store.getQuads(null, RDF + 'type', REP + 'ReportSpec')[0]?.subject;
  if (!specNode) throw new Error('spec has no rep:ReportSpec');

  const one = (s, pred) => store.getQuads(s, pred, null)[0]?.object || null;

  const targetClass = one(specNode, SH + 'targetClass')?.value || null;
  const entity = one(specNode, REP + 'entity')?.value || null;
  const profileUri = one(specNode, REP + 'profile')?.value || null;
  const title = one(specNode, 'http://purl.org/dc/terms/title')?.value || null;

  const filters = store.getQuads(specNode, SH + 'property', null).map(q =>
    parseFilter(store, q.object, { withLabel: true }));

  const columnsQuad = one(specNode, REP + 'columns');
  const columns = columnsQuad ? parseColumnList(store, columnsQuad) : [];

  return { uri: specNode.value, title, profileUri, targetClass, entity, filters, columns };
}

function parseFilter(store, p, { withLabel = false } = {}) {
  let path = [];
  const pathQuad = store.getQuads(p, SH + 'path', null)[0]?.object;
  if (pathQuad) path = parsePath(store, pathQuad);
  return {
    path,
    constraints: readConstraints(store, p, { withLabel }),
  };
}

function parseColumnList(store, listNode) {
  const columns = [];
  let cur = listNode;
  while (cur && cur.value !== RDF + 'nil') {
    const item = store.getQuads(cur, RDF + 'first', null)[0]?.object;
    if (item) columns.push(parseColumn(store, item));
    cur = store.getQuads(cur, RDF + 'rest', null)[0]?.object;
    if (!cur) throw new Error('rep:columns list is broken (no rdf:rest terminator)');
  }
  return columns;
}

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
    constraints: readConstraints(store, col),   // kept so check.js can refuse it
  };
}

// A path is a single node (predicate, or a blank with sh:inversePath)
// or an RDF list of predicates. Returns Hop[] = { predicate, inverse }.
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
  const hops = [];
  let cur = pathQuad;
  while (cur && cur.value !== RDF + 'nil') {
    const item = store.getQuads(cur, RDF + 'first', null)[0]?.object;
    if (!item) throw new Error('sh:path list is broken');
    if (item.termType === 'BlankNode') {
      const inv = store.getQuads(item, SH + 'inversePath', null)[0]?.object;
      if (!inv) throw new Error('sh:path list items must be URIs or [ sh:inversePath <predicate> ]');
      hops.push({ predicate: inv.value, inverse: true });
    } else {
      hops.push({ predicate: item.value, inverse: false });
    }
    cur = store.getQuads(cur, RDF + 'rest', null)[0]?.object;
  }
  return hops;
}

function readConstraints(store, p, { withLabel = false } = {}) {
  const one = (pred) => store.getQuads(p, pred, null)[0]?.object || null;
  const constraints = {};
  const minCount = one(SH + 'minCount');
  if (minCount) constraints.minCount = Number(minCount.value);
  const maxCount = one(SH + 'maxCount');
  if (maxCount) constraints.maxCount = Number(maxCount.value);
  const hasValue = one(SH + 'hasValue');
  if (hasValue) constraints.hasValue = term(hasValue);
  const inList = one(SH + 'in');
  if (inList) constraints.in = readRdfList(store, inList).map(term);
  for (const [key, pred] of [
    ['minInclusive', SH + 'minInclusive'], ['maxInclusive', SH + 'maxInclusive'],
    ['minExclusive', SH + 'minExclusive'], ['maxExclusive', SH + 'maxExclusive'],
  ]) {
    const q = one(pred);
    if (q) constraints[key] = term(q);
  }
  const pattern = one(SH + 'pattern');
  if (pattern) constraints.pattern = pattern.value;
  const flags = one(SH + 'flags');
  if (flags) constraints.flags = flags.value;
  const anyOf = one(REP + 'anyOf');
  if (anyOf) constraints.anyOf = readRdfList(store, anyOf).map(term)
    .map(t => ({ type: t.type, value: t.value }));
  // read but never used by the runner; check.js refuses it (a filter has no label)
  if (withLabel) {
    const label = one(RDFS_LABEL);
    if (label) constraints.label = label.value;
  }
  return constraints;
}

function readRdfList(store, node) {
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

function term(object) {
  if (object.termType === 'NamedNode') return { type: 'uri', value: object.value };
  return {
    type: 'literal',
    value: object.value,
    datatype: object.datatype ? object.datatype.value : null,
    language: object.language || null,
  };
}