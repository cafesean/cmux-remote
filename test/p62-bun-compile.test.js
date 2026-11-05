'use strict';
// D62 (K1): the server/bridge sources must survive `bun build --compile`.
//  - no raw NUL byte in any source (Bun turns it into U+FFFD and the binary crashes at load)
//  - radar/handoff-keys.js CONTROL regex still rejects NUL / C0 / DEL, accepts ordinary text
//  - no top-level `return` + self re-require in server.js / bridge.js (Bun drops the return, so the
//    body ran before stdin secrets were read: auth open)
//  - lib/pkg-root.js: node keeps the repo dir; only a Bun-compiled binary looks elsewhere
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'test' || e.name === 'evidence') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|json|html|css)$/.test(e.name)) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

test('no shipped source holds a raw NUL byte', () => {
  const bad = sources().filter((p) => fs.readFileSync(p).includes(0));
  assert.deepStrictEqual(bad.map((p) => path.relative(ROOT, p)), []);
});

test('handoff-keys CONTROL: NUL, C0 and DEL rejected; plain and unicode text accepted', () => {
  const { parseSelector } = require('../radar/handoff-keys');
  for (const c of ['\x00', '\x01', '\x1f', '\x7f']) {
    assert.deepStrictEqual(parseSelector(`epic:a${c}b`), { ok: false }, JSON.stringify(c));
  }
  assert.strictEqual(parseSelector('epic:P41').ok, true);
  assert.strictEqual(parseSelector('epic:café — x').ok, true);
  assert.strictEqual(parseSelector('epic:a\x20b').ok, true);   // space (0x20) is just past the range
});

test('server.js and bridge.js: no top-level return, no self re-require; body is main()', () => {
  for (const f of ['server.js', 'bridge.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/require\(__filename\)/.test(src), `${f}: self re-require`);
    assert.ok(!/^\s{0,2}return;\s*$/m.test(src.split('function main() {')[0]), `${f}: top-level return before main()`);
    assert.match(src, /if \(secretsIn\.pending\(\)\) secretsIn\.loadSecrets\(\)\.then\(main\);\nelse main\(\);\nfunction main\(\) \{/);
    assert.ok(src.trimEnd().endsWith('}'), `${f}: main() closed at end of file`);
  }
});

test('pkg-root: node resolves the repo dir, ignoring HYPERMUX_PKG_ROOT', () => {
  const { pkgRoot, isBunCompiled } = require('../lib/pkg-root');
  const prev = process.env.HYPERMUX_PKG_ROOT;
  process.env.HYPERMUX_PKG_ROOT = '/nonexistent/elsewhere';
  try {
    assert.strictEqual(isBunCompiled(), false);
    assert.strictEqual(pkgRoot(), ROOT);
    assert.ok(fs.existsSync(path.join(pkgRoot(), 'public', 'index.html')));
  } finally {
    if (prev === undefined) delete process.env.HYPERMUX_PKG_ROOT; else process.env.HYPERMUX_PKG_ROOT = prev;
  }
});
