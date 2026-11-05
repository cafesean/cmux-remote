'use strict';
// p62 S2: secrets on stdin (HYPERMUX_SECRETS_ON_STDIN=1) and a child env that never carries one.
// REAL server.js / bridge.js children on port 0 with a scratch cwd/HOME; a stub cmux that dumps
// its env proves what children inherit. Fixture secrets only; nothing touches :8080/:8799.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { bootServer, SERVER_JS } = require('./helpers/server-boot');
const { bootBridge } = require('./helpers/bridge-child');

const TOKEN = 'p62-fixture-server-token-AAAA';
const BSECRET = 'p62-fixture-bridge-secret-BBBB';
const MSECRET = 'p62-fixture-machine-secret-CCCC';
const REPO = path.join(__dirname, '..');
const dirs = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p62-sec-'))); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function get(base, p, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers: headers || {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

// stub cmux: appends its whole env to DUMP, prints nothing useful.
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

test('stdin mode: server answers 401 without token and 200-class with the stdin token', async () => {
  const s = await bootServer({ env: { HYPERMUX_SECRETS_ON_STDIN: '1' }, stdin: JSON.stringify({ SERVER_TOKEN: TOKEN }) + '\n' });
  try {
    assert.equal((await get(s.base, '/api/machines')).status, 401);
    assert.equal((await get(s.base, '/api/machines', { authorization: 'Bearer wrong' })).status, 401);
    assert.notEqual((await get(s.base, '/api/machines', { authorization: `Bearer ${TOKEN}` })).status, 401);
    assert.doesNotMatch(s.stdout() + s.stderr(), new RegExp(TOKEN));
  } finally { await s.stop(); }
});

test('stdin mode: process.env has no secret after load (and ps -E would show none)', () => {
  const code = `
    const s = require(${JSON.stringify(path.join(REPO, 'lib/secrets-stdin.js'))});
    s.loadSecrets().then((v) => {
      console.log(JSON.stringify({ got: v.SERVER_TOKEN === ${JSON.stringify(TOKEN)} && v.BRIDGE_SECRET === ${JSON.stringify(BSECRET)},
        env: ['SERVER_TOKEN','BRIDGE_SECRET','CMUX_MACHINE_SECRET','TUNNEL_TOKEN','HYPERMUX_SECRETS_ON_STDIN'].filter((k) => k in process.env),
        get: s.get('SERVER_TOKEN') === ${JSON.stringify(TOKEN)}, child: Object.keys(s.childEnv({ SERVER_TOKEN: 'x', OK: '1' })).filter((k) => /TOKEN|SECRET|^OK$/.test(k)) }));
    });`;
  const r = spawnSync(process.execPath, ['-e', code], {
    input: JSON.stringify({ SERVER_TOKEN: TOKEN, BRIDGE_SECRET: BSECRET }) + '\n',
    env: { PATH: process.env.PATH, HOME: tmp(), HYPERMUX_SECRETS_ON_STDIN: '1', SERVER_TOKEN: 'env-should-be-dropped', TUNNEL_TOKEN: 't' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.got, true);
  assert.equal(o.get, true);
  assert.deepEqual(o.env, []);
  assert.deepEqual(o.child, ['OK'], 'childEnv strips secrets even when passed in extra');
});

for (const mode of ['stdin', 'env']) {
  test(`spawned child env has no secret (${mode} mode, bridge -> cmux)`, async () => {
    const cmux = envDumpCmux();
    const base = { CMUX_BIN: cmux.file, CMUX_MACHINE_ACCESS_SECRET: 'p62-fixture-access-DDDD', BRIDGE_SECRET_MINI: 'p62-fixture-mini-EEEE' };
    const b = mode === 'stdin'
      ? await bootBridge({ env: { ...base, HYPERMUX_SECRETS_ON_STDIN: '1' }, stdin: JSON.stringify({ BRIDGE_SECRET: BSECRET }) + '\n' })
      : await bootBridge({ env: { ...base, BRIDGE_SECRET: BSECRET } });
    try {
      assert.ok([401, 403].includes((await get(b.base, '/cmux/tree')).status), 'bridge is secret-gated');
      await get(b.base, '/cmux/tree', { 'x-bridge-secret': BSECRET });
      await waitForFile(cmux.dump);
      const dump = fs.readFileSync(cmux.dump, 'utf8');
      assert.match(dump, /CMUX_QUIET=1/, 'stub really ran as the bridge child');
      for (const v of [BSECRET, 'p62-fixture-access-DDDD', 'p62-fixture-mini-EEEE']) assert.ok(!dump.includes(v), 'secret value leaked to child');
      assert.doesNotMatch(dump, /^(BRIDGE_SECRET|SERVER_TOKEN|HYPERMUX_SECRETS_ON_STDIN)=/m);
    } finally { await b.stop(); }
  });
}

test('env mode unchanged: SERVER_TOKEN from env gates the API as before', async () => {
  const s = await bootServer({ env: { SERVER_TOKEN: TOKEN } });
  try {
    assert.equal((await get(s.base, '/api/machines')).status, 401);
    assert.notEqual((await get(s.base, '/api/machines', { authorization: `Bearer ${TOKEN}` })).status, 401);
  } finally { await s.stop(); }
});

test('env mode unchanged: .env file SERVER_TOKEN still read', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, '.env'), `SERVER_TOKEN=${TOKEN}\n`);
  const s = await bootServer({ cwd });
  try {
    assert.equal((await get(s.base, '/api/machines')).status, 401);
    assert.notEqual((await get(s.base, '/api/machines', { authorization: `Bearer ${TOKEN}` })).status, 401);
  } finally { await s.stop(); }
});

function runExit(stdinText, keepOpen, script = SERVER_JS, killMs = 0) {
  return new Promise((resolve) => {
    const cwd = tmp();
    const child = spawn(process.execPath, [script], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, PORT: '0', HOST: '127.0.0.1', HYPERMUX_SECRETS_ON_STDIN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (stdinText != null) child.stdin.write(stdinText);
    if (!keepOpen) child.stdin.end();
    const t0 = Date.now();
    // killMs: a child still running then is serving (fail-open); kill it and report code null.
    const killer = killMs ? setTimeout(() => child.kill('SIGKILL'), killMs) : null;
    child.on('exit', (code) => { if (killer) clearTimeout(killer); try { child.stdin.destroy(); } catch (_) {} resolve({ code, out, ms: Date.now() - t0 }); });
  });
}

test('stdin timeout exits 78', async () => {
  const r = await runExit(null, true);
  assert.equal(r.code, 78, r.out);
  assert.ok(r.ms >= 4500, `waited ${r.ms} ms`);
  assert.doesNotMatch(r.out, /cmux-remote server on/);
});

test('stdin EOF, bad JSON, unknown key, non-string value -> exit 78, value never echoed', async () => {
  for (const line of ['', 'not json\n', '{"SERVER_TOKEN":1}\n', '["x"]\n', `{"NOPE":"${TOKEN}"}\n`]) {
    const r = await runExit(line, false);
    assert.equal(r.code, 78, `${JSON.stringify(line)}: ${r.out}`);
    assert.ok(!r.out.includes(TOKEN));
  }
});

// G1 H1: stdin mode fails CLOSED when the role's own secret is missing or blank.
const BRIDGE_JS = path.join(REPO, 'bridge.js');
for (const [role, script, key, other] of [['server', SERVER_JS, 'SERVER_TOKEN', 'BRIDGE_SECRET'], ['bridge', BRIDGE_JS, 'BRIDGE_SECRET', 'SERVER_TOKEN']]) {
  test(`${role}: stdin {} / "" / whitespace / missing ${key} -> exit 78, never serves`, async () => {
    for (const obj of [{}, { [key]: '' }, { [key]: '   \t' }, { [other]: TOKEN }]) {
      const r = await runExit(JSON.stringify(obj) + '\n', false, script, 4000);
      assert.equal(r.code, 78, `${role} ${JSON.stringify(Object.keys(obj))}: ${r.out}`);
      assert.match(r.out, new RegExp(`secrets: .*${key}`), 'stderr names the key');
      assert.ok(!r.out.includes(TOKEN), 'value never echoed');
      assert.doesNotMatch(r.out, /listening|cmux-remote server on/i);
    }
  });
}

// G1 L1: the 64 KiB cap is on total bytes, even when ONE chunk holds the newline.
test('stdin cap: one oversized chunk that contains the newline -> exit 78', () => {
  const code = `
    const { EventEmitter } = require('events');
    const s = require(${JSON.stringify(path.join(REPO, 'lib/secrets-stdin.js'))});
    const fake = new EventEmitter(); fake.pause = () => {}; fake.resume = () => {};
    s.loadSecrets({ stdin: fake, require: ['SERVER_TOKEN'], exit: (c) => { console.log('EXIT', c); process.exit(0); } })
      .then(() => console.log('LOADED'));
    fake.emit('data', Buffer.from(JSON.stringify({ SERVER_TOKEN: 'a'.repeat(70 * 1024) }) + '\\n'));`;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH, HOME: tmp(), HYPERMUX_SECRETS_ON_STDIN: '1' }, encoding: 'utf8',
  });
  assert.match(r.stdout, /EXIT 78/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /LOADED/);
});
