// Search a code list too long to inline: regex on str(?label), so
// language-tagged labels match. Returns the matches, the total, and an
// `exact` flag when a label equals the term (case aside).

import { sessionQuery, sparqlEscapeString } from '../db.js';
import { fieldsOf, entityForClass } from '../runner/profile.js';

const LIMIT = 25;

// field is "shapeLabel.fieldLabel" as the LLM writes it, or a predicate URI.
// We resolve it to the field's sh:class to know what type to search.
export async function lookupValues(profile, term, fieldSpec) {
  const type = resolveClass(profile, fieldSpec);
  if (!type) return { total: 0, exact: null, matches: [], error: `field "${fieldSpec}" not found in profile "${profile.title}"` };

  const q = `SELECT ?uri ?label ?type WHERE {
    ?uri <http://www.w3.org/2004/02/skos/core#prefLabel> ?label ; a ?type .
    FILTER(REGEX(str(?label), ${sparqlEscapeString(escapeRegex(term))}, "i"))
  } ORDER BY ?label LIMIT ${LIMIT * 8}`;
  const r = await sessionQuery(q);
  const bindings = r.results.bindings;
  // The profile's sh:class is the type the data should carry, but code lists
  // sometimes type their entries differently (MAR codes are
  // ext:supervision/Nomenclature, the profile says skos:Concept). Prefer rows
  // matching the asked class, fall back to all rows. The query reads more
  // rows than LIMIT so an exact hit deeper in the alphabet still surfaces.
  const wanted = bindings.filter(b => type && b.type?.value === type);
  const rows = wanted.length ? wanted : bindings;
  // Order: an exact label (case aside) first, then the rest as the store
  // ordered them. "Gent" must surface before "AGB Erfgoed Gent".
  const lower = term.toLowerCase();
  const exactRow = rows.find(b => b.label.value.toLowerCase() === lower);
  const rest = rows.filter(b => b !== exactRow);
  const ordered = exactRow ? [exactRow, ...rest] : rest;
  let matches = ordered.slice(0, LIMIT).map(b => ({
    label: b.label.value,
    uri: b.uri.value,
  }));
  if (!matches.length) {
    const byCode = await codeQuery(profile, type, term);
    matches = byCode;
  }
  const exact = matches.find(m => m.label.toLowerCase() === term.toLowerCase());
  return {
    total: matches.length >= LIMIT ? `${LIMIT}+` : matches.length,
    exact: exact ? exact.uri : null,
    matches,
  };
}

// MAR codes: the label says "MAR7300 - …" but the searchable code sits on
// ext:supervision/nomenclatureCode. One extra query, only when the label
// search came up empty.
async function codeQuery(profile, type, term) {
  const q = `SELECT ?uri ?label WHERE {
    ?uri <http://mu.semte.ch/vocabularies/ext/supervision/nomenclatureCode> ?code ;
         <http://www.w3.org/2004/02/skos/core#prefLabel> ?label .
    FILTER(CONTAINS(LCASE(str(?code)), LCASE(${sparqlEscapeString(term)})))
  } ORDER BY ?label LIMIT ${LIMIT}`;
  try {
    const r = await sessionQuery(q);
    return r.results.bindings.map(b => ({ label: b.label.value, uri: b.uri.value }));
  } catch {
    return [];
  }
}

function resolveClass(profile, fieldSpec) {
  if (fieldSpec.includes('/')) return null;
  // "shapeLabel.fieldLabel" → find the field carrying sh:class
  const dot = fieldSpec.lastIndexOf('.');
  if (dot < 0) {
    // bare predicate URI
    for (const shape of profile.shapes) {
      for (const f of shape.fields) {
        if (f.path === fieldSpec && f.class) return f.class;
      }
    }
    return null;
  }
  const shapeLabel = fieldSpec.slice(0, dot);
  const fieldLabel = fieldSpec.slice(dot + 1);
  const shape = profile.shapes.find(s => s.label === shapeLabel);
  if (!shape) return null;
  const f = shape.fields.find(x => x.name === fieldLabel);
  // sh:node marks a link, not a code list; the searchable type is the linked
  // shape's sh:targetClass ("melding.bestuurseenheid" → besluit:Bestuurseenheid).
  if (f?.class) return f.class;
  if (f?.node) {
    const linked = profile.shapes.find(s => s.uri === f.node);
    return linked?.targetClass || null;
  }
  // The model sometimes writes shape.field on a linked shape
  // ("bestuurseenheid.naam"); resolve it to that shape's target class.
  for (const s of profile.shapes) {
    if (s.label === shapeLabel || shortType(s.targetClass) === shapeLabel) {
      return s.targetClass;
    }
  }
  return null;
}

function shortType(cls) {
  return cls.split('#').pop() || cls.split('/').pop();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}