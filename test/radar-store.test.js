'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const store = require('../radar/store');

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'radar-store-'));

test('writeJsonAtomic lands the whole file and leaves no temp behind', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'state.json');
  await store.writeJsonAtomic(f, { v: 1, hello: 'world' });
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(f, 'utf8')), { v: 1, hello: 'world' });
  const left = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(left, []);
});

test('writeJsonAtomic creates the radar directory on first use', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'nested', 'deeper', 'state.json');
  await store.writeJsonAtomic(f, { ok: true });
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(f, 'utf8')), { ok: true });
});

test('readJson distinguishes missing from corrupt, and never throws', async () => {
  const dir = await tmp();
  const missing = await store.readJson(path.join(dir, 'nope.json'), { fallback: true });
  assert.deepStrictEqual(missing, { ok: true, value: { fallback: true }, missing: true, error: null });

  const bad = path.join(dir, 'bad.json');
  await fsp.writeFile(bad, '{ not json');
  const corrupt = await store.readJson(bad, null);
  assert.strictEqual(corrupt.ok, false);
  assert.strictEqual(corrupt.missing, false);
  assert.match(corrupt.error, /parse bad\.json/);
});

test('the write queue serializes read-modify-write — 25 concurrent appends lose nothing', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'decisions.json');
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      store.updateJson(f, [], (list) => list.concat([{ id: `d${i}` }]))),
  );
  const final = JSON.parse(await fsp.readFile(f, 'utf8'));
  assert.strictEqual(final.length, 25, 'no lost update');
  assert.strictEqual(new Set(final.map((d) => d.id)).size, 25);
});

test('a rejected write does not wedge the queue for everything after it', async () => {
  const dir = await tmp();
  await assert.rejects(() => store.updateJson(path.join(dir, 'x.json'), {}, () => { throw new Error('boom'); }));
  const f = path.join(dir, 'after.json');
  await store.updateJson(f, {}, () => ({ still: 'working' }));
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(f, 'utf8')), { still: 'working' });
});

test('updateJson refuses to overwrite a corrupt file rather than silently resetting it', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'aliases.json');
  await fsp.writeFile(f, 'garbage{');
  await assert.rejects(() => store.updateJson(f, {}, () => ({ epics: {} })), /parse aliases\.json/);
  assert.strictEqual(await fsp.readFile(f, 'utf8'), 'garbage{');
});

test('a mutator returning undefined opts out and writes nothing', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'x.json');
  await store.writeJsonAtomic(f, { keep: 1 });
  await store.updateJson(f, {}, () => undefined);
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(f, 'utf8')), { keep: 1 });
});

test('publication failure leaves the previous file byte-identical (whole-file last-good)', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'state.json');
  await store.writeJsonAtomic(f, { v: 1, generation: 'first' });
  const before = await fsp.readFile(f, 'utf8');
  await fsp.chmod(dir, 0o500);                          // deny writes to the directory
  try {
    await assert.rejects(() => store.writeJsonAtomic(f, { v: 1, generation: 'second' }));
    assert.strictEqual(await fsp.readFile(f, 'utf8'), before);
  } finally {
    await fsp.chmod(dir, 0o700);
  }
});

test('drain resolves once every queued write has landed', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'q.json');
  store.updateJson(f, [], (l) => l.concat(['a']));
  store.updateJson(f, [], (l) => l.concat(['b']));
  await store.drain();
  assert.deepStrictEqual(JSON.parse(await fsp.readFile(f, 'utf8')), ['a', 'b']);
  assert.strictEqual(store.queueDepth(), 0);
});
