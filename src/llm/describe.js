// A profile as a plain text menu: entities, fields, code lists. Code lists up
// to INLINE_VALUES_MAX are inlined and cached for VALUES_TTL, so the LLM
// never has to search the short ones.

import { fieldsOf, entityForClass } from '../runner/profile.js';
import { sessionQuery } from '../db.js';

const INLINE_VALUES_MAX = Number(process.env.INLINE_VALUES_MAX || 50);
const VALUES_TTL = Number(process.env.VALUES_TTL || 3600) * 1000;

// In-memory cache: profile+field → { values, at }. Refreshed lazily when stale.
const cache = new Map();

export async function codeListValues(profile) {
  // Returns a map: "shapeUri|predicate|inverse" → [{ uri, label }]
  const out = {};
  for (const shape of profile.shapes) {
    for (const f of shape.fields) {
      if (!f.class) continue;
      const key = `${shape.uri}|${f.path}|${f.inverse ? 1 : 0}`;
      out[key] = await loadCodeList(profile, f, key);
    }
  }
  return out;
}

async function loadCodeList(profile, f, key) {
  if (!f.class) return [];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < VALUES_TTL) return hit.values;
  let values = [];
  try {
    values = await queryCodeList(f.class);
  } catch (e) {
    // the read failed; report nothing, the LLM will use lookup_values
    values = [];
  }
  cache.set(key, { values, at: Date.now() });
  return values;
}

async function queryCodeList(type) {
  const q = `SELECT ?uri ?label WHERE {
    ?uri a <${type}> .
    OPTIONAL { ?uri <http://www.w3.org/2004/02/skos/core#prefLabel> ?label . }
  } ORDER BY ?label LIMIT ${INLINE_VALUES_MAX + 1}`;
  const r = await sessionQuery(q);
  const bindings = r.results.bindings;
  return bindings.slice(0, INLINE_VALUES_MAX).map(b => ({
    uri: b.uri.value,
    label: b.label?.value || b.uri.value,
  }));
}

export function describeProfile(profile, codeLists = {}) {
  const lines = [];
  lines.push('Een spec is Turtle, precies in deze vorm (kopieer deze prefixes):');
  lines.push('@prefix rep:  <http://mu.semte.ch/vocabularies/reporting/> .');
  lines.push('@prefix sh:   <http://www.w3.org/ns/shacl#> .');
  lines.push('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');
  lines.push('@prefix dct:  <http://purl.org/dc/terms/> .');
  lines.push('');
  lines.push('<http://data.lblod.info/id/report-specs/<uw-id>> a rep:ReportSpec , sh:NodeShape ;');
  lines.push('  dct:title "..." ;');
  lines.push(`  rep:profile <${profile.uri}> ;`);
  lines.push('  sh:targetClass <de rdf:type uit de lijst hieronder> ;');
  lines.push('  sh:property [ ... ] ;   # filters, optioneel');
  lines.push('  rep:columns ( [ sh:path ( ... ) ; rdfs:label "..." ] ... ) .');
  lines.push('Elke kolom eindigt op een waardeveld. rep:self als sh:path geeft de eigen URI.');
  lines.push('');
  lines.push('sh:targetClass is de volledige URI tussen haakjes achter de entiteit hieronder.');
  lines.push('Gebruik in sh:path de predicate-URI die achter elke veldnaam staat, niet de veldnaam zelf.');
  lines.push('Een datumfilter is sh:minInclusive of sh:maxInclusive met "jjjj-mm-dd"^^xsd:dateTime');
  lines.push('(kopieer ook het xsd-prefix hierboven niet: voeg @prefix xsd: <http://www.w3.org/2001/XMLSchema#> toe).');
  lines.push('');
  for (const shape of profile.shapes) {
    lines.push(`${shape.label || shape.targetClass} — sh:targetClass <${shape.targetClass}>`);
    for (const f of shape.fields) {
      const key = `${shape.uri}|${f.path}|${f.inverse ? 1 : 0}`;
      const kind = f.datatype ? datatypeName(f.datatype)
        : f.class ? `→ ${conceptLabel(f.class, codeLists[key])}`
        : f.node ? `→ ${linkedLabel(profile, f.node)}`
        : '?';
      const dir = f.inverse ? ' (omgekeerd)' : '';
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