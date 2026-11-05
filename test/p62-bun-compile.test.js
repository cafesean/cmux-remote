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
    assert.match(src, /if \(secretsIn\.pending\(\)\) secretsIn\.loadSecrets\(\{ require: \[[^\]]+\] \}\)\.then\(main\);\nelse main\(\);\nfunction main\(\) \{/);
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

// D62: role is explicit, never guessed from the entry filename (a Bun binary's entry is not
// server.js/bridge.js). Each entry names exactly its own required secret.
test('server.js / bridge.js pass explicit require lists to loadSecrets', () => {
  for (const [f, want] of [['server.js', ['SERVER_TOKEN']], ['bridge.js', ['BRIDGE_SECRET']]]) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const calls = [...src.matchAll(/secretsIn\.loadSecrets\(([^)]*)\)/g)];
    assert.strictEqual(calls.length, 1, `${f}: exactly one loadSecrets call`);
    const m = /^\{ require: \[([^\]]*)\] \}$/.exec(calls[0][1]);
    assert.ok(m, `${f}: loadSecrets called with { require: [...] }`);
    assert.deepStrictEqual(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')), want, f);
  }
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'secrets-stdin.js'), 'utf8');
  assert.doesNotMatch(lib, /require\.main|module\.parent|process\.argv\[1\]/, 'no entry-filename role guess');
});

// The guess is gone, so an entry renamed by bun (or anything) still fails closed with its list.
test('loadSecrets: explicit require fails closed regardless of entry name; bad name fails closed', () => {
  const { spawnSync } = require('child_process');
  const run = (req, line) => {
    const code = `
      const { EventEmitter } = require('events');
      const s = require(${JSON.stringify(path.join(ROOT, 'lib/secrets-stdin.js'))});
      const fake = new EventEmitter(); fake.pause = () => {}; fake.resume = () => {};
      s.loadSecrets({ stdin: fake, require: ${JSON.stringify(req)}, exit: (c) => { console.log('EXIT', c); process.exit(0); } })
        .then(() => console.log('LOADED'));
      fake.emit('data', Buffer.from(${JSON.stringify(line)}));`;
    return spawnSync(process.execPath, ['-e', code], {
      env: { PATH: process.env.PATH, HOME: require('os').tmpdir(), HYPERMUX_SECRETS_ON_STDIN: '1' }, encoding: 'utf8',
    }).stdout;
  };
  assert.match(run(['SERVER_TOKEN'], '{"BRIDGE_SECRET":"x"}\n'), /EXIT 78/);
  assert.match(run(['BRIDGE_SECRET'], '{"SERVER_TOKEN":"x"}\n'), /EXIT 78/);
  assert.match(run(['SERVER_TOKN'], '{"SERVER_TOKEN":"x"}\n'), /EXIT 78/);
  assert.match(run(['SERVER_TOKEN'], '{"SERVER_TOKEN":"x"}\n'), /LOADED/);
});
