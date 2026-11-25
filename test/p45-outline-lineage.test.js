'use strict';
// p45 S1 — task-file lineage reader: createTasks().lineage(names, {signal}) -> Map<name, {spawnedBy?, continues?}>.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createTasks, LIMITS } = require('../lib/tasks.js');

const mkdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p45-lineage-')));
const write = (dir, name, fm, body = 'body\n') => fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fm}\n---\n${body}`);

test('present / missing / invalid / self-ref / edited / disabled / symlink-out / oversize / non-file / vanished', async () => {
  const dir = mkdir();
  const outside = mkdir();
  write(dir, 'x-worker-1', 'status: open\nfrom: x-lead-1\ncontinues: x-worker-0');
  write(dir, 'x-lead-1', 'from: x-chief-1');
  write(dir, 'x-chief-1', 'status: open');
  write(dir, 'x-bad-1', 'from: ../etc\ncontinues: Bad Name');
  write(dir, 'x-self-1', 'from: x-self-1\ncontinues: x-self-1');
  write(outside, 'x-out-1', 'from: x-chief-1');
  fs.symlinkSync(path.join(outside, 'x-out-1.md'), path.join(dir, 'x-out-1.md'));
  fs.writeFileSync(path.join(dir, 'x-big-1.md'), `---\nfrom: x-chief-1\n---\n${'x'.repeat(LIMITS.fileMaxBytes + 1)}`);
  fs.mkdirSync(path.join(dir, 'x-dir-1.md'));
  const t = createTasks({ dir });
  const m = await t.lineage(['x-worker-1', 'x-lead-1', 'x-chief-1', 'x-missing-1', 'x-bad-1', 'x-self-1', 'x-out-1', 'x-big-1', 'x-dir-1', '../x', 'Bad', 42]);
  assert.deepEqual(Object.fromEntries(m), {
    'x-worker-1': { spawnedBy: 'x-lead-1', continues: 'x-worker-0' },
    'x-lead-1': { spawnedBy: 'x-chief-1' },
    'x-chief-1': {},
    'x-bad-1': {},
    'x-self-1': {},
  });
  assert.ok(!JSON.stringify([...m]).includes(dir), 'no path in the result');

  // unchanged file is not re-read; an edited one is
  const realRead = fsp.readFile;
  let reads = 0;
  fsp.readFile = (...a) => { reads++; return realRead(...a); };
  try {
    await t.lineage(['x-lead-1']);
    assert.equal(reads, 0, 'cache hit: one stat, no read');
    write(dir, 'x-lead-1', 'from: x-chief-2');
    const m2 = await t.lineage(['x-lead-1']);
    assert.equal(reads, 1);
    assert.deepEqual(m2.get('x-lead-1'), { spawnedBy: 'x-chief-2' });
  } finally { fsp.readFile = realRead; }

  // vanished between stat and read -> no entry, cache entry evicted
  write(dir, 'x-gone-1', 'from: x-chief-1');
  assert.ok((await t.lineage(['x-gone-1'])).has('x-gone-1'));
  write(dir, 'x-gone-1', 'from: x-chief-1\ncontinues: x-gone-0');   // size changes -> re-read
  fsp.readFile = async () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; };
  try { assert.equal((await t.lineage(['x-gone-1'])).has('x-gone-1'), false); } finally { fsp.readFile = realRead; }
  assert.equal(t._lineageCache.has('x-gone-1'), false, 'evicted');

  // disabled: empty Map, no disk access
  const realRp = fsp.realpath;
  let touched = 0;
  fsp.realpath = (...a) => { touched++; return realRp(...a); };
  try {
    const off = createTasks({ dir: null });
    assert.equal(off.enabled, false);
    assert.equal((await off.lineage(['x-lead-1'])).size, 0);
    assert.equal(touched, 0);
  } finally { fsp.realpath = realRp; }
});

test('at most 8 file ops at once; cache capped at 2000', async () => {
  const dir = mkdir();
  for (let i = 0; i < 40; i++) write(dir, `x-example-${i}`, 'from: x-chief-1');
  const t = createTasks({ dir });
  const realRp = fsp.realpath;
  let cur = 0; let max = 0;
  fsp.realpath = async (...a) => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 2)); try { return await realRp(...a); } finally { cur--; } };
  try { assert.equal((await t.lineage(Array.from({ length: 40 }, (_, i) => `x-example-${i}`))).size, 40); } finally { fsp.realpath = realRp; }
  assert.ok(max <= LIMITS.lineageConcurrency && max > 1, `max concurrent ${max}`);
  assert.equal(LIMITS.lineageConcurrency, 8);
  assert.equal(LIMITS.lineageCacheMax, 2000);
  const saved = LIMITS.lineageCacheMax;
  LIMITS.lineageCacheMax = 10;
  try {
    const t2 = createTasks({ dir });
    await t2.lineage(Array.from({ length: 40 }, (_, i) => `x-example-${i}`));
    assert.equal(t2._lineageCache.size, 10);
  } finally { LIMITS.lineageCacheMax = saved; }
});

test('an aborted call never writes the cache', async () => {
  const dir = mkdir();
  write(dir, 'x-lead-1', 'from: x-chief-1');
  const t = createTasks({ dir });
  const signal = { aborted: true };
  const m = await t.lineage(['x-lead-1'], { signal });
  assert.deepEqual(m.get('x-lead-1'), { spawnedBy: 'x-chief-1' });
  assert.equal(t._lineageCache.size, 0);
});
