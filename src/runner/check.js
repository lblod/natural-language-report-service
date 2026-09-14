import { entityForClass, fieldsOf } from './profile.js';
import { NUMERIC_DATATYPES } from './assemble.js';

const SH = 'http://www.w3.org/ns/shacl#';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_DATE = XSD + 'date';
const XSD_DATETIME = XSD + 'dateTime';

// The validator. checkSpec(spec, profile, maxPathDepth) runs the named checks
// in order and returns the FIRST error as a one-element array (empty if ok).
// Every message names the thing that is wrong in the profile's own words and
// says what to write instead. No database call anywhere in this file — that is
// what lets an LLM iterate for free.

const ANYOF_MAX_TERMS = 24;
const ANYOF_MAX_TERM_LENGTH = 100;

// 1 + 2. the profile names itself and is one we have. knownProfiles is the
// Map app.js loaded at boot; omit it and the check is skipped (fixtures).
function profileNamed(spec, knownProfiles) {
  if (!spec.profileUri) {
    return `no rep:profile named. Available: ${knownProfiles ? [...knownProfiles.values()].map(p => p.title).join(', ') : '(none)'} .`;
  }
  if (knownProfiles && !knownProfiles.has(spec.profileUri)) {
    return `no profile <${spec.profileUri}>. Available: ${knownProfiles ? [...knownProfiles.values()].map(p => p.title).join(', ') : '(none)'}.`;
  }
  return null;
}

// 3 + 4. the target class is in the profile
function targetClass(spec, profile) {
  if (!spec.targetClass) {
    return `no sh:targetClass. In "${profile.title}" you can list: ${shapeList(profile)}.`;
  }
  if (!entityForClass(profile, spec.targetClass)) {
    return `"${profile.title}" cannot list <${spec.targetClass}>. It has: ${shapeList(profile)}.`;
  }
  return null;
}

function shapeList(profile) {
  return profile.shapes.map(s => s.label || s.targetClass).join(', ');
}

// 5. columns exist
function columnsPresent(spec) {
  if (!spec.columns.length) return 'no columns. Add at least one rep:columns entry.';
  return null;
}

// 6. every column has a label
function columnLabel(spec) {
  for (const col of spec.columns) {
    if (!col.label) return 'a column has no rdfs:label.';
  }
  return null;
}

// 7. labels unique
function columnLabelsUnique(spec) {
  const seen = new Map();
  for (const col of spec.columns) {
    if (seen.has(col.label)) {
      return `two columns are called "${col.label}". Labels must differ.`;
    }
    seen.set(col.label, true);
  }
  return null;
}

// 8 + 9 + 10. every path resolves, columns end on a value, depth capped
function pathsResolve(spec, profile, maxPathDepth) {
  const startShapeUri = entityForClass(profile, spec.targetClass);
  for (const col of spec.columns) {
    const err = walk(profile, startShapeUri, col.path, maxPathDepth,
      `column "${col.label}"`, true);
    if (err) return err;
  }
  for (const [i, filter] of spec.filters.entries()) {
    const err = walk(profile, startShapeUri, filter.path, maxPathDepth,
      `filter ${i + 1}`, false);
    if (err) return err;
  }
  return null;
}

// 11. sh:min/sh:max only on numbers and dates
function collectMinMaxTyped(spec, profile) {
  const startShapeUri = entityForClass(profile, spec.targetClass);
  for (const col of spec.columns) {
    if (col.collect !== SH + 'min' && col.collect !== SH + 'max') continue;
    const name = col.collect === SH + 'min' ? 'sh:min' : 'sh:max';
    if (!col.path.length) return `${name} on a rep:self column does not apply. A subject URI is not a number or date.`;
    const last = col.path[col.path.length - 1];
    const shapeUri = shapeAfter(profile, startShapeUri, col.path);
    if (!shapeUri) continue;   // pathsResolve already reported the real error
    const f = fieldsOf(profile, shapeUri)
      .find(x => x.path === last.predicate && !!x.inverse === !!last.inverse);
    if (!f) continue;
    const kind = f.datatype === XSD_DATETIME || f.datatype === XSD_DATE ? 'date'
      : NUMERIC_DATATYPES.has(f.datatype) ? 'number'
      : null;
    if (!kind) {
      return `"${f.name || last.predicate}" is text, so ${name} does not apply. Use rep:row, or leave it out to join the values.`;
    }
  }
  return null;
}

// 13. at most one rep:row column
function oneRowColumn(spec) {
  const rowCols = spec.columns.filter(c => c.collect === REP + 'row');
  if (rowCols.length > 1) {
    const names = rowCols.map(c => `"${c.label}"`).join(' and ');
    return `only one column may use rep:row. ${names} both do.`;
  }
  return null;
}

// 12 + 14. columns carry no constraints; known collect mode
function columnPure(spec) {
  for (const col of spec.columns) {
    if (Object.keys(col.constraints || {}).length) {
      const which = Object.keys(col.constraints)[0];
      return `a column carries ${which}. Constraints belong in sh:property.`;
    }
    if (col.collect && ![SH + 'groupConcat', SH + 'min', SH + 'max', REP + 'row'].includes(col.collect)) {
      return `column "${col.label}" has an unknown rep:collect <${col.collect}>. Use sh:groupConcat (default), rep:row, sh:min or sh:max.`;
    }
  }
  return null;
}

// 15. no label inside a filter
function filterLabel(spec) {
  for (const filter of spec.filters) {
    if ((filter.constraints || {}).label) {
      return 'a filter carries rdfs:label. Move it to rep:columns to show it.';
    }
  }
  return null;
}

// 15b. a filter with a path but no constraint selects everything; the model
// almost certainly meant to filter. Refuse and say what to add.
function filterConstraint(spec) {
  const MEANINGFUL = ['minCount', 'maxCount', 'hasValue', 'in', 'minInclusive',
    'maxInclusive', 'minExclusive', 'maxExclusive', 'pattern', 'flags', 'anyOf'];
  for (const [i, filter] of spec.filters.entries()) {
    const c = filter.constraints || {};
    if (!MEANINGFUL.some(k => c[k] !== undefined && c[k] !== null)) {
      const p = filter.path.map(h => h.predicate).join(' → ');
      return `filter ${i + 1} (path ${p}) has no condition. Add one: sh:hasValue for an exact value, sh:in for a list, rep:anyOf for words, or remove the filter.`;
    }
  }
  return null;
}

// 16. sh:maxCount above 0 needs counting
function maxCountZero(spec) {
  for (const [i, filter] of spec.filters.entries()) {
    const c = filter.constraints;
    if (c.maxCount !== null && c.maxCount !== undefined && c.maxCount > 0) {
      return `sh:maxCount ${c.maxCount} needs counting, which this service cannot do. Use sh:maxCount 0 for "has none", or drop it.`;
    }
    if (c.minCount !== null && c.minCount !== undefined && c.minCount > 2) {
      return `sh:minCount ${c.minCount} needs counting. Use sh:minCount 1 (at least one) or sh:minCount 2 (two distinct values); anything higher is beyond this service.`;
    }
  }
  return null;
}

// 17 + 18. rep:anyOf size limits
function anyOfLimits(spec) {
  for (const [i, filter] of spec.filters.entries()) {
    const c = filter.constraints;
    if (!c.anyOf) continue;
    if (c.anyOf.length > ANYOF_MAX_TERMS) {
      return `rep:anyOf has ${c.anyOf.length} terms. The limit is ${ANYOF_MAX_TERMS}. Use sh:in with exact URIs instead (find them with lookup_values).`;
    }
    for (const term of c.anyOf) {
      if (term.type === 'uri') {
        return 'a rep:anyOf term is a URI. rep:anyOf takes Dutch words, not URIs. Use sh:in with the exact URI instead.';
      }
      if (term.value && term.value.length > ANYOF_MAX_TERM_LENGTH) {
        return `a rep:anyOf term is ${term.value.length} characters. The limit is ${ANYOF_MAX_TERM_LENGTH}.`;
      }
    }
  }
  return null;
}

// 19. sh:in mixes URIs and literals
function inHomogeneous(spec) {
  for (const filter of spec.filters) {
    const c = filter.constraints;
    if (!c.in) continue;
    const uris = c.in.filter(t => t.type === 'uri').length;
    if (uris > 0 && uris < c.in.length) {
      return 'sh:in mixes URIs and text. Pick one.';
    }
  }
  return null;
}

// 20. typed literals that will not parse
function literalsParse(spec) {
  const constraintTerms = [];
  for (const filter of spec.filters) {
    const c = filter.constraints;
    for (const key of ['hasValue', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive']) {
      if (c[key]) constraintTerms.push(c[key]);
    }
    if (c.in) constraintTerms.push(...c.in);
  }
  for (const t of constraintTerms) {
    if (t.type !== 'literal' || !t.datatype) continue;
    if (t.datatype === XSD_DATETIME && !parsesAsDate(t.value, true)) {
      return `"${t.value}" is not a valid xsd:dateTime.`;
    }
    if (t.datatype === XSD_DATE && !parsesAsDate(t.value, false)) {
      return `"${t.value}" is not a valid xsd:date.`;
    }
  }
  return null;
}

function parsesAsDate(value, withTime) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return withTime ? value.includes('T') : /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const CHECKS = [
  ['no sh:targetClass or unknown', targetClass],
  ['no columns', columnsPresent],
  ['column without rdfs:label', columnLabel],
  ['two columns with one label', columnLabelsUnique],
  ['column carries constraints', columnPure],
  ['filter carries rdfs:label', filterLabel],
  ['filter without a condition', filterConstraint],
  ['sh:maxCount above 0', maxCountZero],
  ['rep:anyOf too big', anyOfLimits],
  ['sh:in mixes URIs and literals', inHomogeneous],
  ['typed literal does not parse', literalsParse],
  ['two rep:row columns', oneRowColumn],
  ['path does not resolve', pathsResolve],
  ['sh:min/sh:max on a non-number', collectMinMaxTyped],
];

export function checkSpec(spec, profile, maxPathDepth, knownProfiles = null) {
  const profileErr = profileNamed(spec, knownProfiles);
  if (profileErr) return [profileErr];
  for (const [name, check] of CHECKS) {
    const err = check(spec, profile, maxPathDepth);
    if (err) return [err];
  }
  return [];
}

// The shape a column's path lands in: follow sh:node through every hop but
// the last. walk() has already validated the path, so any gap means the walk
// reported the real error and this can bail.
function shapeAfter(profile, startShapeUri, hops) {
  let shapeUri = startShapeUri;
  for (let i = 0; i < hops.length - 1; i++) {
    const fields = fieldsOf(profile, shapeUri);
    const f = fields.find(x => x.path === hops[i].predicate && !!x.inverse === !!hops[i].inverse);
    if (!f || !f.node) return null;
    shapeUri = f.node;
  }
  return shapeUri;
}

function walk(profile, startShapeUri, hops, maxPathDepth, what, isColumn) {
  if (hops.length > maxPathDepth) {
    return `${what} walks ${hops.length} hops. The limit is ${maxPathDepth}.`;
  }
  if (!hops.length) return null;
  let shapeUri = startShapeUri;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const fields = fieldsOf(profile, shapeUri);
    const f = fields.find(x => x.path === hop.predicate && !!x.inverse === !!hop.inverse);
    if (!f) {
      const have = fields.map(x => (x.inverse ? `geen ${x.name} (${x.path}, omgekeerd)` : `${x.name} (${x.path})`)).join(', ');
      const shapeLabel = profile.shapes.find(s => s.uri === shapeUri)?.label || shapeUri;
      return `at "${shapeLabel}" there is no "${hop.predicate}". It has: ${have || '(nothing)'}.`;
    }
    if (i < hops.length - 1) {
      if (!f.node) {
        return `${what} hop ${i + 1} <${hop.predicate}> holds a value, not a link. You cannot walk past it.`;
      }
      shapeUri = f.node;
    } else if (isColumn) {
      if (!f.datatype && !f.class) {
        const valueFields = fieldsOf(profile, f.node)
          .filter(x => x.datatype || x.class)
          .map(x => `${x.name} (${x.path})`);
        return `column "${colLabel(what)}" ends on a link. Add a hop: ${valueFields.join(' or ')}.`;
      }
    }
  }
  return null;
}

function colLabel(what) {
  const m = what.match(/"([^"]+)"/);
  return m ? m[1] : what;
}