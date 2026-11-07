'use strict';
// p41 D152 — GET /cmux/tasks + POST/PATCH /cmux/tasks/item (lib/tasks.js). Temp dir only: synthetic
// task files, a real bridge.js child for the route, no vault, no network.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createTasks, parseTask, LIMITS } = require('../lib/tasks');
const { bootBridge } = require('./helpers/bridge-child');

const SAMPLE = [
  '---',
  'name: x-demo-1',
  'status: running',
  'task_goal: "build the demo."',
  "done_means: 'Sean says finished'",
  'asks:',
  '  - id: a1',
  '    class: TEST',
  '    what: "Does it work?"',
  '    options: "works / still broken / other"',
  '  - id: a2',
  '    what: "Cap?"',
  '    options: "A yes | B no"',
  'where: "local"',
  '---',
  'Charter body.',
  '',
  '## Reports',
  'status: STARTED 2026-11-07 00:46',
  ...Array.from({ length: 9 }, (_, i) => `status: WORKING 2026-11-07 01:0${i} [C6] goal — step ${i}. jira: HMX-1 In Progress`),
  '',
].join('\n');

let dir;
before(async () => { dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'd152-'))); });
after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
const fresh = async (name, body = SAMPLE) => { await fsp.writeFile(path.join(dir, `${name}.md`), body); return name; };

test('parse: goal, done means, latest status, asks with option pills, last 8 reports', () => {
  const t = parseTask(SAMPLE);
  assert.equal(t.goal, 'build the demo.');
  assert.equal(t.doneMeans, 'Sean says finished');
  assert.deepEqual(t.status, { word: 'WORKING', text: 'step 8. jira: HMX-1 In Progress' });
  assert.deepEqual(t.asks, [
    { id: 'a1', what: 'Does it work?', options: ['works', 'still broken', 'other'] },
    { id: 'a2', what: 'Cap?', options: ['A yes', 'B no'] },
  ]);
  assert.equal(t.reports.length, LIMITS.reportsShown);
  assert.match(t.reports[7], /step 8/);
  assert.deepEqual(t.fromSean, []);
});

test('disabled without an absolute dir', async () => {
  assert.equal((await createTasks({ dir: null }).read('x')).code, 404);
  assert.deepEqual((await createTasks({ dir: null }).read('x')).body, { error: 'disabled' });
});

test('name must match ^[a-z0-9-]+$ and stay inside the dir', async () => {
  const t = createTasks({ dir });
  for (const bad of ['../etc', 'A', 'a/b', 'a.md', '', 'x'.repeat(200)]) assert.equal((await t.read(bad)).code, 400, bad);
  assert.equal((await t.read('missing')).code, 404);
  // a symlink pointing out of the dir is refused
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'd152-out-'));
  await fsp.writeFile(path.join(outside, 'secret.md'), SAMPLE);
  await fsp.symlink(path.join(outside, 'secret.md'), path.join(dir, 'link.md'));
  assert.equal((await t.read('link')).code, 400);
  await fsp.rm(outside, { recursive: true, force: true });
});

test('file read cap -> 413', async () => {
  const name = await fresh('big', SAMPLE + 'x'.repeat(LIMITS.fileMaxBytes));
  assert.equal((await createTasks({ dir }).read(name)).code, 413);
});

test('add creates ## From Sean before ## Reports; worker appends still land in Reports', async () => {
  const name = await fresh('add-1');
  const t = createTasks({ dir, now: () => new Date('2026-11-07T12:00:00.000Z') });
  const r = await t.add(name, '  check the\nbuild  ');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.item, { id: r.body.item.id, text: 'check the build', done: false, added: '2026-11-07T12:00:00.000Z' });
  const raw = fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');
  assert.ok(raw.indexOf('## From Sean\n- [ ] check the build (added 2026-11-07T12:00:00.000Z)\n') < raw.indexOf('## Reports'));
  await t.add(name, 'second');
  fs.appendFileSync(path.join(dir, `${name}.md`), 'status: DONE 2026-11-07 13:00 [C6] goal — shipped\n');
  const g = (await t.read(name)).body;
  assert.deepEqual(g.fromSean.map((x) => x.text), ['check the build', 'second']);
  assert.deepEqual(g.status, { word: 'DONE', text: 'shipped' });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);
});

test('add without ## Reports appends the section at the end', async () => {
  const name = await fresh('add-2', '---\ntask_goal: g\n---\nbody\n');
  const r = await createTasks({ dir }).add(name, 'hello');
  assert.equal(r.code, 200);
  assert.match(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'), /body\n\n## From Sean\n- \[ \] hello \(added [^)]+\)\n$/);
});

test('text caps: empty 400, > 500 chars 413', async () => {
  const name = await fresh('caps');
  const t = createTasks({ dir });
  assert.equal((await t.add(name, '   ')).code, 400);
  assert.equal((await t.add(name, 42)).code, 400);
  assert.equal((await t.add(name, 'x'.repeat(LIMITS.textMax + 1))).code, 413);
  assert.equal((await t.add(name, 'x'.repeat(LIMITS.textMax))).code, 200);
});

test('patch toggles done and edits text by id; unknown id 404', async () => {
  const name = await fresh('patch');
  const t = createTasks({ dir });
  const a = (await t.add(name, 'one')).body.item;
  await t.add(name, 'two');
  const r1 = await t.patch(name, { id: a.id, done: true });
  assert.equal(r1.code, 200);
  assert.equal(r1.body.item.id, a.id);   // id survives a tick
  assert.deepEqual(r1.body.fromSean.map((x) => [x.text, x.done]), [['one', true], ['two', false]]);
  const r2 = await t.patch(name, { id: a.id, text: 'one edited' });
  assert.equal(r2.code, 200);
  assert.deepEqual(r2.body.fromSean.map((x) => [x.text, x.done]), [['one edited', true], ['two', false]]);
  assert.equal((await t.patch(name, { id: a.id, done: false })).code, 404);   // old id is gone after the edit
  assert.equal((await t.patch(name, { id: r2.body.item.id, done: false })).code, 200);
  assert.equal((await t.patch(name, { id: 'nothex', done: true })).code, 400);
  assert.equal((await t.patch(name, { id: r2.body.item.id })).code, 400);
  // concurrent adds in one process do not lose a line
  await Promise.all(['p', 'q', 'r'].map((x) => t.add(name, x)));
  assert.equal((await t.read(name)).body.fromSean.length, 5);
});

test('bridge routes: 404 disabled without env; GET/POST/PATCH with HYPERMUX_TASKS_DIR', async () => {
  const off = await bootBridge({});
  try {
    const r = await fetch(off.base + '/cmux/tasks?name=x');
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'disabled' });
  } finally { await off.stop(); }
  const name = await fresh('route');
  const on = await bootBridge({ env: { HYPERMUX_TASKS_DIR: dir } });
  try {
    let r = await fetch(on.base + `/cmux/tasks?name=${name}`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).goal, 'build the demo.');
    assert.equal((await fetch(on.base + '/cmux/tasks?name=..%2Fx')).status, 400);
    r = await fetch(on.base + '/cmux/tasks/item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text: 'from route' }) });
    assert.equal(r.status, 200);
    const item = (await r.json()).item;
    r = await fetch(on.base + '/cmux/tasks/item', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, id: item.id, done: true }) });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).fromSean.map((x) => x.done), [true]);
  } finally { await on.stop(); }
});
