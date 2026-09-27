import { query, sparqlEscapeUri } from 'mu';
import { hopsPattern, wherePatterns } from './seed.js';

// Fetch the column values of the subjects. Columns with the same path and
// the same rep:where share one query. rep:self columns (empty path) need no
// query: assemble.js fills them. Every query also returns the nodes on the
// path, so assemble.js can pair columns by the nodes they share.

const SUBJECT_CHUNK_SIZE = Math.max(1, Number(process.env.SUBJECT_CHUNK_SIZE) || 100);

// Returns subject → column index → [chain], a chain being the terms on the
// path, one per step, the value last.
export async function fetchColumns(subjects, spec) {
  const values = new Map();
  const groups = groupColumns(spec.columns);
  for (const group of groups) {
    for (let i = 0; i < subjects.length; i += SUBJECT_CHUNK_SIZE) {
      const chunk = subjects.slice(i, i + SUBJECT_CHUNK_SIZE);
      const result = await query(groupQuery(group, chunk));
      collect(result, group, values);
    }
  }
  return values;
}

function groupColumns(columns) {
  const groups = new Map();
  columns.forEach((col, index) => {
    if (!col.path.length) return;   // rep:self
    const where = col.where || [];
    const key = col.path.map(h => `${h.inverse ? '^' : ''}${h.predicate}`).join(' > ')
      + (where.length ? ` | ${JSON.stringify(where)}` : '');
    if (!groups.has(key)) {
      groups.set(key, { hops: col.path, where, columns: [] });
    }
    groups.get(key).columns.push(index);
  });
  return [...groups.values()];
}

function groupQuery(group, chunk) {
  const subjects = chunk.map(sparqlEscapeUri).join(' ');
  // every hop except the last gets its own variable; the leaf is ?v
  const lines = [hopsPattern(group.hops, 'x', '?s', '?v')];
  // rep:where hangs on the column's own nodes: ?x_<k> after k hops, ?v at
  // the end.
  const nodeVar = (k) => (k === group.hops.length ? '?v' : `?x_${k}`);
  lines.push(...wherePatterns(group.where, group.hops, nodeVar, 'c'));
  const vars = ['?s', ...group.hops.slice(1).map((hop, i) => `?x_${i + 1}`), '?v'];
  return `SELECT DISTINCT ${vars.join(' ')} WHERE {\n  VALUES ?s { ${subjects} }\n  ${lines.join('\n  ')}\n}`;
}

function collect(result, group, values) {
  for (const b of result.results.bindings) {
    const chain = [...group.hops.slice(1).map((hop, i) => b[`x_${i + 1}`]), b.v];
    let perColumn = values.get(b.s.value);
    if (!perColumn) { perColumn = new Map(); values.set(b.s.value, perColumn); }
    for (const index of group.columns) {
      let list = perColumn.get(index);
      if (!list) { list = []; perColumn.set(index, list); }
      list.push(chain);
    }
  }
}
