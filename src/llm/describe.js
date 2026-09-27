// A profile as a plain text menu: entities, fields, code lists. Code lists up
// to INLINE_VALUES_MAX are inlined (and cached), so the LLM never has to
// search the short ones.
import { codeList, INLINE_VALUES_MAX } from './explore.js';

export async function describeProfile(profile) {
  const lines = [`A spec is Turtle, in exactly this shape (copy these prefixes):
@prefix rep:  <http://mu.semte.ch/vocabularies/reporting/> .
@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:  <http://purl.org/dc/terms/> .

<http://data.lblod.info/id/report-specs/<your-id>> a rep:ReportSpec , sh:NodeShape ;
  dct:title "..." ;
  rep:profile <${profile.uri}> ;
  sh:targetClass <the rdf:type from the list below> ;
  sh:property [ ... ] ;   # filters, optional
  rep:columns ( [ sh:path ( ... ) ; rdfs:label "..." ] ... ) .
Every column ends on a value field. Use rep:self as sh:path for the subject URI.
For the URI of a linked node, end the column on that link and add sh:nodeKind sh:IRI to the column.

sh:targetClass is the full URI in brackets after the entity below.
In sh:path, use the predicate URI shown after each field name, not the field name itself.
An inverse hop (the field shows "(inverse)") goes in the list as [ sh:inversePath <predicate> ] .
When two entities share one sh:targetClass, pick one with rep:entity <the URI after the entity>.
A field that links to several entities ("→ a or b") reaches all of them; the steps after it decide. To keep one kind, add a rep:where on a step only that kind has.
A date filter is sh:minInclusive or sh:maxInclusive with "yyyy-mm-dd"^^xsd:dateTime
(the xsd prefix above is not copied: add @prefix xsd: <http://www.w3.org/2001/XMLSchema#>).
`];
  for (const shape of profile.shapes) {
    lines.push(`${shape.label || shape.targetClass} — sh:targetClass <${shape.targetClass}> ; rep:entity <${shape.uri}>`);
    for (const f of shape.fields) {
      const kind = f.datatype ? datatypeName(f.datatype)
        : f.class ? `→ ${conceptLabel(f.class, await codeList(f.class))}`
        : f.nodes.length ? `→ ${f.nodes.map(n => linkedLabel(profile, n)).join(' or ')}`
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