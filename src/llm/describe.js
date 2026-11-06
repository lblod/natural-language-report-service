// A profile as a plain text menu: entities, fields, code lists. A code list
// or a linked entity with up to INLINE_VALUES_MAX instances is inlined with
// its URIs, so the LLM can filter on the link without a lookup.
import { fetchCodeList } from './explore.js';

// The menu: how a spec looks, then per entity each field and its type: a
// datatype, a code list (with its values when short) or a link to another
// entity. The model can only write paths that exist; this is its map.
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
To filter on what a link reaches (a code, a bestuurseenheid, anything with a name), end the filter path on the link and give the URI: sh:property [ sh:path ( <link> ) ; sh:hasValue <uri> ], or sh:in ( <uri> <uri> ) for several. The URI is in the values listed after the field; "(many)" means more values than listed, lookup_values finds the URI. "(not readable)" means nothing of it is in the part of the database you read: lookup_values finds nothing there. Even of a readable entity you may see only some instances. When no URI can be found, that is normal: match the name text instead, sh:property [ sh:path ( <link> <name field> ) ; sh:pattern "the name" ; sh:flags "i" ], and say why.
A date filter is sh:minInclusive or sh:maxInclusive with "yyyy-mm-ddThh:mm:ss"^^xsd:dateTime.
The time is required: T00:00:00 starts a day, T23:59:59 ends it.
(the xsd prefix above is not copied: add @prefix xsd: <http://www.w3.org/2001/XMLSchema#>).
`];
  for (const shape of profile.shapes) {
    lines.push(`${shape.label || shape.targetClass} — sh:targetClass <${shape.targetClass}> ; rep:entity <${shape.uri}>`);
    for (const f of shape.fields) {
      let kind = '?';
      if (f.datatype) kind = formatDatatype(f.datatype);
      else if (f.class) kind = `→ ${formatConceptLabel(f.class, await fetchCodeList(f.class))}`;
      else if (f.nodes.length) {
        const links = [];
        for (const n of f.nodes) links.push(await formatLinkedLabel(profile, n));
        kind = `→ ${links.join(' or ')}`;
      }
      const dir = f.inverse ? ' (inverse)' : '';
      const pathShown = f.path || '?';
      lines.push(`  ${f.name || pathShown}  sh:path <${pathShown}>${dir}  ${kind}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// A code-list field: the list's name and, when the list is short, its
// values with their URIs, so the model needs no lookup. "…" only when the
// list holds more than it shows; "(not readable)" when the service reads
// nothing of it, so the model does not look it up.
function formatConceptLabel(type, { values, more }) {
  if (!values.length) return `${shortenUri(type)} (not readable)`;
  return `${shortenUri(type)} — ${values.length} values: ${formatValues(values)}${more ? ', …' : ''}`;
}

// A link to another entity: its name and, when that entity has few
// instances (a code), its values with their URIs, so the model can filter
// on the link without a lookup. "(many)" when there are more: then
// lookup_values finds the URI. "(not readable)" when the service reads
// nothing of it: then the model matches the name text.
async function formatLinkedLabel(profile, nodeUri) {
  const s = profile.shapes.find(x => x.uri === nodeUri);
  if (!s) return shortenUri(nodeUri);
  const name = s.label || s.targetClass;
  const { values, more } = await fetchCodeList(s.targetClass);
  if (!values.length) return `${name} (not readable)`;
  if (more) return `${name} (many)`;
  return `${name} — ${values.length} values: ${formatValues(values)}`;
}

// "label <uri>" per value, comma separated.
function formatValues(values) {
  return values.map(v => `${v.label} <${v.uri}>`).join(', ');
}

// The local name of a datatype, "...#dateTime" becomes "dateTime", to keep
// the menu short.
function formatDatatype(dt) {
  return dt.split('#').pop();
}

// A URI without its host, at most 60 characters, to keep the menu short.
function shortenUri(uri) {
  return uri.replace(/^https?:\/\/[^/]+\//, '…/').slice(-60);
}