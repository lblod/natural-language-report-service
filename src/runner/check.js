import { fieldsOf } from './profile.js';
import { NUMERIC_DATATYPES } from './assemble.js';
import { sharedSteps } from './spec.js';

const SH = 'http://www.w3.org/ns/shacl#';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_DATE = XSD + 'date';
const XSD_DATETIME = XSD + 'dateTime';

// The validator. checkSpec runs the checks in order and returns the first
// error as a one-element array (empty if ok). Every message names the thing
// that is wrong in the profile's own words and says what to write instead.
// No database call anywhere in this file.

const ANYOF_MAX_TERMS = 24;
const ANYOF_MAX_TERM_LENGTH = 100;

// The spec names a profile we have. knownProfiles is the profile Map loaded
// at boot; the check is skipped when it is omitted.
function profileNamed(spec, knownProfiles) {
  if (!spec.profileUri) {
    return `no rep:profile named. Available: ${knownProfiles ? [...knownProfiles.values()].map(p => p.title).join(', ') : '(none)'} .`;
  }
  if (knownProfiles && !knownProfiles.has(spec.profileUri)) {
    return `no profile <${spec.profileUri}>. Available: ${knownProfiles ? [...knownProfiles.values()].map(p => p.title).join(', ') : '(none)'}.`;
  }
  return null;
}

// The spec names an entity we have: by rep:entity, or by a targetClass only
// one entity carries. A class two entities share is refused with both names,
// so the model can add rep:entity instead of guessing.
function startEntity(spec, profile) {
  if (!spec.targetClass) {
    return `no sh:targetClass. In "${profile.title}" you can list: ${shapeList(profile)}.`;
  }
  if (spec.entity) {
    const s = profile.shapes.find(x => x.uri === spec.entity);
    if (!s) {
      return `no entity <${spec.entity}> in "${profile.title}". It has: ${shapeList(profile)}.`;
    }
    if (s.targetClass !== spec.targetClass) {
      return `rep:entity <${spec.entity}> is a <${s.targetClass}>, but sh:targetClass says <${spec.targetClass}>. Make them agree.`;
    }
    return null;
  }
  const matches = profile.shapes.filter(s => s.targetClass === spec.targetClass);
  if (matches.length === 1) return null;
  if (!matches.length) {
    return `"${profile.title}" cannot list <${spec.targetClass}>. It has: ${shapeList(profile)}.`;
  }
  const names = matches.map(m => `${m.label || m.uri} <${m.uri}>`).join(', ');
  return `<${spec.targetClass}> is the class of ${matches.length} entities: ${names}. Add rep:entity <...> to say which one.`;
}

function shapeList(profile) {
  return profile.shapes.map(s => s.label || s.targetClass).join(', ');
}

// Every condition in the spec: the filters, and the rep:where conditions on
// filters and columns, with the words that name each one in a message. A
// rep:where also carries its host, the filter or column it hangs on.
function conditions(spec) {
  const out = spec.filters.map((f, i) => ({ what: `filter ${i + 1}`, cond: f }));
  spec.filters.forEach((f, i) => f.where.forEach((w, j) => out.push({
    what: `rep:where ${j + 1} on filter ${i + 1}`, cond: w,
    host: { what: `filter ${i + 1}`, path: f.path },
  })));
  spec.columns.forEach(c => c.where.forEach((w, j) => out.push({
    what: `rep:where ${j + 1} on column "${c.label}"`, cond: w,
    host: { what: `column "${c.label}"`, path: c.path },
  })));
  return out;
}

// The shape a spec starts from, after startEntity has approved it: rep:entity
// wins, otherwise the one shape carrying the targetClass.
function startShapeOf(spec, profile) {
  if (spec.entity) {
    return profile.shapes.find(s => s.uri === spec.entity)?.uri || null;
  }
  const matches = profile.shapes.filter(s => s.targetClass === spec.targetClass);
  return matches.length === 1 ? matches[0].uri : null;
}

// Columns exist
function columnsPresent(spec) {
  if (!spec.columns.length) return 'no columns. Add at least one rep:columns entry.';
  return null;
}

// Every column has a label
function columnLabel(spec) {
  for (const col of spec.columns) {
    if (!col.label) return 'a column has no rdfs:label.';
  }
  return null;
}

// Labels are unique
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

// Every path resolves, columns end on a value, depth capped
function pathsResolve(spec, profile, maxPathDepth) {
  const startShapeUri = startShapeOf(spec, profile);
  for (const col of spec.columns) {
    const err = walk(profile, startShapeUri, col.path, maxPathDepth,
      `column "${col.label}"`, true, col.nodeKind === SH + 'IRI');
    if (err) return err;
  }
  for (const [i, filter] of spec.filters.entries()) {
    const err = walk(profile, startShapeUri, filter.path, maxPathDepth,
      `filter ${i + 1}`, false);
    if (err) return err;
  }
  return null;
}

// sh:min/sh:max only on numbers and dates
function collectMinMaxTyped(spec, profile) {
  const startShapeUri = startShapeOf(spec, profile);
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
      return `"${f.name || last.predicate}" is text, so ${name} does not apply. Use rep:row (same as leaving rep:collect out: every value gets its own row).`;
    }
  }
  return null;
}

// At most one rep:row column
function oneRowColumn(spec) {
  const rowCols = spec.columns.filter(c => c.collect === REP + 'row');
  if (rowCols.length > 1) {
    const names = rowCols.map(c => `"${c.label}"`).join(' and ');
    return `only one column may use rep:row. ${names} both do.`;
  }
  return null;
}

// Columns carry no constraints; known collect mode
function columnPure(spec) {
  for (const col of spec.columns) {
    if (Object.keys(col.constraints || {}).length) {
      const which = Object.keys(col.constraints)[0];
      return `a column carries ${which}. Constraints belong in sh:property, or in rep:where for a condition on a step of this column.`;
    }
    if (col.nodeKind && col.nodeKind !== SH + 'IRI') {
      return `column "${col.label}" has sh:nodeKind <${col.nodeKind}>. A column takes only sh:nodeKind sh:IRI, to show the URI of the node its path ends on.`;
    }
    if (col.collect && ![SH + 'groupConcat', SH + 'min', SH + 'max', REP + 'row'].includes(col.collect)) {
      return `column "${col.label}" has an unknown rep:collect <${col.collect}>. Use sh:groupConcat (joins the values), rep:row or nothing (each value gets its own row), sh:min or sh:max.`;
    }
  }
  return null;
}

// No label inside a filter or rep:where
function filterLabel(spec) {
  for (const { what, cond } of conditions(spec)) {
    if ((cond.constraints || {}).label) {
      return `${what} carries rdfs:label. Move it to rep:columns to show it.`;
    }
  }
  return null;
}

// A filter with a path but no constraint selects everything; the model
// almost certainly meant to filter. Refuse and say what to add.
function filterConstraint(spec) {
  const MEANINGFUL = ['minCount', 'maxCount', 'hasValue', 'in', 'minInclusive',
    'maxInclusive', 'minExclusive', 'maxExclusive', 'pattern', 'flags', 'anyOf'];
  for (const { what, cond } of conditions(spec)) {
    const c = cond.constraints || {};
    if (!MEANINGFUL.some(k => c[k] !== undefined && c[k] !== null)) {
      const p = cond.path.map(h => h.predicate).join(' → ');
      return `${what} (path ${p}) has no condition. Add one: sh:hasValue for an exact value, sh:in for a list, rep:anyOf for words, or remove the filter.`;
    }
  }
  return null;
}

// sh:maxCount above 0 needs counting
function maxCountZero(spec) {
  for (const { cond } of conditions(spec)) {
    const c = cond.constraints;
    if (c.maxCount !== null && c.maxCount !== undefined && c.maxCount > 0) {
      return `sh:maxCount ${c.maxCount} needs counting, which this service cannot do. Use sh:maxCount 0 for "has none", or drop it.`;
    }
    if (c.minCount !== null && c.minCount !== undefined && c.minCount > 2) {
      return `sh:minCount ${c.minCount} needs counting. Use sh:minCount 1 (at least one) or sh:minCount 2 (two distinct values); anything higher is beyond this service.`;
    }
  }
  return null;
}

// rep:anyOf size limits
function anyOfLimits(spec) {
  for (const { cond } of conditions(spec)) {
    const c = cond.constraints;
    if (!c.anyOf) continue;
    if (c.anyOf.length > ANYOF_MAX_TERMS) {
      return `rep:anyOf has ${c.anyOf.length} terms. The limit is ${ANYOF_MAX_TERMS}. Narrow the words, or split the filter into two sh:property blocks.`;
    }
    for (const term of c.anyOf) {
      if (term.type === 'uri') {
        return 'a rep:anyOf term is a URI. rep:anyOf takes Dutch words, not URIs.';
      }
      if (term.value && term.value.length > ANYOF_MAX_TERM_LENGTH) {
        return `a rep:anyOf term is ${term.value.length} characters. The limit is ${ANYOF_MAX_TERM_LENGTH}.`;
      }
    }
  }
  return null;
}

// sh:in must not mix URIs and literals
function inHomogeneous(spec) {
  for (const { cond } of conditions(spec)) {
    const c = cond.constraints;
    if (!c.in) continue;
    const uris = c.in.filter(t => t.type === 'uri').length;
    if (uris > 0 && uris < c.in.length) {
      return 'sh:in mixes URIs and text. Pick one.';
    }
  }
  return null;
}

// Typed literals must parse
function literalsParse(spec) {
  const constraintTerms = [];
  for (const { cond } of conditions(spec)) {
    const c = cond.constraints;
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

// rep:where: walks from the row through the profile, shares at least one
// step with its filter or column, and holds no rep:where of its own.
function whereConditions(spec, profile, maxPathDepth) {
  const startShapeUri = startShapeOf(spec, profile);
  for (const { what, cond, host } of conditions(spec)) {
    if (!host) continue;
    if (cond.where.length) {
      return `${what} holds a rep:where of its own. Put every rep:where directly on the filter or column.`;
    }
    const err = walk(profile, startShapeUri, cond.path, maxPathDepth, what, false);
    if (err) return err;
    const k = sharedSteps(host.path, cond.path);
    if (!k) {
      return `${what} shares no step with ${host.what}. Start its path with the same steps as ${host.what}; a condition on the row itself goes in sh:property.`;
    }
    const c = cond.constraints;
    if (k === cond.path.length && (c.maxCount === 0 || c.minCount === 2)) {
      return `${what} ends on a step of ${host.what}, so ${c.maxCount === 0 ? 'sh:maxCount 0' : 'sh:minCount 2'} has nothing to count. Add the step that must be missing or repeated.`;
    }
  }
  for (const [i, filter] of spec.filters.entries()) {
    if (filter.where.length && filter.constraints.minCount === 2) {
      return `filter ${i + 1} combines sh:minCount 2 with rep:where. Use one of the two.`;
    }
  }
  return null;
}

// Where each rep:where applies, in the profile's words, so the proposal can
// say it. Profile only, no database.
export function whereNotes(spec, profile) {
  const startShapeUri = startShapeOf(spec, profile);
  return conditions(spec).filter(x => x.host).map(({ what, cond, host }) => {
    const k = sharedSteps(host.path, cond.path);
    return `${what} applies at ${nodeName(profile, startShapeUri, host.path.slice(0, k))}, after step ${k} of ${host.what}.`;
  });
}

// The entity a path lands on, or the value field when it ends on one.
function nodeName(profile, startShapeUri, hops) {
  let shapeUri = startShapeUri;
  for (const [i, hop] of hops.entries()) {
    const f = fieldsOf(profile, shapeUri).find(x => x.path === hop.predicate && !!x.inverse === !!hop.inverse);
    if (!f) return `step ${hops.length}`;
    if (!f.node) return i === hops.length - 1 ? `the value "${f.name}"` : `step ${hops.length}`;
    shapeUri = f.node;
  }
  return `"${profile.shapes.find(s => s.uri === shapeUri)?.label || shapeUri}"`;
}

function parsesAsDate(value, withTime) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return withTime ? value.includes('T') : /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const CHECKS = [
  ['no entity or unknown class', startEntity],
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
  ['rep:where does not fit', whereConditions],
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

// The shape a path lands in: follow sh:node through every hop but the
// last. walk() has already validated the path, so a gap here means the walk
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

function walk(profile, startShapeUri, hops, maxPathDepth, what, isColumn, wantsIri = false) {
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
      const have = fields.map(x => (x.inverse ? `${x.name} (${x.path}, inverse)` : `${x.name} (${x.path})`)).join(', ');
      const shapeLabel = profile.shapes.find(s => s.uri === shapeUri)?.label || shapeUri;
      return `at "${shapeLabel}" there is no "${hop.predicate}". It has: ${have || '(nothing)'}.`;
    }
    if (i < hops.length - 1) {
      if (!f.node) {
        return `${what} hop ${i + 1} <${hop.predicate}> holds a value, not a link. You cannot walk past it.`;
      }
      shapeUri = f.node;
    } else if (isColumn) {
      if (wantsIri && f.datatype) {
        return `column "${colLabel(what)}" has sh:nodeKind sh:IRI but ends on the value "${f.name}", which is no URI. Drop sh:nodeKind.`;
      }
      if (!wantsIri && !f.datatype && !f.class) {
        const valueFields = fieldsOf(profile, f.node)
          .filter(x => x.datatype || x.class)
          .map(x => `${x.name} (${x.path})`);
        return `column "${colLabel(what)}" ends on a link. Add a hop: ${valueFields.join(' or ')}. Only if the user asked for the URI of that node itself, add sh:nodeKind sh:IRI to the column instead.`;
      }
    }
  }
  return null;
}

function colLabel(what) {
  const m = what.match(/"([^"]+)"/);
  return m ? m[1] : what;
}