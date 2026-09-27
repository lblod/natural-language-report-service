import N3 from 'n3';
import { readFileSync, readdirSync } from 'fs';
import { parseFilter, readRdfList } from './spec.js';

// Parse a profile (a SHACL shapes graph) and answer questions about it.

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';

export function loadProfiles(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.ttl')).sort();
  const profiles = new Map();
  for (const file of files) {
    const profile = loadProfile(`${dir}/${file}`);
    profiles.set(profile.uri, profile);
    console.log(`[profile] "${profile.title}" (${file}): ${profile.shapes.length} entities, ` +
      `${profile.shapes.reduce((n, s) => n + s.fields.length, 0)} fields`);
  }
  if (!profiles.size) throw new Error(`no profiles found in ${dir}`);
  return profiles;
}

function loadProfile(file) {
  let store;
  try {
    store = new N3.Store(new N3.Parser().parse(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }

  const ontology = store.getQuads(null, RDF + 'type', OWL_ONTOLOGY)[0];
  if (!ontology) throw new Error(`${file}: no owl:Ontology. A profile file must name itself.`);
  const uri = ontology.subject.value;
  const title = store.getQuads(ontology.subject, 'http://purl.org/dc/terms/title', null)[0]?.object.value || uri;

  const shapes = store.getQuads(null, RDF + 'type', SH + 'NodeShape').map(q => q.subject);
  if (!shapes.length) throw new Error(`${file}: no sh:NodeShape. A profile without entities is useless.`);

  const shapeList = shapes.map(shape => {
    const targetClass = store.getQuads(shape, SH + 'targetClass', null)[0]?.object.value || null;
    const label = store.getQuads(shape, 'http://www.w3.org/2000/01/rdf-schema#label', null)[0]?.object.value || null;
    const fields = store.getQuads(shape, SH + 'property', null).map(q => parseField(store, q.object));
    const discriminators = parseDiscriminators(store, shape);
    return { uri: shape.value, targetClass, label, fields, discriminators };
  });

  return { uri, title, shapes: shapeList };
}

// A field's sh:path: one predicate, or [ sh:inversePath <predicate> ].
function readPath(store, node) {
  const pathNode = store.getQuads(node, SH + 'path', null)[0]?.object;
  if (!pathNode) return { path: null, inverse: false };
  if (pathNode.termType !== 'BlankNode') return { path: pathNode.value, inverse: false };
  const inv = store.getQuads(pathNode, SH + 'inversePath', null)[0]?.object;
  return inv ? { path: inv.value, inverse: true } : { path: null, inverse: false };
}

function parseField(store, p) {
  const one = (pred) => store.getQuads(p, pred, null)[0]?.object?.value || null;
  return {
    ...readPath(store, p),
    name: one(SH + 'name'),
    datatype: one(SH + 'datatype'),
    class: one(SH + 'class'),
    nodes: linkedShapes(store, p, one(SH + 'name')),
  };
}

// The entities a field links to: its sh:node, or the sh:node of each item of
// its sh:or (SHACL for "each value is one of these").
function linkedShapes(store, p, name) {
  const node = store.getQuads(p, SH + 'node', null)[0]?.object;
  if (node) return [node.value];
  const or = store.getQuads(p, SH + 'or', null)[0]?.object;
  if (!or) return [];
  return readRdfList(store, or).map(item => {
    const n = store.getQuads(item, SH + 'node', null)[0]?.object;
    if (!n) throw new Error(`field "${name}": every sh:or item needs a sh:node.`);
    return n.value;
  });
}

// rep:discriminator tells shapes that share a targetClass apart. A shape may
// carry several; a subject meets them all.
function parseDiscriminators(store, shape) {
  return store.getQuads(shape, REP + 'discriminator', null)
    .map(q => parseDiscriminator(store, q.object, shape.value));
}

// One discriminator: a condition written like a spec filter (sh:path plus
// sh:minCount, sh:maxCount, sh:in, sh:hasValue, ...), or sh:and / sh:or (a
// list) or sh:not (one) over discriminators, as in SHACL.
function parseDiscriminator(store, node, shapeUri) {
  const one = (pred) => store.getQuads(node, SH + pred, null)[0]?.object;
  const list = (pred) => {
    const items = readRdfList(store, one(pred)).map(x => parseDiscriminator(store, x, shapeUri));
    if (!items.length) throw new Error(`rep:discriminator on <${shapeUri}> has an empty sh:${pred}.`);
    return items;
  };
  if (one('and')) return { and: list('and') };
  if (one('or')) return { or: list('or') };
  if (one('not')) return { not: parseDiscriminator(store, one('not'), shapeUri) };
  const d = parseFilter(store, node);
  if (!d.path.length || !Object.keys(d.constraints).length) {
    throw new Error(`rep:discriminator on <${shapeUri}> needs a sh:path with a condition, or sh:and, sh:or or sh:not.`);
  }
  return d;
}

// The shape a spec starts from. rep:entity wins; a targetClass only resolves
// when exactly one shape carries it, so a class two entities share is a
// validator error, not a silent first match.
export function startShape(profile, spec) {
  if (spec.entity) return shape(profile, spec.entity);
  const matches = profile.shapes.filter(s => s.targetClass === spec.targetClass);
  return matches.length === 1 ? matches[0] : null;
}

export function shape(profile, shapeUri) {
  return profile.shapes.find(s => s.uri === shapeUri) || null;
}

export function fieldsOf(profile, shapeUri) {
  return shape(profile, shapeUri)?.fields || [];
}
