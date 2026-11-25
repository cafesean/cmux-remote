'use strict';
// k176 (HMX-152): lineage also carries `lead` / `lane`; a holder with no task file of its own resolves to its
// line file (`<line>.md` with `line: <line>`), lead/lane only. Example names only.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTasks, LIMITS } = require('../lib/tasks.js');
const { createSessionRoutes } = require('../sessions/routes.js');

const dirs = [];
const mkdir = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'k176-'))); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const write = (dir, name, fm) => fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\nbody\n`);

function fixture() {
  const dir = mkdir();
  write(dir, 'x-p14-owner-3', 'status: open\nfrom: x-chief-1125-5\nlane: agents/p14');
  write(dir, 'x-remix-templates-16', 'from: x-chief-1125-5\nlead: x-remix-lead');
  write(dir, 'x-agents-lead', 'line: x-agents-lead\nlane: "agents/lead"\nfrom: x-chief-1125-5\ncontinues: x-agents-lead-93');
  write(dir, 'x-plain-line', 'line: x-plain-line\nfrom: x-chief-1');   // line file with no lead/lane
  write(dir, 'x-other-line', 'line: x-not-this\nlane: agents/lead');    // line: does not name itself
  write(dir, 'x-bad-1', 'lead: ../etc\nlane: "a/b/c"');
  write(dir, 'x-self-lead-1', 'lead: x-self-lead-1\nlane: Agents/P14');
  return dir;
}

test('lead/lane from a task file; line-file holder gets lead/lane only; guards', async () => {
  const dir = fixture();
  const outside = mkdir();
  write(outside, 'x-out-lead', 'line: x-out-lead\nlane: agents/lead');
  fs.symlinkSync(path.join(outside, 'x-out-lead.md'), path.join(dir, 'x-out-lead.md'));
  const t = createTasks({ dir });
  const m = await t.lineage(['x-p14-owner-3', 'x-remix-templates-16', 'x-agents-lead-94', 'x-agents-lead', 'x-plain-line-2',
    'x-other-line-4', 'x-bad-1', 'x-self-lead-1', 'x-out-lead-7', 'x-chief-1125-6', 'x-agents-lead-94-x']);
  assert.deepEqual(Object.fromEntries(m), {
    'x-p14-owner-3': { spawnedBy: 'x-chief-1125-5', lane: 'agents/p14' },
    'x-remix-templates-16': { spawnedBy: 'x-chief-1125-5', lead: 'x-remix-lead' },
    'x-agents-lead-94': { lane: 'agents/lead', viaLine: true },   // from/continues of the line never apply
    'x-agents-lead': { lane: 'agents/lead' },                    // the line file under its own name: no from/continues
    'x-bad-1': {},
    'x-self-lead-1': { lane: 'Agents/P14' },
  });
  const s = JSON.stringify([...m]);
  assert.ok(!s.includes(dir) && !s.includes('body'), 'names only');
});

test('disabled -> empty; holder line reads respect lineageConcurrency', async () => {
  assert.equal((await createTasks({ dir: null }).lineage(['x-agents-lead-94'])).size, 0);
  const dir = mkdir();
  for (let i = 0; i < 30; i++) write(dir, `x-l${i}`, `line: x-l${i}\nlane: agents/lead`);
  const fsp = require('fs/promises');
  const realRp = fsp.realpath;
  let cur = 0; let max = 0;
  fsp.realpath = async (...a) => { cur++; max = Math.max(max, cur); try { await new Promise((r) => setTimeout(r, 2)); return await realRp(...a); } finally { cur--; } };
  let m;
  try { m = await createTasks({ dir }).lineage(Array.from({ length: 30 }, (_, i) => `x-l${i}-1`)); } finally { fsp.realpath = realRp; }
  assert.equal(m.size, 30);
  assert.ok(max <= LIMITS.lineageConcurrency * 2, `max concurrent realpath ${max}`);   // dir + file per op
});

function routes(lineage, tabs) {
  const r = createSessionRoutes({
    machineId: 'mac-a', backend: 'cmux', home: mkdir(), listSnapshotMs: 0, lineage,
    loadTree: async () => [{ ref: 'workspace:1', title: 'W', tabs: tabs.map((t, i) => ({ id: `surface:${i + 1}`, ref: `surface:${i + 1}`, title: t, type: 'terminal' })) }],
    procSnapshot: async () => ({ table: [], sessions: [] }),
  });
  return () => new Promise((resolve) => {
    r.handle({ method: 'GET', headers: {} }, { writeHead() {}, end: (b) => resolve(JSON.parse(b)) }, new URL('http://x/cmux/sessions'));
  });
}
const pick = (s) => Object.fromEntries(['taskName', 'spawnedBy', 'continues', 'lead', 'lane', 'viaLine'].filter((k) => k in s).map((k) => [k, s[k]]));

test('route: rows carry lead/lane; line holder has no taskName; no lineage = byte-identical rows', async () => {
  const dir = fixture();
  const tabs = ['x-chief-1125-6', 'x-agents-lead-94', 'x-p14-owner-3', 'x-remix-templates-16'];
  const body = await routes(createTasks({ dir }).lineage, tabs)();
  const by = Object.fromEntries(body.sessions.map((s) => [s.title, pick(s)]));
  assert.deepEqual(by, {
    'x-chief-1125-6': {},
    'x-agents-lead-94': { lane: 'agents/lead' },
    'x-p14-owner-3': { taskName: 'x-p14-owner-3', spawnedBy: 'x-chief-1125-5', lane: 'agents/p14' },
    'x-remix-templates-16': { taskName: 'x-remix-templates-16', spawnedBy: 'x-chief-1125-5', lead: 'x-remix-lead' },
  });
  // unset HYPERMUX_TASKS_DIR: bridge.js wires lineage only when tasks.enabled, so the route gets none.
  assert.equal(createTasks({ dir: null }).enabled, false);
  const a = await routes(undefined, tabs)();
  assert.ok(a.sessions.every((s) => !('lead' in s) && !('lane' in s) && !('taskName' in s)));
});
