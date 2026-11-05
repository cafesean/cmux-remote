'use strict';
// p62 D83: CMUX_SOCKET_PASSWORD (cmux socket auth) reaches ONLY cmux CLI children. childEnv()
// strips it like every secret; cmuxChildEnv() adds it back, and only cmux CLI spawn sites use it.
// Fixture values only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const REPO = path.join(__dirname, '..');
const SECRETS_JS = path.join(REPO, 'lib/secrets-stdin.js');
const PW = 'p62-d83-fixture-socket-pw-ZZZZ';
const BSECRET = 'p62-d83-fixture-bridge-secret-BBBB';
const dirs = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p62-d83-'))); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('CMUX_SOCKET_PASSWORD is a secret name', () => {
  const s = require(SECRETS_JS);
  assert.ok(s.isSecretName('CMUX_SOCKET_PASSWORD'));
  assert.deepEqual(s.CMUX_SCOPED, ['CMUX_SOCKET_PASSWORD']);
});

test('childEnv strips CMUX_SOCKET_PASSWORD (from process.env and from extra)', () => withEnv({ CMUX_SOCKET_PASSWORD: PW }, () => {
  const s = require(SECRETS_JS);
  assert.ok(!('CMUX_SOCKET_PASSWORD' in s.childEnv()));
  assert.ok(!('CMUX_SOCKET_PASSWORD' in s.childEnv({ CMUX_SOCKET_PASSWORD: 'x', OK: '1' })));
  assert.equal(s.childEnv({ OK: '1' }).OK, '1');
}));

test('cmuxChildEnv keeps CMUX_SOCKET_PASSWORD from process.env, still strips other secrets', () => withEnv(
  { CMUX_SOCKET_PASSWORD: PW, SERVER_TOKEN: 'p62-d83-tok', BRIDGE_SECRET: 'p62-d83-bs' }, () => {
    const s = require(SECRETS_JS);
    const e = s.cmuxChildEnv({ CMUX_QUIET: '1' });
    assert.equal(e.CMUX_SOCKET_PASSWORD, PW);
    assert.equal(e.CMUX_QUIET, '1');
    assert.ok(!('SERVER_TOKEN' in e) && !('BRIDGE_SECRET' in e));
    assert.equal(e.PATH, process.env.PATH);
  }));

test('cmuxChildEnv: unset -> absent; extra cannot inject a value', () => withEnv({ CMUX_SOCKET_PASSWORD: undefined }, () => {
  const s = require(SECRETS_JS);
  assert.ok(!('CMUX_SOCKET_PASSWORD' in s.cmuxChildEnv()));
  assert.ok(!('CMUX_SOCKET_PASSWORD' in s.cmuxChildEnv({ CMUX_SOCKET_PASSWORD: 'injected' })));
}));

test('stdin mode: scrub removes it from process.env, cmuxChildEnv still has it, childEnv does not', () => {
  const code = `
    const s = require(${JSON.stringify(SECRETS_JS)});
    s.loadSecrets({ require: ['BRIDGE_SECRET'] }).then(() => {
      console.log(JSON.stringify({ inEnv: 'CMUX_SOCKET_PASSWORD' in process.env,
        child: 'CMUX_SOCKET_PASSWORD' in s.childEnv(),
        cmux: s.cmuxChildEnv().CMUX_SOCKET_PASSWORD === ${JSON.stringify(PW)} }));
    });`;
  const r = spawnSync(process.execPath, ['-e', code], {
    input: JSON.stringify({ BRIDGE_SECRET: BSECRET }) + '\n',
    env: { PATH: process.env.PATH, HOME: tmp(), HYPERMUX_SECRETS_ON_STDIN: '1', CMUX_SOCKET_PASSWORD: PW },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { inEnv: false, child: false, cmux: true });
});

// ---- real bridge -> stub cmux CLI: the password arrives (both modes) ----
function get(base, p, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers: headers || {} }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }).on('error', reject);
  });
}
function envDumpCmux() {
  const d = tmp();
  const file = path.join(d, 'cmux');
  const dump = path.join(d, 'env.dump');
  fs.writeFileSync(file, `#!/bin/sh\nenv >> "${dump}"\necho '{}'\n`, { mode: 0o755 });
  return { file, dump };
}
async function waitForFile(f, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fs.existsSync(f) && fs.statSync(f).size > 0) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`no ${f}`);
}
for (const mode of ['stdin', 'env']) {
  test(`bridge -> cmux CLI child gets CMUX_SOCKET_PASSWORD (${mode} mode), and no other secret`, async () => {
    const cmux = envDumpCmux();
    const base = { CMUX_BIN: cmux.file, CMUX_SOCKET_PASSWORD: PW };
    const b = mode === 'stdin'
      ? await bootBridge({ env: { ...base, HYPERMUX_SECRETS_ON_STDIN: '1' }, stdin: JSON.stringify({ BRIDGE_SECRET: BSECRET }) + '\n' })
      : await bootBridge({ env: { ...base, BRIDGE_SECRET: BSECRET } });
    try {
      await get(b.base, '/cmux/tree', { 'x-bridge-secret': BSECRET });
      await waitForFile(cmux.dump);
      const dump = fs.readFileSync(cmux.dump, 'utf8');
      assert.match(dump, /CMUX_QUIET=1/, 'stub really ran as the bridge child');
      assert.ok(dump.includes(`CMUX_SOCKET_PASSWORD=${PW}`), 'cmux CLI child must get the socket password');
      assert.ok(!dump.includes(BSECRET), 'bridge secret leaked to cmux child');
      assert.ok(!(b.stdout() + b.stderr()).includes(PW), 'password value logged');
    } finally { await b.stop(); }
  });
}

// ---- source scan: cmuxChildEnv/CMUX_ENV only at cmux CLI spawns; every cmux CLI spawn uses one ----
test('source scan: cmux CLI spawns use cmuxChildEnv, nothing else does', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'test', '.git', 'vendor', '.superpowers', '.claude'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(REPO);
  const CMUX_SPAWN = /\b(execFile|spawn|execFileSync|spawnSync)\(\s*CMUX_BIN\b/;
  const bad = [];
  const cmuxSpawns = [];
  for (const f of files) {
    if (f === SECRETS_JS) continue;
    const rel = path.relative(REPO, f);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const at = `${rel}:${i + 1}`;
      const code = line.replace(/\/\/.*$/, '');
      if (CMUX_SPAWN.test(code)) {
        cmuxSpawns.push(at);
        const win = lines.slice(i, i + 3).join('\n');
        if (!/cmuxChildEnv\(|env:\s*CMUX_ENV\b/.test(win)) bad.push(`${at} cmux spawn without cmuxChildEnv`);
      }
      if (/\bCMUX_SOCKET_PASSWORD\b/.test(code)) bad.push(`${at} names CMUX_SOCKET_PASSWORD outside secrets-stdin`);
      if (/cmuxChildEnv\(/.test(code)) {
        const ok = /^const CMUX_ENV = secretsIn\.cmuxChildEnv\(/.test(code.trim()) || CMUX_SPAWN.test(code);
        if (!ok) bad.push(`${at} cmuxChildEnv used outside a cmux CLI spawn`);
      }
      if (/\bCMUX_ENV\b/.test(code) && !/^const CMUX_ENV = /.test(code.trim()) && !CMUX_SPAWN.test(code)) {
        bad.push(`${at} CMUX_ENV used outside a cmux CLI spawn`);
      }
    });
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(cmuxSpawns.sort(), ['bridge.js:107', 'scripts/capture-grid.js:34'].sort(), 'cmux CLI spawn set changed: review D83 scoping');
});
