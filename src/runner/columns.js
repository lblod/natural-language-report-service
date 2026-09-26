import { sparqlEscapeUri } from '../db.js';

// Fetch column values for known subjects. Columns are grouped by their
// shared non-leaf hops; two columns share a query only when every hop
// before the leaf is identical, and the leaf is read the same way.
// rep:self columns (empty path) are filled by assemble.js.

const SUBJECT_CHUNK_SIZE = Math.max(1, Number(process.env.SUBJECT_CHUNK_SIZE) || 100);

export async function fetchColumns(sessionQuery, subjects, spec, values = new Map()) {
  const groups = groupColumns(spec.columns);
  for (const group of groups) {
    for (let i = 0; i < subjects.length; i += SUBJECT_CHUNK_SIZE) {
      const chunk = subjects.slice(i, i + SUBJECT_CHUNK_SIZE);
      const result = await sessionQuery(groupQuery(group, chunk));
      collect(result, group, values);
    }
  }
  return values;
}

// Group columns by their shared prefix (every hop before the leaf) and the
// direction of the leaf. A column with an empty path (rep:self) joins no group.
export function groupColumns(columns) {
  const groups = new Map();
  columns.forEach((col, index) => {
    if (!col.path.length) return;   // rep:self
    const leaf = col.path[col.path.length - 1];
    const key = col.path.map(h => `${h.inverse ? '^' : ''}${h.predicate}`).join(' > ');
    if (!groups.has(key)) {
      groups.set(key, { hops: col.path, columns: [] });
    }
    groups.get(key).columns.push({ index, leaf: leaf.predicate });
  });
  return [...groups.values()];
}

export function groupQuery(group, chunk) {
  const subjects = chunk.map(sparqlEscapeUri).join(' ');
  const lines = [];
  let prev = '?s';
  // every hop except the last gets its own variable; the leaf is ?v
  group.hops.slice(0, -1).forEach((hop, i) => {
    const v = `?x${i}`;
    if (hop.inverse) lines.push(`${v} ${sparqlEscapeUri(hop.predicate)} ${prev} .`);
    else lines.push(`${prev} ${sparqlEscapeUri(hop.predicate)} ${v} .`);
    prev = v;
  });
  const leaf = group.hops[group.hops.length - 1];
  if (leaf.inverse) lines.push(`?v ${sparqlEscapeUri(leaf.predicate)} ${prev} .`);
  else lines.push(`${prev} ${sparqlEscapeUri(leaf.predicate)} ?v .`);
  return `SELECT ?s ?v WHERE {\n  VALUES ?s { ${subjects} }\n  ${lines.join('\n  ')}\n}`;
}

function collect(result, group, values) {
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