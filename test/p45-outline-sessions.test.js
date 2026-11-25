'use strict';
// p45 S2 — taskName / spawnedBy / continues on GET /cmux/sessions rows (D16 deadline, single flight).
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');
const { writeFakeCmux, IDS } = require('./helpers/fake-cmux');
const { call } = require('./helpers/unix-call');
const { createSessionRoutes, LIMITS } = require('../sessions/routes.js');
const { createTasks } = require('../lib/tasks.js');

const SECRET = 'p45-secret';
const MACHINE = 'mac-a';
const dirs = [];
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p45-')));
  fs.chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) { try { fs.chmodSync(path.join(d, 'x-worker-1.md'), 0o600); } catch (_) {} fs.rmSync(d, { recursive: true, force: true }); } });
const task = (dir, name, fm) => fs.writeFileSync(path.join(dir, `${name}.md`), `---\nstatus: open\n${fm}\n---\nbody\n`);

async function boot(env) {
  const fake = writeFakeCmux(tmp());
  const pf = path.join(tmp(), 'procs.json');
  fs.writeFileSync(pf, JSON.stringify({ ps: '', tmuxSockets: [] }));
  return bootBridge({ cwd: tmp(), socket: path.join(tmp(), 'b.sock'), env: { CMUX_BIN: fake.file, BRIDGE_SECRET: SECRET, RADAR_MACHINE_ID: MACHINE, P41_JOIN_POLL_MS: '200', P41_PROCS_FIXTURE: pf, ...env } });
}
const list = async (b) => (await call(b.socketPath, 'GET', '/cmux/sessions', { secret: SECRET })).json.sessions;
const rename = (b, sf, name) => call(b.socketPath, 'POST', '/cmux/session-name', { secret: SECRET, body: { sessionId: `${MACHINE}:${sf}`, name } });
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('timed out');
}
const outline = (s) => ({ taskName: s.taskName, spawnedBy: s.spawnedBy, continues: s.continues });

test('real Bridge, dir set: rows carry taskName/spawnedBy/continues; unreadable file -> no fields, list still updates', async () => {
  const dir = tmp();
  task(dir, 'x-chief-1', '');
  task(dir, 'x-lead-1', 'from: x-chief-1');
  task(dir, 'x-lead-2', 'from: x-chief-1\ncontinues: x-lead-1');
  task(dir, 'x-worker-1', 'from: x-lead-1');
  const b = await boot({ HYPERMUX_TASKS_DIR: dir });
  try {
    assert.match(b.stdout(), /tasks: dir set/);
    assert.ok(!b.stdout().includes(dir), 'no path logged');
    for (const [sf, n] of [[IDS.sfA1, 'x-chief-1'], [IDS.sfA2, 'x-lead-2'], [IDS.sfB1, 'x-worker-1']]) assert.equal((await rename(b, sf, n)).status, 200);
    const by = await until(async () => {
      const ss = await list(b);
      const m = Object.fromEntries(ss.map((s) => [s.title, s]));
      return m['x-worker-1'] && m['x-worker-1'].taskName && m['x-lead-2'] && m['x-lead-2'].taskName ? m : null;
    });
    assert.deepEqual(outline(by['x-chief-1']), { taskName: 'x-chief-1', spawnedBy: undefined, continues: undefined });
    assert.deepEqual(outline(by['x-lead-2']), { taskName: 'x-lead-2', spawnedBy: 'x-chief-1', continues: 'x-lead-1' });
    assert.deepEqual(outline(by['x-worker-1']), { taskName: 'x-worker-1', spawnedBy: 'x-lead-1', continues: undefined });
    // unreadable task file (content changed, then chmod 000) + a rename: the list still updates
    task(dir, 'x-worker-1', 'from: x-lead-1\ncontinues: x-worker-0');
    fs.chmodSync(path.join(dir, 'x-worker-1.md'), 0o000);
    assert.equal((await rename(b, IDS.sfA2, 'x-lead-3')).status, 200);
    const m2 = await until(async () => {
      const m = Object.fromEntries((await list(b)).map((s) => [s.title, s]));
      return m['x-lead-3'] && m['x-worker-1'] && !m['x-worker-1'].taskName ? m : null;
    });
    assert.equal(m2['x-lead-3'].taskName, undefined, 'x-lead-3 has no task file');
    assert.equal(m2['x-chief-1'].taskName, 'x-chief-1');
  } finally { await b.stop(); }
});

test('real Bridge, dir unset: clean boot, no outline fields', async () => {
  const b = await boot({});
  try {
    assert.match(b.stdout(), /tasks: dir unset/);
    await rename(b, IDS.sfA1, 'x-chief-1');
    const ss = await until(async () => { const s = await list(b); return s.find((x) => x.title === 'x-chief-1') ? s : null; });
    for (const s of ss) assert.deepEqual(outline(s), { taskName: undefined, spawnedBy: undefined, continues: undefined });
  } finally { await b.stop(); }
});

function routes(lineage, extra = {}) {
  const tabs = ['x-chief-1', 'x-lead-1'];
  const st = { n: 0 };
  const r = createSessionRoutes({
    machineId: MACHINE, backend: 'cmux', home: tmp(), listSnapshotMs: 0, lineage, ...extra,
    loadTree: async () => { st.n++; return [{ ref: 'workspace:1', title: 'W', tabs: tabs.map((t, i) => ({ id: `surface:${i + 1}`, ref: `surface:${i + 1}`, title: `${t}`, type: 'terminal' })) }]; },
    procSnapshot: async () => ({ table: [], sessions: [] }),
  });
  const get = () => new Promise((resolve) => {
    let code = 0;
    r.handle({ method: 'GET', headers: {} }, { writeHead(c) { code = c; }, end: (b) => resolve({ code, body: JSON.parse(b) }) }, new URL('http://x/cmux/sessions'));
  });
  return { get, st };
}

test('D16: a never-settling lineage publishes within lineageMs; no second call while it is out; throw = no fields', async () => {
  assert.equal(LIMITS.lineageMs, 1500);
  let calls = 0;
  const { get } = routes(() => { calls++; return new Promise(() => {}); });
  const t0 = Date.now();
  const a = await get();
  const took = Date.now() - t0;
  assert.equal(a.code, 200);
  assert.ok(took >= LIMITS.lineageMs - 50 && took < LIMITS.lineageMs + 1000, `took ${took}`);
  assert.equal(a.body.sessions.length, 2);
  assert.ok(a.body.sessions.every((s) => s.taskName === undefined));
  const t1 = Date.now();
  const b2 = await get();
  assert.ok(Date.now() - t1 < 500, 'second build skipped enrichment');
  assert.equal(b2.code, 200);
  assert.equal(calls, 1, 'single flight');
  const thrower = routes(() => { throw new Error('boom'); });
  const c = await thrower.get();
  assert.equal(c.code, 200);
  assert.ok(c.body.sessions.every((s) => !('taskName' in s)));
  const none = routes(undefined);
  assert.deepEqual(Object.keys((await none.get()).body.sessions[0]).filter((k) => /taskName|spawnedBy|continues/.test(k)), []);
});

test('D16: a timed-out call that completes later leaves the cache unchanged, frees the slot, next build enriches', async () => {
  const dir = tmp();
  task(dir, 'x-chief-1', '');
  task(dir, 'x-lead-1', 'from: x-chief-1');
  const tasks = createTasks({ dir });
  let open;
  let gate = new Promise((r) => { open = r; });
  let settled;
  const lineage = (names, opts) => { const p = gate.then(() => tasks.lineage(names, opts)); settled = p; return p; };
  const { get } = routes(lineage, { lineageMs: 50 });
  const a = await get();
  assert.ok(a.body.sessions.every((s) => s.taskName === undefined));
  open();
  await settled;
  await new Promise((r) => setImmediate(r));
  assert.equal(tasks._lineageCache.size, 0, 'aborted call wrote nothing');
  gate = Promise.resolve();
  const b2 = await get();
  const m = Object.fromEntries(b2.body.sessions.map((s) => [s.title, s]));
  assert.deepEqual(outline(m['x-lead-1']), { taskName: 'x-lead-1', spawnedBy: 'x-chief-1', continues: undefined });
  assert.equal(m['x-chief-1'].taskName, 'x-chief-1');
  assert.equal(tasks._lineageCache.size, 2);
});
