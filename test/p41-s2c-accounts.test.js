'use strict';
// p41 S2c — Claude accounts routes. The bridge lists account NAMES from the Keychain service list
// (never a secret), and opens the setup / remove pane in the private "Claude accounts" workspace.
// The server relays the routes with rate limits. No route ever takes or returns a token.
//
// Offline: a fake `security` (HYPERMUX_SECURITY_BIN) and a fake cmux; synthetic names only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer } = require('./helpers/server-boot');
const accounts = require('../lib/accounts');
const { createAccountLimits } = require('../lib/accounts-limits');

const FAKE_TOKEN = 'sk-ant-oat01-test' + 'X'.repeat(40) + 'Y'.repeat(40);

// ---------------------------------------------------------------- fake security
// FAKE_SEC_DIR/locked present -> show-keychain-info fails; FAKE_SEC_DIR/hang -> it never answers;
// FAKE_SEC_DIR/dump = dump-keychain output; find-generic-password succeeds when -s is in the dump.
const FAKE_SECURITY = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs'); const path = require('path');
const D = process.env.FAKE_SEC_DIR; const args = process.argv.slice(2);
fs.appendFileSync(path.join(D, 'calls.log'), JSON.stringify(args) + '\n');
const op = args[0];
if (op === 'show-keychain-info') {
  if (fs.existsSync(path.join(D, 'hang'))) { setInterval(() => {}, 60000); return; }
  process.exit(fs.existsSync(path.join(D, 'locked')) ? 36 : 0);
}
const dump = (() => { try { return fs.readFileSync(path.join(D, 'dump'), 'utf8'); } catch (_) { return ''; } })();
if (op === 'dump-keychain') { process.stdout.write(dump, () => process.exit(0)); return; }
if (op === 'find-generic-password') {
  const s = args[args.indexOf('-s') + 1];
  process.exit(dump.includes('"svce"<blob>="' + s + '"') ? 0 : 44);
}
process.exit(1);
`;
const item = (svce, acct = 'tester') => `keychain: "/fake/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="${svce}"\n`;
function secDir(dump) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2c-sec-'));
  fs.writeFileSync(path.join(d, 'security'), FAKE_SECURITY, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'dump'), dump || '');
  return d;
}
const secCalls = (d) => { try { return fs.readFileSync(path.join(d, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
const STD_DUMP = [
  item('cos-claude-account-acme'), item('cos-claude-account-mux1'), item('cos-claude-account-acme'),
  item('cos-claude-account-Bad'), item('cos-claude-account-toolongname'), item('other-service'),
  item('cos-claude-account-zz', FAKE_TOKEN),   // a secret-looking attribute must never surface
].join('');

// ---------------------------------------------------------------- unit: lib/accounts.js
test('listNames: only cos-claude-account-<valid name>, unique, sorted; dump never with -d/-w', async () => {
  const d = secDir(STD_DUMP);
  const a = accounts.createAccounts({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d } });
  assert.deepEqual(await a.listNames(), ['acme', 'mux1', 'zz']);
  for (const c of secCalls(d)) assert.ok(!c.includes('-w') && !c.includes('-d') && !c.includes('-g'), JSON.stringify(c));
});

test('list: names + addedAt from the metadata file; locked -> no dump, accounts []', async () => {
  const d = secDir(STD_DUMP);
  const meta = path.join(d, 'accounts.json');
  fs.writeFileSync(meta, JSON.stringify({ acme: { addedAt: '2026-11-01T00:00:00.000Z', fp: 'abcdefabcdef' } }), { mode: 0o600 });
  const a = accounts.createAccounts({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d } });
  const was = process.env.HYPERMUX_ACCOUNTS_FILE;
  process.env.HYPERMUX_ACCOUNTS_FILE = meta;   // lib/accounts-meta.js seam
  let r;
  try { r = await a.list({}); } finally { if (was === undefined) delete process.env.HYPERMUX_ACCOUNTS_FILE; else process.env.HYPERMUX_ACCOUNTS_FILE = was; }
  assert.deepEqual(r, { keychain: 'ok', accounts: [
    { name: 'acme', addedAt: '2026-11-01T00:00:00.000Z' }, { name: 'mux1', addedAt: null }, { name: 'zz', addedAt: null }] });
  assert.equal(JSON.stringify(r).includes('sk-ant'), false);
  const d2 = secDir(STD_DUMP); fs.writeFileSync(path.join(d2, 'locked'), '');
  const b = accounts.createAccounts({ securityBin: path.join(d2, 'security'), env: { FAKE_SEC_DIR: d2 } });
  assert.deepEqual(await b.list({}), { keychain: 'locked', accounts: [] });
  assert.equal(secCalls(d2).some((c) => c[0] === 'dump-keychain'), false);
});

test('keychainStatus: a hung show-keychain-info is "locked" at the timeout', async () => {
  const d = secDir(''); fs.writeFileSync(path.join(d, 'hang'), '');
  const a = accounts.createAccounts({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, keychainTimeoutMs: 300 });
  const t0 = Date.now();
  assert.equal(await a.keychainStatus(), 'locked');
  assert.ok(Date.now() - t0 < 2500);
});

test('list cache 60 s; fresh bypasses at most once per 3 s', async () => {
  const d = secDir(STD_DUMP);
  let t = 1000;
  const a = accounts.createAccounts({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, now: () => t });
  const dumps = () => secCalls(d).filter((c) => c[0] === 'dump-keychain').length;
  await a.list({}); assert.equal(dumps(), 1);
  t += 30000; await a.list({}); assert.equal(dumps(), 1, 'cached');
  await a.list({ fresh: true }); assert.equal(dumps(), 2, 'fresh read');
  t += 1000; await a.list({ fresh: true }); assert.equal(dumps(), 2, 'fresh throttled (3 s)');
  t += 2500; await a.list({ fresh: true }); assert.equal(dumps(), 3);
  t += 61000; await a.list({}); assert.equal(dumps(), 4, 'cache expired');
});

test('exists: find-generic-password -a <user> -s cos-claude-account-<name>, never -w', async () => {
  const d = secDir(STD_DUMP);
  const a = accounts.createAccounts({ securityBin: path.join(d, 'security'), env: { FAKE_SEC_DIR: d }, user: 'tester' });
  assert.equal(await a.exists('acme'), true);
  assert.equal(await a.exists('nope'), false);
  const f = secCalls(d).filter((c) => c[0] === 'find-generic-password');
  assert.deepEqual(f[0], ['find-generic-password', '-a', 'tester', '-s', 'cos-claude-account-acme']);
});

test('limits: 10 mutations/hour per caller, 30/hour per machine, fresh once per 3 s per caller', () => {
  let t = 0;
  const L = createAccountLimits({ now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(L.mutation('k1', 'm'), true);
  assert.equal(L.mutation('k1', 'm'), false, '11th from one caller');
  for (let i = 0; i < 20; i++) assert.equal(L.mutation('k' + (i + 2), 'm'), true);
  assert.equal(L.mutation('k99', 'm'), false, '31st on one machine');
  assert.equal(L.mutation('k99', 'other'), true, 'another machine has its own budget');
  t += 3600 * 1000 + 1;
  assert.equal(L.mutation('k1', 'm'), true, 'window slides');
  assert.equal(L.fresh('k1'), true);
  assert.equal(L.fresh('k1'), false);
  assert.equal(L.fresh('k2'), true, 'per caller');
  t += 3001; assert.equal(L.fresh('k1'), true);
});

// ---------------------------------------------------------------- bridge
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const op = args[0] || '';
const F = process.env.FAKE_CMUX_TREE;
fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const read = () => JSON.parse(fs.readFileSync(F, 'utf8'));
const write = (t) => fs.writeFileSync(F, JSON.stringify(t));
const uuid = (n) => 'cccccccc-0000-4000-8000-' + String(n).padStart(12, '0');
const D = require('path').dirname(F);
// race: an unrelated tab opens in the ordinary workspace at the same moment
function race(t) {
  if (!fs.existsSync(D + '/race')) return;
  const n = (t.seq = (t.seq || 10) + 1);
  const s = { id: uuid(n), ref: 'surface:' + n, title: 'other', type: 'terminal', selected: false, selected_in_pane: true };
  t.windows[0].workspaces[0].panes.push({ id: uuid(200 + n), ref: 'pane:' + n, index: 9, focused: false, selected_surface_id: s.id, surfaces: [s] });
}
const noadd = () => fs.existsSync(D + '/noadd');
let out = 'OK\n';
if (op === 'tree') out = fs.readFileSync(F, 'utf8');
else if (op === 'list-status') out = '';
else if (op === 'read-screen') out = 'hello\n';
else if (op === 'rpc') out = '{}';
else if (op === 'new-workspace' && noadd()) out = 'OK\n';
else if (op === 'new-workspace') {
  const t = read(); race(t); const n = (t.seq = (t.seq || 10) + 1);
  const s = { id: uuid(n), ref: 'surface:' + n, title: 'setup', type: 'terminal', selected: true, selected_in_pane: true };
  t.windows[0].workspaces.push({ id: uuid(100 + n), ref: 'workspace:' + n, title: flag('--name') || 'shell', selected: false,
    panes: [{ id: uuid(200 + n), ref: 'pane:' + n, index: 0, focused: true, selected_surface_id: s.id, surfaces: [s] }] });
  write(t); out = 'OK workspace:' + n + '\n';
} else if (op === 'new-surface' && noadd()) { out = 'OK\n';
} else if (op === 'new-surface') {
  const t = read(); race(t); const n = (t.seq = (t.seq || 10) + 1);
  const ws = t.windows[0].workspaces.find((w) => w.ref === flag('--workspace') || w.id === flag('--workspace'));
  const s = { id: uuid(n), ref: 'surface:' + n, title: 'setup', type: 'terminal', selected: true, selected_in_pane: true };
  ws.panes.push({ id: uuid(200 + n), ref: 'pane:' + n, index: ws.panes.length, focused: false, selected_surface_id: s.id, surfaces: [s] });
  write(t); out = 'OK surface:' + n + ' pane:' + n + ' ' + ws.ref + '\n';
}
process.stdout.write(out, () => process.exit(0));
`;
const BASE_TREE = () => ({ windows: [{ id: 'ffffffff-1111-4111-8111-111111111111', ref: 'window:1', workspaces: [
  { id: 'bbbbbbb1-1111-4111-8111-111111111111', ref: 'workspace:2', title: 'acme work', selected: true, panes: [
    { id: 'bbbbbbb1-2222-4222-8222-222222222221', ref: 'pane:2', index: 0, focused: true, selected_surface_id: 'bbbbbbb1-3333-4333-8333-333333333331',
      surfaces: [{ id: 'bbbbbbb1-3333-4333-8333-333333333331', ref: 'surface:2', title: 's', type: 'terminal', selected: true, selected_in_pane: true }] }] },
] }] });

const SECRET = 's2c-secret';
let br, dir, sec, treeFile, cmuxLog;
before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 's2c-bridge-')));
  sec = secDir(STD_DUMP);
  fs.writeFileSync(path.join(dir, 'fake-cmux'), FAKE_CMUX, { mode: 0o755 });
  treeFile = path.join(dir, 'tree.json'); fs.writeFileSync(treeFile, JSON.stringify(BASE_TREE()));
  cmuxLog = path.join(dir, 'cmux.log');
  fs.writeFileSync(path.join(dir, 'procs.json'), JSON.stringify({ ps: '', tmuxSockets: [] }));
  br = await bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_CMUX_TREE: treeFile, FAKE_CMUX_LOG: cmuxLog,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_ACCOUNTS_FILE: path.join(dir, 'accounts.json'), HYPERMUX_PRIVATE_FILE: path.join(dir, 'private.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
  } });
});
after(async () => { if (br) await br.stop(); });

const replies = [];
async function call(method, p, body, secret = SECRET, base) {
  const headers = { 'x-bridge-secret': secret };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch((base || br.base) + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); replies.push(text);
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}
const cmuxCalls = () => fs.readFileSync(cmuxLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const lastOf = (op) => cmuxCalls().filter((a) => a[0] === op).pop();
const closeSurface = (id) => { const t = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
  for (const w of t.windows[0].workspaces) w.panes = w.panes.filter((p) => !p.surfaces.some((s) => s.id === id));
  fs.writeFileSync(treeFile, JSON.stringify(t)); };
const BIN = () => path.join(path.dirname(require.resolve('../bridge.js')), 'bin');

test('bridge: GET /cmux/accounts lists names', async () => {
  const r = await call('GET', '/cmux/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.accounts.map((a) => a.name), ['acme', 'mux1', 'zz']);
  assert.equal(r.json.keychain, 'ok');
});

test('bridge: setup with no "Claude accounts" workspace -> new-workspace --name, exact command; surface is private', async () => {
  const r = await call('POST', '/cmux/accounts/setup', { name: 'zed', alsoOn: 'mini' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  const nw = lastOf('new-workspace');
  assert.deepEqual(nw, ['new-workspace', '--name', 'Claude accounts', '--focus', 'true', '--command',
    `'${BIN()}/hypermux-account-setup' zed --also-on 'mini'`]);
  assert.match(r.json.surface, /^cccccccc-/);
  assert.equal((await call('GET', '/cmux/screen?surface=' + r.json.surface)).status, 423);
  const mark = JSON.parse(fs.readFileSync(path.join(dir, 'private.json'), 'utf8'));
  assert.ok(mark.some((e) => e.surface === r.json.surface && e.until > Date.now() + 650000), 'mark outlives the 600 s setup timeout (660 s)');
  const t = await call('GET', '/cmux/tree');
  assert.equal(t.text.includes('Claude accounts'), false);
  // one pane at a time
  const again = await call('POST', '/cmux/accounts/setup', { name: 'zed2' });
  assert.equal(again.status, 429); assert.deepEqual(again.json, { error: 'setup_open' });
  closeSurface(r.json.surface);
});

test('D128 bridge: paste -> setup pane runs the bin with --paste (token read hidden in the pane, never in the request)', async () => {
  await new Promise((res) => setTimeout(res, 1100));   // tree caches
  const ok = await call('POST', '/cmux/accounts/setup', { name: 'acme', replace: true, paste: true });
  assert.equal(ok.status, 200, ok.text);
  const ns = lastOf('new-surface');
  assert.equal(ns[ns.length - 1], `'${BIN()}/hypermux-account-setup' acme --replace --paste`);
  closeSurface(ok.json.surface);
  const bad = await call('POST', '/cmux/accounts/setup', { name: 'acme', replace: true, paste: 'yes' });
  assert.equal(bad.status, 400); assert.deepEqual(bad.json, { error: 'bad_paste' });
});

test('bridge: existing name -> 409 exists; replace -> new-surface into the existing private workspace', async () => {
  await new Promise((res) => setTimeout(res, 1100));   // tree caches
  const r = await call('POST', '/cmux/accounts/setup', { name: 'acme' });
  assert.equal(r.status, 409); assert.deepEqual(r.json, { error: 'exists' });
  const ok = await call('POST', '/cmux/accounts/setup', { name: 'acme', replace: true });
  assert.equal(ok.status, 200, ok.text);
  const ns = lastOf('new-surface');
  const ws = ns[ns.indexOf('--workspace') + 1];
  assert.match(ws, /^workspace:/);
  assert.deepEqual(ns, ['new-surface', '--type', 'terminal', '--workspace', ws, '--focus', 'false', '--command',
    `'${BIN()}/hypermux-account-setup' acme --replace`]);
  assert.equal((await call('GET', '/cmux/screen?surface=' + ok.json.surface)).status, 423);
  // D160: the setup pane is brought to the front on the Mac (it was opened unfocused in a hidden workspace)
  assert.deepEqual(lastOf('select-workspace'), ['select-workspace', '--workspace', ws]);
  assert.equal(lastOf('focus-panel')[0], 'focus-panel');
  assert.equal(ok.json.workspace, 'Claude accounts');
  closeSurface(ok.json.surface);
});

test('bridge: bad name / label -> 400; locked -> 409; too many -> 409', async () => {
  await new Promise((res) => setTimeout(res, 1100));
  for (const name of ['a', 'Bad', '1x', 'toolong', '', 7]) {
    const r = await call('POST', '/cmux/accounts/setup', { name });
    assert.equal(r.status, 400); assert.deepEqual(r.json, { error: 'bad_name' });
  }
  const bl = await call('POST', '/cmux/accounts/setup', { name: 'ok', alsoOn: "x'; rm -rf ~" });
  assert.equal(bl.status, 400); assert.deepEqual(bl.json, { error: 'bad_label' });
  fs.writeFileSync(path.join(sec, 'locked'), '');
  try {
    const lk = await call('POST', '/cmux/accounts/setup', { name: 'ok' });
    assert.equal(lk.status, 409); assert.deepEqual(lk.json, { error: 'keychain_locked' });
  } finally { fs.unlinkSync(path.join(sec, 'locked')); }
  const many = []; for (let i = 0; i < 32; i++) many.push(item('cos-claude-account-n' + i));
  const old = fs.readFileSync(path.join(sec, 'dump'), 'utf8');
  fs.writeFileSync(path.join(sec, 'dump'), many.join(''));
  try {
    const tm = await call('POST', '/cmux/accounts/setup', { name: 'ok' });
    assert.equal(tm.status, 409); assert.deepEqual(tm.json, { error: 'too_many' });
  } finally { fs.writeFileSync(path.join(sec, 'dump'), old); }
});

test('bridge: DELETE not_found -> 404; happy -> remove pane, private', async () => {
  const nf = await call('DELETE', '/cmux/accounts/nope');
  assert.equal(nf.status, 404); assert.deepEqual(nf.json, { error: 'not_found' });
  assert.equal((await call('DELETE', '/cmux/accounts/BAD')).status, 400);
  const ok = await call('DELETE', '/cmux/accounts/mux1');
  assert.equal(ok.status, 200, ok.text);
  const cmd = lastOf('new-surface');
  assert.equal(cmd[cmd.length - 1], `'${BIN()}/hypermux-account-remove' mux1`);
  assert.equal((await call('GET', '/cmux/screen?surface=' + ok.json.surface)).status, 423);
  closeSurface(ok.json.surface);
});

test('bridge: wrong secret 403; no account reply ever carries a token', async () => {
  assert.equal((await call('GET', '/cmux/accounts', undefined, 'wrong')).status, 403);
  for (const t of replies) assert.equal(t.includes('sk-ant'), false, t);
});

test('bridge: empty BRIDGE_SECRET -> account routes 503 not_secured', async () => {
  const b2 = await bootBridge({ env: { CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_CMUX_TREE: treeFile, FAKE_CMUX_LOG: cmuxLog,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec } });
  try {
    for (const [m, p, b] of [['GET', '/cmux/accounts'], ['POST', '/cmux/accounts/setup', { name: 'ok' }], ['DELETE', '/cmux/accounts/acme']]) {
      const r = await call(m, p, b, '', b2.base);
      assert.equal(r.status, 503, p); assert.deepEqual(r.json, { error: 'not_secured' });
    }
  } finally { await b2.stop(); }
});

test('bridge: a concurrent unrelated new tab is never taken for the account pane', async () => {
  await new Promise((res) => setTimeout(res, 1100));
  fs.writeFileSync(path.join(dir, 'race'), '');
  let ok;
  try { ok = await call('POST', '/cmux/accounts/setup', { name: 'qq' }); } finally { fs.unlinkSync(path.join(dir, 'race')); }
  assert.equal(ok.status, 200, ok.text);
  const t = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
  const priv = t.windows[0].workspaces.find((w) => w.title === 'Claude accounts');
  const inPriv = priv.panes.flatMap((p) => p.surfaces.map((x) => x.id));
  assert.ok(inPriv.includes(ok.json.surface), 'reply names the tab inside "Claude accounts"');
  const other = t.windows[0].workspaces[0].panes.flatMap((p) => p.surfaces).find((x) => x.title === 'other');
  const mark = JSON.parse(fs.readFileSync(path.join(dir, 'private.json'), 'utf8'));
  assert.equal(mark.some((e) => e.surface === other.id), false, 'the unrelated tab is not marked');
  assert.equal((await call('GET', '/cmux/screen?surface=' + other.id)).status, 200, 'and stays readable');
  // the guard tracks the RIGHT tab: closing the unrelated one does not free it
  closeSurface(other.id);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await call('POST', '/cmux/accounts/setup', { name: 'qq2' })).status, 429);
  closeSurface(ok.json.surface);
});

test('bridge: pane opened but not found in the tree -> 502, and the guard is NOT held for 600 s', async () => {
  fs.writeFileSync(path.join(dir, 'noadd'), '');
  try {
    const r = await call('POST', '/cmux/accounts/setup', { name: 'nn' });
    assert.equal(r.status, 502); assert.deepEqual(r.json, { error: 'cmux_failed' });
  } finally { fs.unlinkSync(path.join(dir, 'noadd')); }
  const r2 = await call('POST', '/cmux/accounts/setup', { name: 'nn' });
  assert.equal(r2.status, 200, r2.text);
  closeSurface(r2.json.surface);
});

// ---------------------------------------------------------------- server relay
function fakeBridge() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, secret: req.headers['x-bridge-secret'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accounts: [], keychain: 'ok', surface: 'surface:9' }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((c) => srv.close(c)) })));
}

test('server: relays the account routes (machine from query), rate limits, fresh throttle', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' }]) } });
  const H = { authorization: 'Bearer tok' };
  try {
    let r = await fetch(s.base + '/api/cmux/accounts?machine=m1&fresh=1', { headers: H });
    assert.equal(r.status, 200);
    assert.equal(fb.seen.pop().url, '/cmux/accounts?fresh=1');
    r = await fetch(s.base + '/api/cmux/accounts?machine=m1&fresh=1', { headers: H });
    assert.equal(fb.seen.pop().url, '/cmux/accounts', 'second fresh within 3 s is served without fresh');
    r = await fetch(s.base + '/api/cmux/accounts/setup?machine=m1', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'acme', replace: true }) });
    assert.equal(r.status, 200);
    const sv = fb.seen.pop();
    assert.equal(sv.method, 'POST'); assert.equal(sv.url, '/cmux/accounts/setup');
    assert.deepEqual(JSON.parse(sv.body), { name: 'acme', replace: true }); assert.equal(sv.secret, 'sb');
    r = await fetch(s.base + '/api/cmux/accounts/setup?machine=m1', { method: 'POST', headers: H, body: 'x'.repeat(2000) });
    assert.equal(r.status, 413);
    r = await fetch(s.base + '/api/cmux/accounts/acme?machine=m1', { method: 'DELETE', headers: H });
    assert.equal(r.status, 200);
    assert.deepEqual([fb.seen[fb.seen.length - 1].method, fb.seen[fb.seen.length - 1].url], ['DELETE', '/cmux/accounts/acme']);
    r = await fetch(s.base + '/api/cmux/accounts/BAD?machine=m1', { method: 'DELETE', headers: H });
    assert.equal(r.status, 400);
    let last;
    for (let i = 0; i < 10; i++) last = await fetch(s.base + '/api/cmux/accounts/acme?machine=m1', { method: 'DELETE', headers: H });
    assert.equal(last.status, 429);
    assert.deepEqual(await last.json(), { error: 'rate_limited' });
  } finally { await s.stop(); await fb.close(); }
});

test('server: empty SERVER_TOKEN -> account routes 503 not_secured', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: '', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' }]) } });
  try {
    for (const [m, p] of [['GET', '/api/cmux/accounts?machine=m1'], ['POST', '/api/cmux/accounts/setup?machine=m1'], ['DELETE', '/api/cmux/accounts/acme?machine=m1']]) {
      const r = await fetch(s.base + p, { method: m, body: m === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 503, p); assert.deepEqual(await r.json(), { error: 'not_secured' });
    }
    assert.equal(fb.seen.length, 0);
  } finally { await s.stop(); await fb.close(); }
});

test('server: the per-caller key is the credential that AUTHENTICATED (junk bearer + valid x-app-token cannot reset it)', async () => {
  const fb = await fakeBridge();
  const s = await bootServer({ env: { SERVER_TOKEN: 'tok', CMUX_MACHINES: JSON.stringify([{ id: 'm1', label: 'M1', baseUrl: fb.url, secret: 'sb' }]) } });
  const H = () => ({ 'x-app-token': 'tok', authorization: 'Bearer junk-' + Math.random().toString(36).slice(2) });
  try {
    let last;
    for (let i = 0; i < 11; i++) last = await fetch(s.base + '/api/cmux/accounts/acme?machine=m1', { method: 'DELETE', headers: H() });
    assert.equal(last.status, 429, '11th from one authenticated credential is limited');
    await fetch(s.base + '/api/cmux/accounts?machine=m1&fresh=1', { headers: H() });
    assert.equal(fb.seen.pop().url, '/cmux/accounts?fresh=1');
    await fetch(s.base + '/api/cmux/accounts?machine=m1&fresh=1', { headers: H() });
    assert.equal(fb.seen.pop().url, '/cmux/accounts', 'fresh throttle holds across junk bearers');
  } finally { await s.stop(); await fb.close(); }
});

// ---- live bug 2026-11-05: releases live under "~/Library/Application Support/…" (a space) ----------
async function bridgeWithBin(binDir) {
  return bootBridge({ cwd: dir, env: {
    BRIDGE_SECRET: SECRET, CMUX_BIN: path.join(dir, 'fake-cmux'), FAKE_CMUX_TREE: treeFile, FAKE_CMUX_LOG: cmuxLog,
    HYPERMUX_SECURITY_BIN: path.join(sec, 'security'), FAKE_SEC_DIR: sec, USER: 'tester',
    HYPERMUX_ACCOUNTS_FILE: path.join(dir, 'accounts.json'), HYPERMUX_PRIVATE_FILE: path.join(dir, 'private-b.json'),
    P41_PROCS_FIXTURE: path.join(dir, 'procs.json'), NODE_ENV: 'test', COMPLETIONS_ENABLED: '0',
    HYPERMUX_BIN_DIR: binDir,
  } });
}

test('bridge: bin dir with a space (Application Support) -> list works, setup command quotes the path', async () => {
  const bin = path.join(dir, 'Application Support', 'cmux-remote', 'releases', 'abc', 'bin');
  const b3 = await bridgeWithBin(bin);
  try {
    await new Promise((res) => setTimeout(res, 1100));
    const l = await call('GET', '/cmux/accounts', undefined, SECRET, b3.base);
    assert.equal(l.status, 200, l.text);
    const r = await call('POST', '/cmux/accounts/setup', { name: 'spc', alsoOn: 'mini 2' }, SECRET, b3.base);
    assert.equal(r.status, 200, r.text);
    const cmd = cmuxCalls().filter((a) => a[0] === 'new-workspace' || a[0] === 'new-surface').pop();
    assert.equal(cmd[cmd.length - 1], `'${bin}/hypermux-account-setup' spc --also-on 'mini 2'`);
  } finally { await b3.stop(); }
});

test('bridge: bin dir with a quote char -> list still 200, setup/delete refused 503 accounts_disabled', async () => {
  const bin = path.join(dir, "it's", 'bin');
  const b4 = await bridgeWithBin(bin);
  try {
    assert.equal((await call('GET', '/cmux/accounts', undefined, SECRET, b4.base)).status, 200);
    const s = await call('POST', '/cmux/accounts/setup', { name: 'qq' }, SECRET, b4.base);
    assert.equal(s.status, 503); assert.deepEqual(s.json, { error: 'accounts_disabled' });
    const d = await call('DELETE', '/cmux/accounts/acme', undefined, SECRET, b4.base);
    assert.equal(d.status, 503); assert.deepEqual(d.json, { error: 'accounts_disabled' });
  } finally { await b4.stop(); }
});

test('S2 final I1: the one-pane guard lasts as long as the private mark (660 s), not 600 s', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  assert.match(src, /const ACCOUNT_MARK_TTL_MS = 660000;/);
  assert.match(src, /accountPane = \{ surface: r\.surface, until: Date\.now\(\) \+ ACCOUNT_MARK_TTL_MS \}/);
  // 30 s confirm + 600 s capture + 2 s kill grace + 5 s close delay < 660 s
  assert.ok(30 + 600 + 2 + 5 < 660);
});
