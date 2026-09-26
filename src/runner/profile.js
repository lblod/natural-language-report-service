import N3 from 'n3';
import { readFileSync, readdirSync } from 'fs';

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
    const discriminator = parseDiscriminator(store, shape);
    return { uri: shape.value, targetClass, label, fields, discriminator };
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
    node: one(SH + 'node'),
  };
}

// rep:discriminator tells shapes that share a targetClass apart. sh:minCount 1
// becomes a plain triple in the seed, sh:maxCount 0 a FILTER NOT EXISTS.
function parseDiscriminator(store, shape) {
  const node = store.getQuads(shape, REP + 'discriminator', null)[0]?.object;
  if (!node) return null;
  const { path, inverse } = readPath(store, node);
  const one = (pred) => store.getQuads(node, pred, null)[0]?.object?.value || null;
  const minCount = one(SH + 'minCount');
  const maxCount = one(SH + 'maxCount');
  if (!path || (minCount === null && maxCount === null)) return null;
  return {
    path, inverse,
    minCount: minCount !== null ? Number(minCount) : null,
    maxCount: maxCount !== null ? Number(maxCount) : null,
  };
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

// The field a hop takes from a shape, or null.
export function field(profile, shapeUri, hop) {
  return fieldsOf(profile, shapeUri).find(f => f.path === hop.predicate && !!f.inverse === !!hop.inverse) || null;
}
