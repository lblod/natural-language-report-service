import { query, sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeDate } from 'mu';
import { countSharedSteps } from './spec.js';

// The subjects of a report, PAGE_SIZE per query. More than ROW_LIMIT
// subjects fails the run.
const ROW_LIMIT = Number(process.env.ROW_LIMIT || 200000);
const PAGE_SIZE = 5000;

// The subjects of the report (what the rows are about) that match the
// class, the discriminators and the filters, PAGE_SIZE at a time. More than
// ROW_LIMIT means the question is too broad: fail with a hint to filter.
export async function fetchSubjects(spec, shape) {
  const subjects = [];
  let offset = 0;
  for (;;) {
    const result = await query(buildSeedPageQuery(spec, shape, PAGE_SIZE, offset));
    const rows = result.results.bindings.map(b => b.s.value);
    subjects.push(...rows);
    if (subjects.length > ROW_LIMIT) {
      throw new Error(`the question matches more than ${ROW_LIMIT} subjects. Add a filter, for example a date range or a bestuurseenheid.`);
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return subjects;
}

// One page of subjects: the class, the shape's discriminators and the
// spec's filters in one SELECT. The validator made sure spec.targetClass is
// the class of shape. ORDER BY ?s: without it SPARQL promises no order, so
// two pages could overlap or skip a subject.
function buildSeedPageQuery(spec, shape, limit, offset) {
  const parts = [`?s a ${sparqlEscapeUri(spec.targetClass)} .`];
  shape.discriminators.forEach((d, di) => {
    parts.push(buildDiscriminatorPattern(d, `disc${di}`));
  });
  spec.filters.forEach((filter, fi) => {
    parts.push(buildFilterPattern(filter, `f${fi}`));
  });
  return `SELECT DISTINCT ?s WHERE {
  ${parts.join('\n  ')}
}
ORDER BY ?s
LIMIT ${limit} OFFSET ${offset}`;
}

// A shape that shares its class with another says here what sets its
// subjects apart. A plain discriminator is a filter; sh:and, sh:or and sh:not
// become one FILTER over EXISTS tests, which see ?s from outside.
function buildDiscriminatorPattern(d, varPrefix) {
  if (!d.and && !d.or && !d.not) return buildFilterPattern(d, varPrefix);
  return `FILTER(${buildDiscriminatorTest(d, varPrefix)})`;
}

// A discriminator as a test inside FILTER(): and/or/not combine EXISTS
// tests; sh:maxCount 0 becomes NOT EXISTS.
function buildDiscriminatorTest(d, varPrefix) {
  if (d.and) return `(${d.and.map((x, i) => buildDiscriminatorTest(x, `${varPrefix}_${i}`)).join(' && ')})`;
  if (d.or) return `(${d.or.map((x, i) => buildDiscriminatorTest(x, `${varPrefix}_${i}`)).join(' || ')})`;
  if (d.not) return `!(${buildDiscriminatorTest(d.not, `${varPrefix}_n`)})`;
  const { maxCount, ...test } = d.constraints;
  if (maxCount === 0) return `NOT EXISTS { ${buildFilterPattern({ ...d, constraints: test }, varPrefix)} }`;
  return `EXISTS { ${buildFilterPattern(d, varPrefix)} }`;
}

// Writes out every hop as its own triple pattern, one variable per node.
// The subjects query and the column queries both use it.
// Forward:  ?s <p1> ?f0_1 . ?f0_1 <p2> ?f0_v
// Inverse:  ?s ^<p1> → ?f0_1 <p1> ?s
export function buildHopsPattern(hops, varPrefix, startVar, lastVar = `?${varPrefix}_v`) {
  let prev = startVar;
  const patterns = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const isLast = i === hops.length - 1;
    const v = isLast ? lastVar : `?${varPrefix}_${i + 1}`;
    if (hop.inverse) {
      patterns.push(`${v} ${sparqlEscapeUri(hop.predicate)} ${prev} .`);
    } else {
      patterns.push(`${prev} ${sparqlEscapeUri(hop.predicate)} ${v} .`);
    }
    prev = v;
  }
  return patterns.join('\n  ');
}

// One filter: its condition, plus its rep:where conditions on the nodes it
// walks through. With sh:maxCount 0 the whole of it becomes "none such";
// with a value test too (sh:in, sh:hasValue, ...), "none with such a value".
function buildFilterPattern(filter, varPrefix) {
  const { maxCount, ...test } = filter.constraints;
  if (maxCount === 0) {
    return `FILTER NOT EXISTS {\n    ${buildFilterPattern({ ...filter, constraints: test }, varPrefix)}\n  }`;
  }
  const nodeVar = (k) => (k === filter.path.length ? `?${varPrefix}_v` : `?${varPrefix}_${k}`);
  const wheres = buildWherePatterns(filter.where, filter.path, nodeVar, varPrefix);
  return [buildConditionPattern(filter.constraints, varPrefix, filter.path, '?s'), ...wheres].join('\n  ');
}

// The rep:where conditions of a filter or column. Each starts at the node
// after the steps it shares with its host; nodeVar(k) names that node in the
// host's own query.
export function buildWherePatterns(where, hostHops, nodeVar, varPrefix) {
  return (where || []).map((w, wi) => {
    const k = countSharedSteps(hostHops, w.path);
    return buildConditionPattern(w.constraints, `${varPrefix}_w${wi}`, w.path.slice(k), nodeVar(k));
  });
}

// A condition: the hops from startVar and the test on where they end. A
// filter starts at ?s; a rep:where starts at a node of its host and, with no
// hops left, tests that node itself. sh:maxCount 0 means "none such", so its
// hops and any value test only live inside the NOT EXISTS.
function buildConditionPattern(c, varPrefix, hops, startVar) {
  if (c.maxCount === 0) {
    const { maxCount, ...test } = c;
    return `FILTER NOT EXISTS { ${buildConditionPattern(test, varPrefix + '_nex', hops, startVar)} }`;
  }
  const v = hops.length ? `?${varPrefix}_v` : startVar;
  const parts = hops.length ? [buildHopsPattern(hops, varPrefix, startVar)] : [];

  if (c.hasValue) parts.push(`FILTER(${v} = ${escapeTerm(c.hasValue)})`);
  if (c.in) parts.push(`FILTER(${v} IN (${c.in.map(escapeTerm).join(', ')}))`);
  if (c.minInclusive) parts.push(`FILTER(${v} >= ${escapeTerm(c.minInclusive)})`);
  if (c.maxInclusive) parts.push(`FILTER(${v} <= ${escapeTerm(c.maxInclusive)})`);
  if (c.minExclusive) parts.push(`FILTER(${v} > ${escapeTerm(c.minExclusive)})`);
  if (c.maxExclusive) parts.push(`FILTER(${v} < ${escapeTerm(c.maxExclusive)})`);
  if (c.pattern) {
    const flags = c.flags ? `, ${sparqlEscapeString(c.flags)}` : '';
    parts.push(`FILTER(REGEX(str(${v}), ${sparqlEscapeString(c.pattern)}${flags}))`);
  }
  if (c.anyOf) {
    const alternation = c.anyOf.map(t => escapeRegexTerm(t.value)).join('|');
    const flags = c.flags ? `, ${sparqlEscapeString(c.flags)}` : ', "i"';
    parts.push(`FILTER(REGEX(str(${v}), ${sparqlEscapeString(alternation)}${flags}))`);
  }
  if (c.minCount === 2) {
    // two distinct leaf values: the same path again, to a second leaf
    const w = `?${varPrefix}_w`;
    parts.push(buildHopsPattern(hops, `${varPrefix}_2`, startVar, w));
    parts.push(`FILTER(${v} != ${w})`);
  }
  return parts.join('\n  ');
}

// A spec value as SPARQL: a URI, a date, a dateTime, an integer or a
// boolean. Any other datatype becomes a plain string.
function escapeTerm(t) {
  if (t.type === 'uri') return sparqlEscapeUri(t.value);
  if (t.datatype === 'http://www.w3.org/2001/XMLSchema#dateTime')
    return sparqlEscapeDateTime(new Date(t.value));
  if (t.datatype === 'http://www.w3.org/2001/XMLSchema#date')
    return sparqlEscapeDate(new Date(t.value));
  if (t.datatype === 'http://www.w3.org/2001/XMLSchema#integer')
    return Number(t.value);
  if (t.datatype === 'http://www.w3.org/2001/XMLSchema#boolean')
    return t.value === 'true';
  return sparqlEscapeString(t.value);
}

// A rep:anyOf word as plain text inside the regex: a "." or "(" in a word
// must not act as regex syntax.
function escapeRegexTerm(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}