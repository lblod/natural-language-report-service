// A profile as a plain text menu: entities, fields, code lists. Code lists up
// to INLINE_VALUES_MAX are inlined and cached for VALUES_TTL, so the LLM
// never has to search the short ones.

import { fieldsOf, entityForClass } from '../runner/profile.js';

const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const VALUES_TTL = Number(process.env.VALUES_TTL || 3600) * 1000;

// In-memory cache: profile+field → { values, at }. Refreshed lazily when stale.
const cache = new Map();

// codeListValues(profile, queryFn) → map "shapeUri|predicate|inverse"
// → [{ uri, label }]. queryFn runs under the service scope (public graph), so
// code lists read the same regardless of the caller's rights.
export async function codeListValues(profile, queryFn) {
  const out = {};
  for (const shape of profile.shapes) {
    for (const f of shape.fields) {
      if (!f.class) continue;
      const key = `${shape.uri}|${f.path}|${f.inverse ? 1 : 0}`;
      out[key] = await loadCodeList(f, key, queryFn);
    }
  }
  return out;
}

async function loadCodeList(f, key, queryFn) {
  if (!f.class) return [];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < VALUES_TTL) return hit.values;
  let values = [];
  try {
    values = await queryCodeList(f.class, queryFn);
  } catch (e) {
    // the read failed; report nothing, the LLM will use rep:anyOf with words
    values = [];
  }
  cache.set(key, { values, at: Date.now() });
  return values;
}

async function queryCodeList(type, queryFn) {
  const q = `SELECT ?uri ?label WHERE {
    ?uri a <${type}> .
    OPTIONAL { ?uri <http://www.w3.org/2004/02/skos/core#prefLabel> ?label . }
  } ORDER BY ?label LIMIT ${INLINE_VALUES_MAX + 1}`;
  const r = await queryFn(q);
  const bindings = r.results.bindings;
  return bindings.slice(0, INLINE_VALUES_MAX).map(b => ({
    uri: b.uri.value,
    label: b.label?.value || b.uri.value,
  }));
}

export function describeProfile(profile, codeLists = {}) {
  const lines = [];
  lines.push('A spec is Turtle, in exactly this shape (copy these prefixes):');
  lines.push('@prefix rep:  <http://mu.semte.ch/vocabularies/reporting/> .');
  lines.push('@prefix sh:   <http://www.w3.org/ns/shacl#> .');
  lines.push('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');
  lines.push('@prefix dct:  <http://purl.org/dc/terms/> .');
  lines.push('');
  lines.push('<http://data.lblod.info/id/report-specs/<your-id>> a rep:ReportSpec , sh:NodeShape ;');
  lines.push('  dct:title "..." ;');
  lines.push(`  rep:profile <${profile.uri}> ;`);
  lines.push('  sh:targetClass <the rdf:type from the list below> ;');
  lines.push('  sh:property [ ... ] ;   # filters, optional');
  lines.push('  rep:columns ( [ sh:path ( ... ) ; rdfs:label "..." ] ... ) .');
  lines.push('Every column ends on a value field. Use rep:self as sh:path for the subject URI.');
  lines.push('');
  lines.push('sh:targetClass is the full URI in brackets after the entity below.');
  lines.push('In sh:path, use the predicate URI shown after each field name, not the field name itself.');
  lines.push('An inverse hop (the field shows "(inverse)") goes in the list as [ sh:inversePath <predicate> ] .');
  lines.push('When two entities share one sh:targetClass, pick one with rep:entity <the URI after the entity>.');
  lines.push('A date filter is sh:minInclusive or sh:maxInclusive with "yyyy-mm-dd"^^xsd:dateTime');
  lines.push('(the xsd prefix above is not copied: add @prefix xsd: <http://www.w3.org/2001/XMLSchema#>).');
  lines.push('');
  for (const shape of profile.shapes) {
    lines.push(`${shape.label || shape.targetClass} — sh:targetClass <${shape.targetClass}> ; rep:entity <${shape.uri}>`);
    for (const f of shape.fields) {
      const key = `${shape.uri}|${f.path}|${f.inverse ? 1 : 0}`;
      const kind = f.datatype ? datatypeName(f.datatype)
        : f.class ? `→ ${conceptLabel(f.class, codeLists[key])}`
        : f.node ? `→ ${linkedLabel(profile, f.node)}`
        : '?';
      const dir = f.inverse ? ' (inverse)' : '';
      const pathShown = typeof f.path === 'string' ? f.path : '?';
      lines.push(`  ${f.name || pathShown}  sh:path <${pathShown}>${dir}  ${kind}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function conceptLabel(type, values) {
  const head = values.slice(0, INLINE_VALUES_MAX);
  if (!head.length) return short(type);
  const names = head.map(v => v.label).join(', ');
  const more = values.length >= INLINE_VALUES_MAX ? ', …' : '';
  return `${short(type)} — ${head.length} waarden: ${names}${more}`;
}

function linkedLabel(profile, nodeUri) {
  const s = profile.shapes.find(x => x.uri === nodeUri);
  return s ? `${s.label || s.targetClass} (veel)` : short(nodeUri);
}

function datatypeName(dt) {
  return dt.split('#').pop();
}

function short(uri) {
  return uri.replace(/^https?:\/\/[^/]+\//, '…/').slice(-60);
}