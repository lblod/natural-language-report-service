import { query, sparqlEscapeUri } from 'mu';
import { hopsPattern, wherePatterns } from './seed.js';

// Fetch column values for known subjects. Columns are grouped by their
// shared non-leaf hops; two columns share a query only when every hop
// before the leaf is identical, and the leaf is read the same way.
// rep:self columns (empty path) are filled by assemble.js.

const SUBJECT_CHUNK_SIZE = Math.max(1, Number(process.env.SUBJECT_CHUNK_SIZE) || 100);

// fetchColumns(subjects, spec) → subject → column index → [term]
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

// Group columns by their shared prefix (every hop before the leaf) and the
// direction of the leaf. A column with an empty path (rep:self) joins no group.
// A column with rep:where only shares a group with the same conditions.
export function groupColumns(columns) {
  const groups = new Map();
  columns.forEach((col, index) => {
    if (!col.path.length) return;   // rep:self
    const leaf = col.path[col.path.length - 1];
    const where = col.where || [];
    const key = col.path.map(h => `${h.inverse ? '^' : ''}${h.predicate}`).join(' > ')
      + (where.length ? ` | ${JSON.stringify(where)}` : '');
    if (!groups.has(key)) {
      groups.set(key, { hops: col.path, where, columns: [] });
    }
    groups.get(key).columns.push({ index, leaf: leaf.predicate });
  });
  return [...groups.values()];
}

export function groupQuery(group, chunk) {
  const subjects = chunk.map(sparqlEscapeUri).join(' ');
  // every hop except the last gets its own variable; the leaf is ?v
  const lines = [hopsPattern(group.hops, 'x', '?s', '?v')];
  // rep:where hangs on the column's own nodes: ?x_<k> after k hops, ?v at
  // the end.
  const nodeVar = (k) => (k === group.hops.length ? '?v' : `?x_${k}`);
  lines.push(...wherePatterns(group.where, group.hops, nodeVar, 'c'));
  return `SELECT ?s ?v WHERE {\n  VALUES ?s { ${subjects} }\n  ${lines.join('\n  ')}\n}`;
}

export function collect(result, group, values) {
  for (const b of result.results.bindings) {
    let perColumn = values.get(b.s.value);
    if (!perColumn) { perColumn = new Map(); values.set(b.s.value, perColumn); }
    for (const col of group.columns) {
      let list = perColumn.get(col.index);
      if (!list) { list = []; perColumn.set(col.index, list); }
      list.push(b.v);
    }
  }
}