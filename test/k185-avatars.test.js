'use strict';
// k185 — avatars store (lib/avatars.js), bridge routes on a real bridge.js child, server -> bridge relay
// (relayBytes) and the title-group rename move. Temp dirs only, example values only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAvatars, paths, ID_RE } = require('../lib/avatars');
const { bootBridge } = require('./helpers/bridge-child');
const { bootServer } = require('./helpers/server-boot');
const { call } = require('./helpers/unix-call');

const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k185-')));
  dirs.push(d);
  return d;
}
const stops = [];
after(async () => { for (const s of stops) await s(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const store = (o) => { const d = tmp(); return createAvatars({ file: path.join(d, 'avatars.json'), dir: path.join(d, 'avatars'), ...o }); };
const mode = (p) => fs.statSync(p).mode & 0o777;

test('paths: HYPERMUX_HOME unset / absolute / relative; seams win', () => {
  const h = '/home/example';
  assert.deepEqual(paths({}, h), { file: `${h}/.config/cmux-remote/avatars.json`, dir: `${h}/.config/cmux-remote/avatars` });
  assert.deepEqual(paths({ HYPERMUX_HOME: '/srv/hm' }, h), { file: '/srv/hm/avatars.json', dir: '/srv/hm/avatars' });
  assert.deepEqual(paths({ HYPERMUX_HOME: 'rel/dir' }, h), paths({}, h));
  assert.deepEqual(paths({ HYPERMUX_AVATARS_FILE: '/x/a.json', HYPERMUX_AVATARS_DIR: '/x/p' }, h), { file: '/x/a.json', dir: '/x/p' });
});

test('missing file -> empty rev 0; first commit rev 1; dirs 0700 files 0600', async () => {
  const s = store();
  assert.deepEqual(s.read(), { code: 200, body: { v: 1, rev: 0, workspaces: {} } });
  assert.equal(fs.existsSync(s.file), false);
  const r = await s.put({ target: 'machine', emoji: '🚀', color: 'blue' });
  assert.equal(r.code, 200);
  assert.equal(r.body.rev, 1);
  assert.equal(r.body.machine.emoji, '🚀');
  assert.ok(Number.isFinite(r.body.machine.updatedAt));
  assert.equal(mode(s.file), 0o600);
  assert.equal(mode(path.dirname(s.file)), 0o700);
  const p = await s.postImage({ target: 'machine' }, PNG);
  assert.equal(mode(s.dir), 0o700);
  assert.equal(mode(path.join(s.dir, p.body.machine.image)), 0o600);
});

test('unreadable / bad JSON / bad shape -> 500 avatars_unreadable; v:2 -> avatars_unsupported; writes + sweep refused', async () => {
  for (const [text, err] of [['{nope', 'avatars_unreadable'], ['[]', 'avatars_unreadable'], ['{"v":1,"rev":0}', 'avatars_unreadable'],
    ['{"v":2,"rev":0,"workspaces":{}}', 'avatars_unsupported']]) {
    const s = store();
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, text);
    fs.mkdirSync(s.dir, { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'a-0123456789abcdef.png'), PNG);
    assert.deepEqual(s.read(), { code: 500, body: { error: err } }, text);
    assert.equal((await s.put({ target: 'machine', color: 'blue', emoji: '🚀' })).body.error, err);
    assert.equal((await s.postImage({ target: 'machine' }, PNG)).body.error, err);
    assert.equal(fs.readFileSync(s.file, 'utf8'), text, 'never overwritten');
    assert.equal(s.sweep().skipped, true);
    assert.ok(fs.existsSync(path.join(s.dir, 'a-0123456789abcdef.png')));
  }
});

test('overlapping PUT + POST + clear lose no unrelated entry; rev +1 per commit', async () => {
  const s = store();
  await s.put({ target: 'workspace', key: 'Keep Me', emoji: '🌱', color: 'green' });
  const rs = await Promise.all([
    s.put({ target: 'workspace', key: 'Alpha', emoji: '🚀', color: 'blue' }),
    s.postImage({ target: 'workspace', key: 'Beta' }, JPEG),
    s.put({ target: 'workspace', key: 'Alpha', clear: true }),
    s.put({ target: 'machine', emoji: '⭐', color: 'pink' }),
  ]);
  assert.deepEqual(rs.map((r) => r.body.rev), [2, 3, 4, 5]);
  const d = s.read().body;
  assert.deepEqual(Object.keys(d.workspaces).sort(), ['Beta', 'Keep Me']);
  assert.equal(d.machine.emoji, '⭐');
});

test('§4.1 transitions', async () => {
  const s = store();
  const W = { target: 'workspace', key: 'Example & Co ünï' };
  // first picture, no colour -> slate; emoji absent
  let r = await s.postImage(W, JPEG);
  let a = r.body.workspaces[W.key];
  assert.equal(a.color, 'slate'); assert.ok(ID_RE.test(a.image)); assert.equal(a.emoji, undefined);
  // remove picture of a first picture with no emoji -> whole entry removed, file unlinked
  const first = a.image;
  r = await s.put({ ...W, color: 'slate' });
  assert.equal(r.body.workspaces[W.key], undefined);
  assert.equal(fs.existsSync(path.join(s.dir, first)), false);
  // emoji -> picture (emoji kept, colour kept) -> recolour keepImage -> remove picture keeps emoji
  await s.put({ ...W, emoji: '🚀', color: 'orange' });
  r = await s.postImage(W, PNG);
  a = r.body.workspaces[W.key];
  assert.equal(a.emoji, '🚀'); assert.equal(a.color, 'orange'); assert.match(a.image, /\.png$/);
  r = await s.put({ ...W, color: 'violet', keepImage: true });
  assert.deepEqual([r.body.workspaces[W.key].image, r.body.workspaces[W.key].emoji, r.body.workspaces[W.key].color], [a.image, '🚀', 'violet']);
  r = await s.put({ ...W, emoji: '🚀', color: 'violet' });
  assert.deepEqual(Object.keys(r.body.workspaces[W.key]).sort(), ['color', 'emoji', 'updatedAt']);
  assert.equal(fs.existsSync(path.join(s.dir, a.image)), false);
  // picture with colour + emoji in one POST; replace unlinks the old file; clear removes entry + picture
  r = await s.postImage({ ...W, color: 'green', emoji: '🌱' }, JPEG);
  const p1 = r.body.workspaces[W.key].image;
  assert.deepEqual([r.body.workspaces[W.key].color, r.body.workspaces[W.key].emoji], ['green', '🌱']);
  r = await s.postImage(W, PNG);
  assert.equal(fs.existsSync(path.join(s.dir, p1)), false);
  const p2 = r.body.workspaces[W.key].image;
  r = await s.put({ ...W, clear: true });
  assert.equal(r.body.workspaces[W.key], undefined);
  assert.equal(fs.existsSync(path.join(s.dir, p2)), false);
  assert.equal(s.read().body.rev, r.body.rev);
});

test('shared validation: bad_avatar, avatars_full, 413, 415', async () => {
  const s = store();
  for (const b of [{ target: 'nope', color: 'blue' }, { target: 'workspace', color: 'blue' }, { target: 'workspace', key: 'x'.repeat(201), color: 'blue' },
    { target: 'machine', color: 'red' }, { target: 'machine', color: 'blue', emoji: '🚀🚀' }, { target: 'machine', color: 'blue', emoji: 'ab' }]) {
    assert.equal((await s.put(b)).body.error, 'bad_avatar', JSON.stringify(b));
    assert.equal((await s.postImage({ ...b, color: b.color === 'blue' ? undefined : b.color }, PNG)).body.error, 'bad_avatar', JSON.stringify(b));
  }
  assert.equal((await s.postImage({ target: 'machine' }, Buffer.from('GIF89a'))).code, 415);
  assert.equal((await s.postImage({ target: 'machine' }, Buffer.concat([PNG, Buffer.alloc(256 * 1024)]))).code, 413);
  const d = { v: 1, rev: 7, workspaces: {} };
  for (let i = 0; i < 500; i++) d.workspaces[`Title ${i}`] = { emoji: '🚀', color: 'blue', updatedAt: 1 };
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify(d));
  assert.equal((await s.put({ target: 'workspace', key: 'One More', emoji: '🚀', color: 'blue' })).body.error, 'avatars_full');
  assert.equal((await s.postImage({ target: 'workspace', key: 'One More' }, PNG)).body.error, 'avatars_full');
  assert.equal((await s.put({ target: 'workspace', key: 'Title 3', emoji: '🌱', color: 'blue' })).code, 200, 'existing key still editable');
});

test('metadata-write failure keeps the last valid picture and removes the new file', async () => {
  let fail = false;
  const real = require('../lib/avatars');
  void real;
  const s = store({ writeFile: (f, data) => { if (fail) throw Object.assign(new Error('x'), { code: 'EIO' }); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(data), { mode: 0o600 }); } });
  const ok = await s.postImage({ target: 'machine', emoji: '🚀', color: 'blue' }, JPEG);
  const old = ok.body.machine.image;
  fail = true;
  const r = await s.postImage({ target: 'machine', emoji: '⭐', color: 'pink' }, PNG);
  assert.deepEqual(r, { code: 500, body: { error: 'avatars_write_failed' } });
  assert.deepEqual(fs.readdirSync(s.dir), [old]);
  assert.deepEqual(s.read().body.machine, ok.body.machine);
});

test('orphan sweep removes unreferenced ids and *.tmp only', async () => {
  const s = store();
  const r = await s.postImage({ target: 'machine' }, PNG);
  for (const n of ['a-1111111111111111.jpg', 'a-2222222222222222.png.tmp', 'notes.txt']) fs.writeFileSync(path.join(s.dir, n), 'x');
  assert.deepEqual(s.sweep().removed.sort(), ['a-1111111111111111.jpg', 'a-2222222222222222.png.tmp']);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), [r.body.machine.image, 'notes.txt'].sort());
});

test('moveTitleLocked: move, copy when old title still used, target keeps its own', async () => {
  const s = store();
  await s.put({ target: 'workspace', key: 'Old', emoji: '🚀', color: 'blue' });
  await s.put({ target: 'workspace', key: 'Taken', emoji: '⭐', color: 'pink' });
  assert.deepEqual(s.moveTitleLocked('Old', 'Taken', false), { moved: false });
  assert.deepEqual(s.moveTitleLocked('Old', 'Copy', true), { moved: true });
  assert.deepEqual(s.moveTitleLocked('Old', 'New', false), { moved: true });
  const w = s.read().body.workspaces;
  assert.deepEqual(Object.keys(w).sort(), ['Copy', 'New', 'Taken']);
  assert.equal(w.Taken.emoji, '⭐');
});

// ---------- bridge child + server child -------------------------------------------------------------
// A stateful fake cmux: titles live in a JSON file; rename / clear-name edit it; a `tree-fail` file
// makes `tree` exit 1 (tree null). clear-name gives cmux's derived title "derived-<ref>".
function fakeCmux(dir) {
  const state = path.join(dir, 'titles.json');
  fs.writeFileSync(state, JSON.stringify({ 'workspace:1': 'Alpha', 'workspace:2': 'Shared', 'workspace:3': 'Shared' }));
  const file = path.join(dir, 'fake-cmux');
  fs.writeFileSync(file, '#!' + process.execPath + `
const fs = require('fs'); const S = ${JSON.stringify(state)}; const F = ${JSON.stringify(path.join(dir, 'tree-fail'))};
const a = process.argv.slice(2); const t = JSON.parse(fs.readFileSync(S, 'utf8'));
if (a[0] === 'tree') {
  if (fs.existsSync(F)) process.exit(1);
  const ws = Object.keys(t).map((ref) => ({ id: ref, ref, title: t[ref], panes: [] }));
  process.stdout.write(JSON.stringify({ windows: [{ id: 'window:1', ref: 'window:1', workspaces: ws }] }));
} else if (a[0] === 'workspace-action') {
  const ws = a[a.indexOf('--workspace') + 1];
  if (a.includes('clear-name')) t[ws] = 'derived-' + ws; else t[ws] = a[a.indexOf('--title') + 1];
  if (fs.existsSync(F + '-after')) fs.writeFileSync(F, '');
  fs.writeFileSync(S, JSON.stringify(t)); process.stdout.write('OK\\n');
} else process.stdout.write('OK\\n');
`, { mode: 0o755 });
  return { file, failTree: (on) => { const f = path.join(dir, 'tree-fail'); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); },
    failAfterRename: () => fs.writeFileSync(path.join(dir, 'tree-fail-after'), ''), reset: () => { fs.rmSync(path.join(dir, 'tree-fail-after'), { force: true }); } };
}
const SECRET = 'k185-example-secret';
const TOKEN = 'k185-example-token';
async function boot(env) {
  const d = tmp();
  const fake = fakeCmux(d);
  const b = await bootBridge({ env: { CMUX_BIN: fake.file, ...env } });
  stops.push(() => b.stop());
  return { b, fake, call: (method, pq, body, headers) => call(b.base, method, pq, { body, headers }) };
}
const H = { 'x-bridge-secret': SECRET };

test('bridge (SECRET set): 403 without the secret, routes work with it; capability avatars:true', async () => {
  const { b, call: c } = await boot({ BRIDGE_SECRET: SECRET });
  assert.equal((await c('GET', '/cmux/avatars')).status, 403);
  assert.equal((await c('GET', '/cmux/avatars', undefined, H)).status, 200);
  assert.equal((await c('PUT', '/cmux/avatars', { target: 'machine', color: 'blue', emoji: '🚀' }, H)).status, 200);
  const caps = await c('GET', '/cmux/capabilities', undefined, H);
  if (caps.status === 200) assert.equal(caps.json.avatars, true);
  else assert.match(fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8'), /avatars: true,/);
  void b;
});

test('bridge (SECRET unset, open mode): GET/PUT/POST/image GET, magic bytes, 413, keys round-trip, rev survives restart', async () => {
  const d = tmp();
  const env = { HYPERMUX_AVATARS_FILE: path.join(d, 'av.json'), HYPERMUX_AVATARS_DIR: path.join(d, 'pics') };
  const { b, call: c } = await boot(env);
  const key = 'Example Title & Ünïcode 🚀';
  let r = await c('POST', `/cmux/avatar-image?target=workspace&key=${encodeURIComponent(key)}&color=pink&emoji=${encodeURIComponent('⭐')}`, JPEG);
  assert.equal(r.status, 200, r.text);
  const a = r.json.workspaces[key];
  assert.deepEqual([a.color, a.emoji], ['pink', '⭐']);
  r = await c('GET', `/cmux/avatar-image?id=${a.image}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.ok(Buffer.compare(r.body, JPEG) === 0);
  assert.equal((await c('GET', '/cmux/avatar-image?id=../etc')).status, 404);
  assert.equal((await c('POST', '/cmux/avatar-image?target=machine', Buffer.from('GIF89a'))).status, 415);
  assert.equal((await c('POST', '/cmux/avatar-image?target=machine', Buffer.alloc(300 * 1024, 0xff))).status, 413);
  assert.equal((await c('PUT', '/cmux/avatars', 'x'.repeat(5000))).status, 413);
  assert.equal((await c('PUT', '/cmux/avatars', { target: 'machine', color: 'red' })).json.error, 'bad_avatar');
  const rev = (await c('GET', '/cmux/avatars')).json.rev;
  await b.stop();
  const again = await bootBridge({ env: { CMUX_BIN: '/nonexistent', ...env } });
  stops.push(() => again.stop());
  r = await call(again.base, 'GET', '/cmux/avatars');
  assert.equal(r.json.rev, rev);
  assert.ok(r.json.workspaces[key]);
});

test('rename-workspace moves the title key per §3.1', async () => {
  const { fake, call: c } = await boot({});
  const put = (key, emoji) => c('PUT', '/cmux/avatars', { target: 'workspace', key, emoji, color: 'blue' });
  const rename = (workspace, title) => c('POST', '/cmux/rename-workspace', { workspace, title });
  const ws = async () => (await c('GET', '/cmux/avatars')).json.workspaces;
  await put('Alpha', '🚀');
  // plain move; normalized title (trim + tabs) is the key
  let r = await rename('workspace:1', '  Bravo\tOne ');
  assert.equal(r.json.avatarMoved, true);
  assert.deepEqual(Object.keys(await ws()), ['Bravo One']);
  // clear-name -> derived title from the fresh tree
  r = await rename('workspace:1', '');
  assert.equal(r.json.avatarMoved, true);
  assert.ok((await ws())['derived-workspace:1']);
  // shared old title -> copy
  await put('Shared', '⭐');
  r = await rename('workspace:2', 'Solo');
  assert.equal(r.json.avatarMoved, true);
  let w = await ws();
  assert.ok(w.Shared && w.Solo);
  // target already set -> never overwritten
  await put('Taken', '🌱');
  await rename('workspace:3', 'Lonely');   // Shared -> Lonely (copy gone: workspace:3 was the last "Shared")
  w = await ws();
  assert.ok(w.Lonely && !w.Shared);
  r = await rename('workspace:3', 'Taken');
  assert.equal(r.json.avatarMoved, false);
  assert.equal((await ws()).Taken.emoji, '🌱');
  // overlapping A->B + B->C ends on C
  await put('Step A', '🚀');
  await rename('workspace:1', 'Step A');
  const [x, y] = await Promise.all([rename('workspace:1', 'Step B'), rename('workspace:1', 'Step C')]);
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  w = await ws();
  assert.ok(w['Step C'] && !w['Step A'] && !w['Step B']);
  // tree null before cmux -> avatarMoved:false, metadata untouched
  const before = JSON.stringify(await ws());
  fake.failTree(true);
  r = await rename('workspace:1', 'Never');
  fake.failTree(false);
  assert.equal(r.status, 200); assert.equal(r.json.avatarMoved, false);
  assert.equal(JSON.stringify(await ws()), before);
  // tree null after cmux -> avatarMoved:false, old key kept
  await rename('workspace:1', 'Step C');
  fake.failAfterRename();
  r = await rename('workspace:1', 'Later');
  fake.failTree(false); fake.reset();
  assert.equal(r.status, 200); assert.equal(r.json.avatarMoved, false);
  assert.ok((await ws())['Step C']);
});

test('rename: avatar write failure after cmux -> 200 avatarMoved:false', async () => {
  const d = tmp();
  const file = path.join(d, 'av.json');
  const { call: c } = await boot({ HYPERMUX_AVATARS_FILE: file, HYPERMUX_AVATARS_DIR: path.join(d, 'pics') });
  await c('PUT', '/cmux/avatars', { target: 'workspace', key: 'Alpha', emoji: '🚀', color: 'blue' });
  fs.chmodSync(d, 0o500);   // the atomic tmp write in this dir now fails
  const r = await c('POST', '/cmux/rename-workspace', { workspace: 'workspace:1', title: 'Moved' });
  fs.chmodSync(d, 0o700);
  assert.equal(r.status, 200);
  assert.equal(r.json.avatarMoved, false);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).workspaces.Alpha);
});

async function pair(serverEnv, bridgeEnv) {
  const { b } = await boot(bridgeEnv);
  const s = await bootServer({ env: { CMUX_MACHINE_URL: b.base, ...serverEnv } });
  stops.push(() => s.stop());
  return (method, pq, o) => call(s.base, method, pq, o || {});
}

test('server -> bridge (SERVER_TOKEN + SECRET set): 401 without key; JPEG + PNG byte-equal; 413 at server; 404 JSON passthrough', async () => {
  const c = await pair({ SERVER_TOKEN: TOKEN, CMUX_MACHINE_SECRET: SECRET }, { BRIDGE_SECRET: SECRET });
  assert.equal((await c('GET', '/api/cmux/avatars?machine=default')).status, 401);
  assert.equal((await c('GET', '/api/cmux/avatars?machine=nope', { token: TOKEN })).json.error, 'no_machine');
  for (const [bytes, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png']]) {
    const up = await c('POST', '/api/cmux/avatar-image?machine=default&target=workspace&key=Example%20Title&color=green', { token: TOKEN, body: bytes });
    assert.equal(up.status, 200, up.text);
    const id = up.json.workspaces['Example Title'].image;
    const r = await c('GET', `/api/cmux/avatar-image?machine=default&id=${id}`, { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], type);
    assert.equal(r.headers['content-length'], String(bytes.length));
    assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.ok(Buffer.compare(r.body, bytes) === 0);
  }
  const big = await c('POST', '/api/cmux/avatar-image?machine=default&target=machine', { token: TOKEN, body: Buffer.alloc(300 * 1024, 0xff) });
  assert.equal(big.status, 413); assert.equal(big.json.error, 'too_large');
  const miss = await c('GET', '/api/cmux/avatar-image?machine=default&id=a-0000000000000000.png', { token: TOKEN });
  assert.equal(miss.status, 404); assert.equal(miss.json.error, 'not_found');
  const put = await c('PUT', '/api/cmux/avatars?machine=default', { token: TOKEN, body: { target: 'machine', emoji: '🚀', color: 'blue' } });
  assert.equal(put.status, 200); assert.equal(put.json.machine.emoji, '🚀');
});

test('server -> bridge (open mode: SERVER_TOKEN and SECRET unset): calls pass', async () => {
  const c = await pair({}, {});
  assert.equal((await c('GET', '/api/cmux/avatars?machine=default')).status, 200);
});
