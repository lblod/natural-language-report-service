import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeDate } from '../db.js';

// Subject selection. One paged query per page; stops at ROW_LIMIT.
const ROW_LIMIT = Number(process.env.ROW_LIMIT || 200000);
const PAGE_SIZE = Number(process.env.SEED_PAGE_SIZE || 5000);

export async function seed(sessionQuery, spec) {
  const subjects = [];
  let offset = 0;
  for (;;) {
    const query = seedPageQuery(spec, PAGE_SIZE, offset);
    const result = await sessionQuery(query);
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

export function seedPageQuery(spec, limit, offset) {
  const parts = [];
  parts.push(`?s a ${sparqlEscapeUri(spec.targetClass)} .`);
  spec.filters.forEach((filter, fi) => {
    parts.push(hopsPattern(filter.path, `f${fi}`, '?s'));
    parts.push(constraintsPattern(filter.constraints, `f${fi}`));
  });
  return `SELECT DISTINCT ?s WHERE {
  ${parts.join('\n  ')}
}
LIMIT ${limit} OFFSET ${offset}`;
}

// Writes out every hop as its own triple pattern.
// Forward:  ?s <p1> ?f0_1 . ?f0_1 <p2> ?f0_v
// Inverse:  ?s ^<p1> → ?f0_1 <p1> ?s
export function hopsPattern(hops, varPrefix, startVar) {
  let prev = startVar;
  const patterns = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const isLast = i === hops.length - 1;
    const v = isLast ? `?${varPrefix}_v` : `?${varPrefix}_${i + 1}`;
    if (hop.inverse) {
      patterns.push(`${v} ${sparqlEscapeUri(hop.predicate)} ${prev} .`);
    } else {
      patterns.push(`${prev} ${sparqlEscapeUri(hop.predicate)} ${v} .`);
    }
    prev = v;
  }
  return patterns.join('\n  ');
}

export function constraintsPattern(c, varPrefix) {
  const parts = [];
  const v = `?${varPrefix}_v`;

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
    // two distinct leaf values on the same path
    const w = `?${varPrefix}_w`;
    parts.push(hopsPattern2(c, varPrefix, w));
    parts.push(`FILTER(${v} != ${w})`);
  }
  if (c.maxCount === 0) {
    parts.push(`FILTER NOT EXISTS { ${hopsPattern(c.path, varPrefix + '_nex', '?s')} }`);
  }
  return parts.join('\n  ');
}

function hopsPattern2(filter, varPrefix, wVar) {
  // repeat the path to a second leaf variable
  const hops = filter.path.map(h => ({ ...h }));
  let prev = '?s';
  const patterns = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const isLast = i === hops.length - 1;
    const v = isLast ? wVar : `?${varPrefix}_2_${i + 1}`;
    if (hop.inverse) patterns.push(`${v} ${sparqlEscapeUri(hop.predicate)} ${prev} .`);
    else patterns.push(`${prev} ${sparqlEscapeUri(hop.predicate)} ${v} .`);
    prev = v;
  }
  return patterns.join('\n  ');
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