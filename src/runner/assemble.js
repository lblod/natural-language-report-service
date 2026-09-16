// Values to rows. Subjects in stable order, dedup on term, collect per cell.
// rep:self columns take the subject URI; a column with no values is an
// empty cell, never a dropped row. A column without rep:collect joins its
// values only when there is one; with several, each value gets its own row
// (the other columns repeat theirs). rep:row forces that expansion; at most
// one column per spec may do that explicitly (checked in check.js).

const SH = 'http://www.w3.org/ns/shacl#';
const REP = 'http://mu.semte.ch/vocabularies/reporting/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const NUMERIC_DATATYPES = new Set([
  'integer', 'decimal', 'double', 'float', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
].map(d => XSD + d));
export const TEMPORAL_DATATYPES = new Set([XSD + 'date', XSD + 'dateTime']);

export function assemble(subjects, values, spec) {
  const sorted = [...subjects].sort();
  const rows = [spec.columns.map(c => c.label)];
  for (const subject of sorted) {
    const perColumn = values.get(subject) || new Map();
    const cells = spec.columns.map((col, i) => {
      if (!col.path.length) return [subject];   // rep:self
      const list = dedup(perColumn.get(i) || []);
      return collect(list, col);
    });
    const lines = Math.max(1, ...cells.map(c => c.length));
    for (let r = 0; r < lines; r++) {
      // the expanding cell cycles its values, every other cell keeps its
      // value on each line
      rows.push(cells.map(c => c[Math.min(r, c.length - 1)]));
    }
  }
  return rows;
}

function collect(terms, col) {
  switch (col.collect) {
    case SH + 'groupConcat':
      return [terms.map(t => t.value).join(col.separator ?? ',')];
    case undefined:
    case null:
      // no rep:collect: one value is a normal cell, several values each
      // get their own row instead of a joined string
      if (terms.length <= 1) return [terms.map(t => t.value).join(',')];
      return terms.map(t => t.value);
    case SH + 'min':
      return [extreme(terms, col, -1)];
    case SH + 'max':
      return [extreme(terms, col, 1)];
    case REP + 'row':
      return terms.length ? terms.map(t => t.value) : [''];
    default:
      throw new Error(`column "${col.label}" has an unknown rep:collect <${col.collect}>. Use sh:groupConcat, rep:row, sh:min or sh:max.`);
  }
}

// min/max over values that share one datatype. Numbers compare as numbers,
// dates and times as instants. Mixed datatypes throw: check.js should have
// caught it, and a silently wrong cell is worse than a failed job.
function extreme(terms, col, direction) {
  if (!terms.length) return '';
  const datatypes = [...new Set(terms.map(t => t.datatype?.value || ''))];
  if (datatypes.length > 1) {
    throw new Error(`column "${col.label}" asks for sh:${direction < 0 ? 'min' : 'max'} but its values carry ${datatypes.length} datatypes (${datatypes.join(', ')}).`);
  }
  const dt = datatypes[0];
  const key = NUMERIC_DATATYPES.has(dt) ? t => Number(t.value)
    : TEMPORAL_DATATYPES.has(dt) ? t => new Date(t.value).getTime()
    : t => t.value;
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const best = terms.reduce((a, b) => (cmp(key(b), key(a)) * direction > 0 ? b : a));
  return best.value;
}

// Two terms are the same when the URIs match, or lexical form, datatype
// and language tag all match.
export function dedup(terms) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    const key = t.termType === 'NamedNode'
      ? `u:${t.value}`
      : `l:${t.value}|${t.datatype?.value || ''}|${t.language || ''}`;
    if (!seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}