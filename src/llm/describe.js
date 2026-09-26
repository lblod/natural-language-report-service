// A profile as a plain text menu: entities, fields, code lists. Code lists up
// to INLINE_VALUES_MAX are inlined (and cached), so the LLM never has to
// search the short ones.
import { codeList, INLINE_VALUES_MAX } from './lookup.js';

export async function describeProfile(profile) {
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
  lines.push('For the URI of a linked node, end the column on that link and add sh:nodeKind sh:IRI to the column.');
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
      const kind = f.datatype ? datatypeName(f.datatype)
        : f.class ? `→ ${conceptLabel(f.class, await codeList(f.class))}`
        : f.node ? `→ ${linkedLabel(profile, f.node)}`
        : '?';
      const dir = f.inverse ? ' (inverse)' : '';
      const pathShown = f.path || '?';
      lines.push(`  ${f.name || pathShown}  sh:path <${pathShown}>${dir}  ${kind}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function conceptLabel(type, values) {
  if (!values.length) return short(type);
  const names = values.map(v => v.label).join(', ');
  const more = values.length >= INLINE_VALUES_MAX ? ', …' : '';
  return `${short(type)} — ${values.length} waarden: ${names}${more}`;
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