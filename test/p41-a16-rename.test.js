'use strict';
// p41 A16 — session rename: name store, title priority, POST /cmux/session-name on a real bridge child.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const { call } = require('./helpers/unix-call');
const eventlog = require('../radar/eventlog');
const { pickTitle } = require('../sessions/titles');
const { createNameStore, validateName, LIMITS } = require('../sessions/names');

const SECRET = 'a16-secret';
const MACHINE = 'mini';
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a16-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.now() - 60 * 1000;
const iso = (n) => new Date(T0 + n * 1000).toISOString();
const row = (n, type, content) => ({ type, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: iso(n), message: { role: type, content } });
function home(withTranscript) {
  const h = tmp();
  if (withTranscript) {
    const dir = path.join(h, '.claude', 'projects', '-work-alpha');
    fs.mkdirSync(dir, { recursive: true });
    const a = path.join(dir, 'sess-a.jsonl');
    fs.writeFileSync(a, [row(1, 'user', 'go'), row(2, 'assistant', [{ type: 'text', text: 'done' }])].map((r) => JSON.stringify(r)).join('\n') + '\n');
    eventlog.appendEventSync(path.join(h, '.radar'), { sessionId: 'sess-a', event: 'Stop', transcriptPath: a, surfaceId: IDS.sfA1, cwd: '/work/alpha' }, T0 + 30000);
  }
  return h;
}
async function boot(h) {
  const fake = writeFakeCmux(tmp());
  const pf = path.join(tmp(), 'procs.json');
  fs.writeFileSync(pf, JSON.stringify({ ps: '', tmuxSockets: [] }));
  return bootBridge({ cwd: h, socket: path.join(tmp(), 'b.sock'), env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, RADAR_MACHINE_ID: MACHINE, P41_JOIN_POLL_MS: '200', P41_PROCS_FIXTURE: pf } });
}
const sid = `${MACHINE}:${IDS.sfA1}`;
const post = (b, body) => call(b.socketPath, 'POST', '/cmux/session-name', { secret: SECRET, body });
const titleOf = async (b) => (await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET })).json.sessions.find((s) => s.id === sid);

test('title priority: user name beats custom-title, tmux name, workspace and tab title', () => {
  const o = { customTitle: 'From transcript', tmuxName: 'work', workspaceTitle: 'alpha', surfaceRef: 'surface:1', tabTitle: 'My tab', preferTab: true };
  assert.equal(pickTitle(o), 'From transcript');
  assert.equal(pickTitle({ ...o, userName: 'Mine' }), 'Mine');
  assert.equal(pickTitle({ ...o, userName: '   ' }), 'From transcript', 'blank name is no name');
  assert.equal(pickTitle({ ...o, userName: 'y'.repeat(500) }).length, 120, 'still clipped to titleMax');
});

test('validateName: trim, length, control chars, non-string', () => {
  assert.deepEqual(validateName('  hi  '), { name: 'hi' });
  assert.deepEqual(validateName('   '), { name: '' });
  assert.equal(validateName('x'.repeat(LIMITS.nameMax + 1)).error, 'bad_name');
  assert.equal(validateName('a\nb').error, 'bad_name');
  assert.equal(validateName('a\u0000b').error, 'bad_name');
  assert.equal(validateName(7).error, 'bad_name');
});

test('store: atomic 0600 file, cap, survives a new instance', () => {
  const h = tmp();
  const s = createNameStore({ home: h, limits: { ...LIMITS, nameEntriesMax: 2 } });
  assert.equal(s.set('k1', 'one').ok, true);
  assert.equal(s.set('k2', 'two').ok, true);
  assert.equal(s.set('k3', 'three').error, 'names_full');
  assert.equal(s.set('k2', 'two b').ok, true, 'rename of an existing key is not a new entry');
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(createNameStore({ home: h }).get('k2'), 'two b');
  s.set('k2', '');
  assert.equal(createNameStore({ home: h }).get('k2'), '');
});

test('bridge: set, list shows it, clear restores default, keyed by transcript sessionId', async () => {
  const h = home(true);
  const b = await boot(h);
  try {
    const before = await titleOf(b);
    assert.ok(before.title && !before.userNamed);
    const r = await post(b, { sessionId: sid, name: '  Ship the thing  ' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, 'Ship the thing');
    assert.equal(r.json.title, 'Ship the thing');
    const after1 = await titleOf(b);
    assert.equal(after1.title, 'Ship the thing');
    assert.equal(after1.userNamed, true);
    const file = path.join(h, '.cmux-remote', 'session-names.json');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['sess-a'], 'key = transcript sessionId');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const c = await post(b, { sessionId: sid, name: '' });
    assert.equal(c.status, 200);
    assert.equal(c.json.name, null);
    const cleared = await titleOf(b);
    assert.equal(cleared.title, before.title, 'clear restores the default title');
    assert.ok(!cleared.userNamed);
  } finally { await b.stop(); }
});

test('bridge: name persists across a bridge restart; surface-keyed without a transcript', async () => {
  const h = home(false);
  let b = await boot(h);
  try {
    assert.equal((await post(b, { sessionId: sid, name: 'Plain shell' })).status, 200);
  } finally { await b.stop(); }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(h, '.cmux-remote', 'session-names.json'), 'utf8'))), [IDS.sfA1]);
  b = await boot(h);
  try { assert.equal((await titleOf(b)).title, 'Plain shell'); } finally { await b.stop(); }
});

test('bridge: bad input is 400, unknown session 404, auth required', async () => {
  const b = await boot(home(true));
  try {
    assert.equal((await call(b.socketPath, 'POST', '/cmux/session-name', { body: { sessionId: sid, name: 'x' } })).status, 403);
    for (const body of [{}, { name: 'x' }, { sessionId: 5, name: 'x' }, { sessionId: sid }, { sessionId: sid, name: 5 },
      { sessionId: sid, name: 'a\nb' }, { sessionId: sid, name: 'x'.repeat(LIMITS.nameMax + 1) }]) {
      const r = await post(b, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((await post(b, { sessionId: `${MACHINE}:nope`, name: 'x' })).status, 404);
    assert.equal((await call(b.socketPath, 'POST', '/cmux/session-name', { secret: SECRET, body: '{bad' })).status, 400);
  } finally { await b.stop(); }
});
