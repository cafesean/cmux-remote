'use strict';
// D144 (HMX-59) — one pasted token stored on each picked Mac under the same name.
// Offline: a fake stateful `security` (HYPERMUX_SECURITY_BIN). FAKE token only; never a real one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer } = require('./helpers/server-boot');
const { createAccountStore, fingerprint, validToken } = require('../lib/account-store');

const FAKE_TOKEN = 'sk-ant-oat01-fake' + 'X'.repeat(40) + 'Y'.repeat(43);
const OTHER_TOKEN = 'sk-ant-oat01-fake' + 'Z'.repeat(83);

// items.json = [svc...]; `-i` reads one add line from stdin (kept in stdin.log for the test to inspect).
const FAKE_SECURITY = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs'); const path = require('path');
const D = process.env.FAKE_SEC_DIR; const args = process.argv.slice(2);
fs.appendFileSync(path.join(D, 'calls.log'), JSON.stringify(args) + '\n');
const F = path.join(D, 'items.json');
const items = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch (_) { return []; } };
const save = (a) => fs.writeFileSync(F, JSON.stringify(a));
const op = args[0];
if (op === 'show-keychain-info') process.exit(fs.existsSync(path.join(D, 'locked')) ? 36 : 0);
if (op === 'dump-keychain') {
  process.stdout.write(items().map((s) => 'class: "genp"\nattributes:\n    "svce"<blob>="' + s + '"\n').join(''), () => process.exit(0));
  return;
}
const svcOf = (a) => a[a.indexOf('-s') + 1];
if (op === 'find-generic-password') process.exit(items().includes(svcOf(args)) ? 0 : 44);
if (op === 'delete-generic-password') { save(items().filter((s) => s !== svcOf(args))); process.exit(0); }
if (op === '-i') {
  let input = ''; process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    fs.appendFileSync(path.join(D, 'stdin.log'), input);
    const m = /-s "([^"]+)"/.exec(input);
    if (m && !fs.existsSync(path.join(D, 'failadd'))) save([...items(), m[1]]);
    process.exit(0);
  });
  return;
}
process.exit(1);
`;
function secDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd144-sec-'));
  fs.writeFileSync(path.join(d, 'security'), FAKE_SECURITY, { mode: 0o755 });
  return d;
}
const calls = (d) => { try { return fs.readFileSync(path.join(d, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
const items = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'items.json'), 'utf8')); } catch (_) { return []; } };

function withMeta(file, fn) {
  const was = process.env.HYPERMUX_ACCOUNTS_FILE;
  process.env.HYPERMUX_ACCOUNTS_FILE = file;
  return Promise.resolve().then(fn).finally(() => { if (was === undefined) delete process.env.HYPERMUX_ACCOUNTS_FILE; else process.env.HYPERMUX_ACCOUNTS_FILE = was; });
}

// ---------------------------------------------------------------- unit: lib/account-store.js
test('validToken: shape rule (sk-ant-, url-safe, >= 90)', () => {
  assert.equal(validToken(FAKE_TOKEN), true);
  assert.equal(validToken('sk-ant-short'), false);
  assert.equal(validToken(FAKE_TOKEN + ' '), false);
  assert.equal(validToken(FAKE_TOKEN.replace('sk-ant-', 'sk-xyz-')), false);
  assert.equal(validToken(42), false);
});

test('store: token goes to `security -i` on stdin, never argv; fp in meta; same token again = exists_same', async () => {
  const d = secDir(); const metaFile = path.join(d, 'accounts.json');
  await withMeta(metaFile, async () => {
    const s = createAccountStore({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, user: 'tester' });
    const r = await s.store('mux1', FAKE_TOKEN);
    assert.deepEqual(r, { result: 'stored', fp: fingerprint(FAKE_TOKEN) });
    assert.deepEqual(items(d), ['cos-claude-account-mux1']);
    for (const a of calls(d)) assert.ok(!a.join(' ').includes('sk-ant-'), 'token never in argv');
    assert.ok(fs.readFileSync(path.join(d, 'stdin.log'), 'utf8').includes(FAKE_TOKEN), 'token reached stdin');
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(m.mux1.fp, fingerprint(FAKE_TOKEN));
    assert.ok(!fs.readFileSync(metaFile, 'utf8').includes('sk-ant-'), 'meta never holds the token');
    assert.deepEqual(await s.store('mux1', FAKE_TOKEN), { result: 'exists_same', fp: fingerprint(FAKE_TOKEN) });
    assert.equal(calls(d).filter((a) => a[0] === '-i').length, 1, 'exists_same writes nothing');
  });
});

test('store: different token under an existing name -> exists_different (existing fp), replace overwrites', async () => {
  const d = secDir(); const metaFile = path.join(d, 'accounts.json');
  await withMeta(metaFile, async () => {
    const s = createAccountStore({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, user: 'tester' });
    await s.store('mux1', FAKE_TOKEN);
    assert.deepEqual(await s.store('mux1', OTHER_TOKEN), { error: 'exists_different', fp: fingerprint(FAKE_TOKEN) });
    assert.deepEqual(await s.store('mux1', OTHER_TOKEN, { replace: true }), { result: 'replaced', fp: fingerprint(OTHER_TOKEN) });
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).mux1.fp, fingerprint(OTHER_TOKEN));
    assert.ok(calls(d).some((a) => a[0] === 'delete-generic-password'));
    // an item with no recorded fp (added by setup-token before fps) counts as different
    fs.writeFileSync(path.join(d, 'items.json'), JSON.stringify([...items(d), 'cos-claude-account-old']));
    assert.deepEqual(await s.store('old', FAKE_TOKEN), { error: 'exists_different', fp: null });
  });
});

test('store: a silent `security -i` failure is caught by the read-back', async () => {
  const d = secDir(); fs.writeFileSync(path.join(d, 'failadd'), '');
  await withMeta(path.join(d, 'accounts.json'), async () => {
    const s = createAccountStore({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, user: 'tester' });
    assert.deepEqual(await s.store('mux1', FAKE_TOKEN), { error: 'keychain_write_failed' });
    assert.ok(!fs.existsSync(path.join(d, 'accounts.json')), 'no meta for a failed store');
  });
});

// ---------------------------------------------------------------- bridge route
const SECRET = 'd144-secret';
let br, dir, sec;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd144-bridge-')));
  sec = secDir();
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  br = await bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_ACCOUNTS_FILE: path.join(dir, 'accounts.json'), HYPERMUX_PRIVATE_FILE: path.join(dir, 'private.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (br) await br.stop(); });

const replies = [];
async function call(p, body, secret = SECRET) {
  const r = await fetch(br.base + p, { method: 'POST', headers: { 'x-bridge-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text(); replies.push(text);
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

test('bridge: POST /cmux/accounts/store stores / exists_same / exists_different / replace', async () => {
  let r = await call('/cmux/accounts/store', { name: 'mux1', token: FAKE_TOKEN });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, result: 'stored', fp: fingerprint(FAKE_TOKEN) });
  r = await call('/cmux/accounts/store', { name: 'mux1', token: FAKE_TOKEN });
  assert.equal(r.json.result, 'exists_same');
  r = await call('/cmux/accounts/store', { name: 'mux1', token: OTHER_TOKEN });
  assert.equal(r.status, 409); assert.deepEqual(r.json, { error: 'exists_different', fp: fingerprint(FAKE_TOKEN) });
  r = await call('/cmux/accounts/store', { name: 'mux1', token: OTHER_TOKEN, replace: true });
  assert.equal(r.json.result, 'replaced');
  // the list sees it straight away (cache invalidated)
  const l = await fetch(br.base + '/cmux/accounts', { headers: { 'x-bridge-secret': SECRET } }).then((x) => x.json());
  assert.deepEqual(l.accounts.map((a) => a.name), ['mux1']);
});

test('bridge: store refuses bad input, wrong secret, locked Keychain; token never echoed or logged', async () => {
  assert.equal((await call('/cmux/accounts/store', { name: 'BAD', token: FAKE_TOKEN })).status, 400);
  assert.equal((await call('/cmux/accounts/store', { name: 'a', token: FAKE_TOKEN })).status, 400);
  assert.deepEqual((await call('/cmux/accounts/store', { name: 'nn', token: 'sk-ant-nope' })).json, { error: 'bad_token' });
  assert.equal((await call('/cmux/accounts/store', { name: 'nn', token: FAKE_TOKEN, replace: 'yes' })).status, 400);
  assert.equal((await call('/cmux/accounts/store', { name: 'nn', token: FAKE_TOKEN }, 'wrong')).status, 403);
  fs.writeFileSync(path.join(sec, 'locked'), '');
  try {
    const r = await call('/cmux/accounts/store', { name: 'nn', token: FAKE_TOKEN });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'keychain_locked');
  } finally { fs.unlinkSync(path.join(sec, 'locked')); }
  for (const t of replies) assert.ok(!t.includes('sk-ant-'), 'no reply carries the token');
  assert.ok(!br.stdout().includes('sk-ant-') && !br.stderr().includes('sk-ant-'), 'bridge logs never carry the token');
  for (const a of calls(sec)) assert.ok(!a.join(' ').includes('sk-ant-'), 'token never in argv');
});

// ---------------------------------------------------------------- server relay
function fakeBridge() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'stored', fp: 'abcdef012345' }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}

test('server: /api/cmux/accounts/store relays only over TLS (tunnel x-forwarded-proto) to a secure bridge hop', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([
    { id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' },
    { id: 'm2', label: 'M2', baseUrl: 'http://10.255.255.1:8799', secret: 'sb' },
  ]) } });
  const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  const body = JSON.stringify({ name: 'mux1', token: FAKE_TOKEN });
  try {
    let r = await fetch(s.base + '/api/cmux/accounts/store?machine=m1', { method: 'POST', headers: H, body });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'tls_required' });
    assert.equal(fb.seen.length, 0, 'plain http never forwards the token');
    r = await fetch(s.base + '/api/cmux/accounts/store?machine=m1', { method: 'POST', headers: { ...H, 'x-forwarded-proto': 'https' }, body });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, result: 'stored', fp: 'abcdef012345' });
    assert.equal(fb.seen[0].url, '/cmux/accounts/store');
    assert.equal(JSON.parse(fb.seen[0].body).token, FAKE_TOKEN);
    r = await fetch(s.base + '/api/cmux/accounts/store?machine=m2', { method: 'POST', headers: { ...H, 'x-forwarded-proto': 'https' }, body });
    assert.equal(r.status, 403, 'plain-http remote bridge hop refused');
    r = await fetch(s.base + '/api/cmux/accounts/store?machine=m1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body });
    assert.equal(r.status, 401);
    assert.ok(!s.stdout().includes('sk-ant-') && !s.stderr().includes('sk-ant-'), 'server logs never carry the token');
  } finally { await s.stop(); await fb.close(); }
});
