import N3 from 'n3';
import { readFileSync } from 'fs';

// Parse a profile (a SHACL shapes graph) and answer questions about it.

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';

export async function loadProfiles(dir) {
  // eslint-disable-next-line no-undef
  const fs = await import('fs');
  // eslint-disable-next-line no-undef
  const path = await import('path');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ttl')).sort();
  const profiles = new Map();
  for (const file of files) {
    const profile = await loadProfile(path.join(dir, file));
    profiles.set(profile.uri, profile);
    console.log(`[profile] "${profile.title}" (${file}): ${profile.shapes.length} entities, ` +
      `${profile.shapes.reduce((n, s) => n + s.fields.length, 0)} fields`);
  }
  if (!profiles.size) throw new Error(`no profiles found in ${dir}`);
  return profiles;
}

export async function loadProfile(file) {
  const parser = new N3.Parser();
  const store = new N3.Store();
  await new Promise((resolve, reject) => {
    parser.parse(readFileSync(file, 'utf8'), (err, quad) => {
      if (err) return reject(new Error(`${file}: ${err.message}`));
      if (quad) store.addQuad(quad); else resolve();
    });
  });

  const ontology = store.getQuads(null, RDF + 'type', OWL_ONTOLOGY)[0];
  if (!ontology) throw new Error(`${file}: no owl:Ontology. A profile file must name itself.`);
  const uri = ontology.subject.value;
  const title = store.getQuads(ontology.subject, 'http://purl.org/dc/terms/title', null)[0]?.object.value || uri;

  const prefixQuads = store.getQuads(null, SH + 'declare', null);
  const prefixes = {};
  for (const q of prefixQuads) {
    const p = store.getQuads(q.object, SH + 'prefix', null)[0]?.object.value;
    const ns = store.getQuads(q.object, SH + 'namespace', null)[0]?.object.value;
    if (p && ns) prefixes[p] = ns;
  }

  const shapes = store.getQuads(null, RDF + 'type', SH + 'NodeShape').map(q => q.subject);
  if (!shapes.length) throw new Error(`${file}: no sh:NodeShape. A profile without entities is useless.`);

  const shapeList = shapes.map(shape => {
    const targetClass = store.getQuads(shape, SH + 'targetClass', null)[0]?.object.value || null;
    const label = store.getQuads(shape, 'http://www.w3.org/2000/01/rdf-schema#label', null)[0]?.object.value || null;
    const fields = store.getQuads(shape, SH + 'property', null).map(q => parseField(store, q.object));
    return { uri: shape.value, targetClass, label, fields };
  });

  return { uri, title, prefixes, shapes: shapeList, store };
}

function parseField(store, p) {
  let path = null, inverse = false;
  const pathQuad = store.getQuads(p, SH + 'path', null)[0]?.object;
  if (pathQuad) {
    if (pathQuad.termType === 'BlankNode') {
      const inv = store.getQuads(pathQuad, SH + 'inversePath', null)[0]?.object;
      if (inv) { path = inv.value; inverse = true; }
    } else {
      path = pathQuad.value;
    }
  }
  const one = (pred) => store.getQuads(p, pred, null)[0]?.object || null;
  return {
    path, inverse,
    name: one(SH + 'name')?.value || null,
    description: one(SH + 'description')?.value || null,
    datatype: one(SH + 'datatype')?.value || null,
    class: one(SH + 'class')?.value || null,
    node: one(SH + 'node')?.value || null,
    nodeKind: one(SH + 'nodeKind')?.value || null,
    maxCount: one(SH + 'maxCount')?.value || null,
  };
}

export function entityForClass(profile, cls) {
  const shape = profile.shapes.find(s => s.targetClass === cls);
  return shape ? shape.uri : null;
}

export function shape(profile, shapeUri) {
  return profile.shapes.find(s => s.uri === shapeUri) || null;
}

export function fieldsOf(profile, shapeUri) {
  return shape(profile, shapeUri)?.fields || [];
}

export function field(profile, shapeUri, predicate, inverse) {
  return fieldsOf(profile, shapeUri).find(f => f.path === predicate && !!f.inverse === !!inverse) || null;
}

export function prefixes(profile) {
  return profile.prefixes;
}