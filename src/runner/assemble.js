import { sharedSteps } from './spec.js';

// Values to rows, paired by URI on every step. Two columns that walk the
// same steps (with the same rep:where on them) share the nodes on those
// steps, the way a rep:where shares nodes with its column. Per subject the
// paths of the columns make a tree of the nodes found; every row is one way
// down that tree. Columns through the same node stay on one row; branches
// under one node multiply. A column with no value is an empty cell, never a
// dropped row. sh:groupConcat, sh:min and sh:max fold a column into one cell
// per node it shares with the other columns. rep:self takes the subject
// URI. Subjects in stable order; identical rows appear once.

const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const FOLDING = [SH + 'groupConcat', SH + 'min', SH + 'max'];

export const NUMERIC_DATATYPES = new Set([
  'integer', 'decimal', 'double', 'float', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
].map(d => XSD + d));

// assemble(subjects, values, spec) → rows, the header first. values:
// subject → column index → chains, one term per step (see columns.js).
export function assemble(subjects, values, spec) {
  const tree = columnTree(spec.columns);
  const rows = [spec.columns.map(c => c.label)];
  for (const subject of [...subjects].sort()) {
    const top = { term: { value: subject }, below: new Map() };
    for (const [index, chains] of values.get(subject) || []) {
      for (const chain of chains) addChain(top, tree.paths[index], chain);
    }
    const seen = new Set();
    for (const cells of rowsAt(tree.root, top, tree, spec.columns)) {
      const row = spec.columns.map((col, i) => cells.get(i) ?? '');
      const key = JSON.stringify(row);
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }
  return rows;
}

// The steps of all columns as one tree of branches. Two columns share a
// branch as long as they took the same steps with the same rep:where on
// them. paths[i] lists the branches column i goes through; a branch knows
// the columns that end on it and the columns that go through it.
function columnTree(columns) {
  const newBranch = () => ({ next: new Map(), ends: [], columns: [] });
  const root = newBranch();
  const paths = columns.map((col, index) => {
    let branch = root;
    const branches = col.path.map((hop, k) => {
      const where = col.where.filter(w => sharedSteps(col.path, w.path) === k + 1);
      const key = `${hop.inverse ? '^' : ''}${hop.predicate} ${JSON.stringify(where)}`;
      if (!branch.next.has(key)) branch.next.set(key, newBranch());
      branch = branch.next.get(key);
      branch.columns.push(index);
      return branch;
    });
    branch.ends.push(index);
    return branches;
  });
  return { root, paths };
}

// One path the store returned, subject to value, into the tree of nodes
// found for that subject. Nodes are keyed by value: a node reached twice is
// one node, a value found twice under one node is one value.
function addChain(found, branches, chain) {
  branches.forEach((branch, k) => {
    if (!found.below.has(branch)) found.below.set(branch, new Map());
    const byValue = found.below.get(branch);
    if (!byValue.has(chain[k].value)) byValue.set(chain[k].value, { term: chain[k], below: new Map() });
    found = byValue.get(chain[k].value);
  });
}

// The rows under one found node: its own cells, times the rows of each
// branch below it. A branch where nothing was found adds empty cells.
function rowsAt(branch, found, tree, columns) {
  let rows = [new Map(branch.ends.map(i => [i, found.term.value]))];
  for (const next of branch.next.values()) {
    const nodes = [...(found.below.get(next)?.values() || [])];
    const below = next.columns.every(i => FOLDING.includes(columns[i].collect))
      ? [fold(next, nodes, tree, columns)]
      : nodes.length ? nodes.flatMap(node => rowsAt(next, node, tree, columns)) : [new Map()];
    rows = rows.flatMap(row => below.map(cells => new Map([...row, ...cells])));
  }
  return rows;
}

// A branch where every column folds gives one set of cells: per column, all
// its values in the branch, folded into one cell.
function fold(branch, nodes, tree, columns) {
  const cells = new Map();
  for (const i of branch.columns) {
    const rest = tree.paths[i].slice(tree.paths[i].indexOf(branch) + 1);
    const terms = nodes.flatMap(node => termsBelow(node, rest));
    const unique = [...new Map(terms.map(t => [t.value, t])).values()];
    const col = columns[i];
    cells.set(i, col.collect === SH + 'groupConcat'
      ? unique.map(t => t.value).join(col.separator ?? ',')
      : extreme(unique, col, col.collect === SH + 'min' ? -1 : 1));
  }
  return cells;
}

function termsBelow(node, rest) {
  if (!rest.length) return [node.term];
  const byValue = node.below.get(rest[0]);
  return byValue ? [...byValue.values()].flatMap(next => termsBelow(next, rest.slice(1))) : [];
}

// min/max. Numbers compare as numbers. Dates and times compare as text:
// xsd:date and xsd:dateTime are ISO strings, so text order is date order.
// Numbers mixed with other values throw: check.js should have caught it,
// and a silently wrong cell is worse than a failed job. The terms are SPARQL
// JSON bindings, so the datatype is a plain string.
function extreme(terms, col, direction) {
  if (!terms.length) return '';
  const numbers = terms.filter(t => NUMERIC_DATATYPES.has(t.datatype)).length;
  if (numbers && numbers < terms.length) {
    throw new Error(`column "${col.label}" asks for sh:${direction < 0 ? 'min' : 'max'} but mixes numbers with other values.`);
  }
  const key = numbers ? t => Number(t.value) : t => t.value;
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const best = terms.reduce((a, b) => (cmp(key(b), key(a)) * direction > 0 ? b : a));
  return best.value;
}
