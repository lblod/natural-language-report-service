import { query, sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeDate } from 'mu';
import { sharedSteps } from './spec.js';

// Subject selection. One paged query per page; stops at ROW_LIMIT.
const ROW_LIMIT = Number(process.env.ROW_LIMIT || 200000);
const PAGE_SIZE = Number(process.env.SEED_PAGE_SIZE || 5000);

export async function seed(spec, shape) {
  const subjects = [];
  let offset = 0;
  for (;;) {
    const result = await query(seedPageQuery(spec, PAGE_SIZE, offset, shape));
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

export function seedPageQuery(spec, limit, offset, shape = null) {
  const parts = [];
  const targetClass = spec.targetClass || shape?.targetClass;
  parts.push(`?s a ${sparqlEscapeUri(targetClass)} .`);
  if (shape?.discriminator) parts.push(discriminatorPattern(shape.discriminator));
  spec.filters.forEach((filter, fi) => {
    parts.push(filterPattern(filter, `f${fi}`));
  });
  return `SELECT DISTINCT ?s WHERE {
  ${parts.join('\n  ')}
}
LIMIT ${limit} OFFSET ${offset}`;
}

// A shape that shares its class with another says here what sets its
// subjects apart: sh:minCount 1 is a plain triple, sh:maxCount 0 a NOT EXISTS.
function discriminatorPattern(d) {
  const p = sparqlEscapeUri(d.path);
  const triple = d.inverse ? `?disc ${p} ?s .` : `?s ${p} ?disc .`;
  if (d.minCount !== null && d.minCount >= 1) return triple;
  if (d.maxCount === 0) return `FILTER NOT EXISTS { ${triple} }`;
  return null;
}

// Writes out every hop as its own triple pattern.
// Forward:  ?s <p1> ?f0_1 . ?f0_1 <p2> ?f0_v
// Inverse:  ?s ^<p1> → ?f0_1 <p1> ?s
export function hopsPattern(hops, varPrefix, startVar, lastVar = `?${varPrefix}_v`) {
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
// walks through. With sh:maxCount 0 the whole of it becomes "none such".
function filterPattern(filter, varPrefix) {
  const nodeVar = (k) => (k === filter.path.length ? `?${varPrefix}_v` : `?${varPrefix}_${k}`);
  const wheres = wherePatterns(filter.where, filter.path, nodeVar, varPrefix);
  if (filter.constraints.maxCount === 0) {
    return `FILTER NOT EXISTS {\n    ${[hopsPattern(filter.path, varPrefix, '?s'), ...wheres].join('\n    ')}\n  }`;
  }
  return [conditionPattern(filter.constraints, varPrefix, filter.path, '?s'), ...wheres].join('\n  ');
}

// The rep:where conditions of a filter or column. Each starts at the node
// after the steps it shares with its host; nodeVar(k) names that node in the
// host's own query.
export function wherePatterns(where, hostHops, nodeVar, varPrefix) {
  return (where || []).map((w, wi) => {
    const k = sharedSteps(hostHops, w.path);
    return conditionPattern(w.constraints, `${varPrefix}_w${wi}`, w.path.slice(k), nodeVar(k));
  });
}

// A condition: the hops from startVar and the test on where they end. A
// filter starts at ?s; a rep:where starts at a node of its host and, with no
// hops left, tests that node itself. sh:maxCount 0 means "none such", so its
// hops only live inside the NOT EXISTS.
export function conditionPattern(c, varPrefix, hops, startVar) {
  if (c.maxCount === 0) {
    return `FILTER NOT EXISTS { ${hopsPattern(hops, varPrefix + '_nex', startVar)} }`;
  }
  const v = hops.length ? `?${varPrefix}_v` : startVar;
  const parts = hops.length ? [hopsPattern(hops, varPrefix, startVar)] : [];

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
    parts.push(hopsPattern(hops, `${varPrefix}_2`, startVar, w));
    parts.push(`FILTER(${v} != ${w})`);
  }
  return parts.join('\n  ');
}

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

function escapeRegexTerm(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}