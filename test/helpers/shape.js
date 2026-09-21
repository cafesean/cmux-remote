'use strict';
// Recursive JSON shape comparison for the p18 backend contract (specs.md §15.2 "Shape rule").
//
//   shapeOf(v)       the type signature of a JSON value: objects by their sorted keys (each with its
//                    value's shape), arrays by the SET of their elements' shapes, scalars by type
//   compatible(a,b)  equal; or either side is null; or both are arrays and either is empty.
//                    Objects must have IDENTICAL key sets — a key on one backend and not the other
//                    is exactly the drift this exists to catch.
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)

function shapeOf(v) {
  if (v === null) return { t: 'null' };
  if (Array.isArray(v)) {
    const seen = new Map();
    for (const el of v) {
      const s = shapeOf(el);
      seen.set(JSON.stringify(s), s);
    }
    return { t: 'array', of: [...seen.keys()].sort().map((k) => seen.get(k)) };
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    const o = {};
    for (const k of keys) o[k] = shapeOf(v[k]);
    return { t: 'object', keys: o };
  }
  return { t: typeof v };
}

// -> '' when compatible, else the path and reason of the first difference
function difference(a, b, at) {
  const here = at || '$';
  if (a.t === 'null' || b.t === 'null') return '';
  if (a.t !== b.t) return `${here}: ${a.t} vs ${b.t}`;
  if (a.t === 'array') {
    if (!a.of.length || !b.of.length) return '';
    // every element shape on one side must be compatible with some element shape on the other
    for (const [xs, ys, dir] of [[a.of, b.of, '>'], [b.of, a.of, '<']]) {
      for (const x of xs) {
        const diffs = ys.map((y) => (dir === '>' ? difference(x, y, `${here}[]`) : difference(y, x, `${here}[]`)));
        if (!diffs.some((d) => d === '')) return diffs[0];
      }
    }
    return '';
  }
  if (a.t === 'object') {
    const ka = Object.keys(a.keys), kb = Object.keys(b.keys);
    const onlyA = ka.filter((k) => !(k in b.keys)), onlyB = kb.filter((k) => !(k in a.keys));
    if (onlyA.length || onlyB.length) return `${here}: keys only on the left ${JSON.stringify(onlyA)}, only on the right ${JSON.stringify(onlyB)}`;
    for (const k of ka) {
      const d = difference(a.keys[k], b.keys[k], `${here}.${k}`);
      if (d) return d;
    }
  }
  return '';
}

const compatible = (a, b) => difference(a, b) === '';

module.exports = { shapeOf, compatible, difference };
