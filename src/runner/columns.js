import { query, sparqlEscapeUri } from 'mu';
import { buildHopsPattern, buildWherePatterns } from './seed.js';

// Fetch the column values of the subjects, one query per column per chunk of
// subjects. rep:self columns (empty path) need no query: assemble.js fills
// them. Every query also returns the nodes on the path, so assemble.js can
// pair columns by the nodes they share.

const SUBJECT_CHUNK_SIZE = Math.max(1, Number(process.env.SUBJECT_CHUNK_SIZE) || 100);

// Returns subject → column index → [chain], a chain being the terms on the
// path, one per step, the value last. One query per column per
// SUBJECT_CHUNK_SIZE subjects keeps each query small.
export async function fetchColumns(subjects, spec) {
  const values = new Map();
  for (const [index, col] of spec.columns.entries()) {
    if (!col.path.length) continue;   // rep:self
    for (let i = 0; i < subjects.length; i += SUBJECT_CHUNK_SIZE) {
      const chunk = subjects.slice(i, i + SUBJECT_CHUNK_SIZE);
      const result = await query(buildColumnQuery(col, chunk));
      collect(result, col, index, values);
    }
  }
  return values;
}

// The SPARQL of one column for a chunk of subjects. It returns every node on
// the path, not only the value: assemble.js pairs columns by those nodes.
function buildColumnQuery(col, chunk) {
  const subjects = chunk.map(sparqlEscapeUri).join(' ');
  // every hop except the last gets its own variable; the leaf is ?v
  const lines = [buildHopsPattern(col.path, 'x', '?s', '?v')];
  // rep:where hangs on the column's own nodes: ?x_<k> after k hops, ?v at
  // the end.
  const nodeVar = (k) => (k === col.path.length ? '?v' : `?x_${k}`);
  lines.push(...buildWherePatterns(col.where, col.path, nodeVar, 'c'));
  const vars = ['?s', ...col.path.slice(1).map((hop, i) => `?x_${i + 1}`), '?v'];
  return `SELECT DISTINCT ${vars.join(' ')} WHERE {\n  VALUES ?s { ${subjects} }\n  ${lines.join('\n  ')}\n}`;
}

// Adds one query result to values: per subject, the chain of terms found
// for this column.
function collect(result, col, index, values) {
  for (const b of result.results.bindings) {
    const chain = [...col.path.slice(1).map((hop, i) => b[`x_${i + 1}`]), b.v];
    let perColumn = values.get(b.s.value);
    if (!perColumn) { perColumn = new Map(); values.set(b.s.value, perColumn); }
    let list = perColumn.get(index);
    if (!list) { list = []; perColumn.set(index, list); }
    list.push(chain);
  }
}
