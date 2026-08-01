'use strict';
// A ~140-line JSON Schema subset validator. cmux-remote has zero runtime dependencies and this is
// not the file that changes that. It exists so state.schema.json is LOAD-BEARING — the fixtures and
// every derived snapshot are validated against it in the test suite — rather than decorative.
//
// Supported: $ref (local), $defs, type (incl. arrays and "null"), enum, const, required,
// properties, additionalProperties, patternProperties, items, minItems, minimum, maximum, pattern,
// allOf, anyOf, oneOf. Anything else in a schema is ignored, so an unsupported keyword can never
// cause a false PASS to look like coverage — it simply is not checked.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`schema-lite: unsupported $ref ${ref}`);
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    node = node[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
    if (node === undefined) throw new Error(`schema-lite: $ref not found: ${ref}`);
  }
  return node;
}

function check(schema, data, root, at, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push(`${at}: schema is false`); return; }
  if (schema.$ref) return check(resolveRef(schema.$ref, root), data, root, at, errors);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(`${at}: expected type ${types.join('|')}, got ${typeOf(data)}`);
      return;                                   // downstream keywords would only produce noise
    }
  }
  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) {
    errors.push(`${at}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof schema.pattern === 'string' && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${at}: ${JSON.stringify(data)} does not match /${schema.pattern}/`);
  }
  if (typeof schema.minimum === 'number' && typeof data === 'number' && data < schema.minimum) {
    errors.push(`${at}: ${data} < minimum ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && typeof data === 'number' && data > schema.maximum) {
    errors.push(`${at}: ${data} > maximum ${schema.maximum}`);
  }

  if (typeOf(data) === 'object') {
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, req)) errors.push(`${at}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    const patterns = Object.keys(schema.patternProperties || {}).map((p) => [new RegExp(p), schema.patternProperties[p]]);
    for (const key of Object.keys(data)) {
      let handled = false;
      if (Object.prototype.hasOwnProperty.call(props, key)) { check(props[key], data[key], root, `${at}.${key}`, errors); handled = true; }
      for (const [re, sub] of patterns) {
        if (re.test(key)) { check(sub, data[key], root, `${at}.${key}`, errors); handled = true; }
      }
      if (!handled && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`);
        else check(schema.additionalProperties, data[key], root, `${at}.${key}`, errors);
      }
    }
  }

  if (typeOf(data) === 'array') {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) errors.push(`${at}: ${data.length} items < minItems ${schema.minItems}`);
    if (schema.items !== undefined) data.forEach((v, i) => check(schema.items, v, root, `${at}[${i}]`, errors));
  }

  for (const sub of schema.allOf || []) check(sub, data, root, at, errors);

  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((sub) => { const e = []; check(sub, data, root, at, e); return e.length === 0; });
    if (!ok) errors.push(`${at}: matched none of anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter((sub) => { const e = []; check(sub, data, root, at, e); return e.length === 0; });
    if (hits.length !== 1) errors.push(`${at}: matched ${hits.length} of oneOf (expected exactly 1)`);
  }
}

// Returns { valid, errors[] }. Never throws for data problems — only for a malformed schema.
function validate(schema, data) {
  const errors = [];
  check(schema, data, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

module.exports = { validate };
