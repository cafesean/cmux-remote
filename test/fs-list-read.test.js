'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsBrowse } = require('../fsbrowse');

async function bigFixture(n = 450) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-list-'));
  const root = await fsp.realpath(base);
  await fsp.mkdir(path.join(root, 'zdir'));
  await fsp.mkdir(path.join(root, 'Adir'));
  for (let i = 0; i < n; i++) {
    await fsp.writeFile(path.join(root, `f${String(i).padStart(4, '0')}.txt`), 'x');
  }
  return root;
}
const mk = (root, extra) => createFsBrowse({ rootsSpec: root, workspaceCwds: async () => [], ...extra });

test('list: directories sort before files, case-insensitively', async () => {
  const root = await bigFixture(3);
  const r = await mk(root).list(root, 0, 10);
  assert.strictEqual(r.entries[0].name, 'Adir');
  assert.strictEqual(r.entries[1].name, 'zdir');
  assert.strictEqual(r.entries[0].type, 'dir');
  assert.strictEqual(r.entries[2].type, 'file');
});

test('list: total counts every entry while a page returns only its slice', async () => {
  const root = await bigFixture(450);
  const r = await mk(root).list(root, 0, 200);
  assert.strictEqual(r.total, 452);
  assert.strictEqual(r.entries.length, 200);
  assert.strictEqual(r.offset, 0);
});

test('list: paging is stable and non-overlapping across pages', async () => {
  const root = await bigFixture(450);
  const fb = mk(root);
  const p0 = await fb.list(root, 0, 200);
  const p1 = await fb.list(root, 200, 200);
  const p2 = await fb.list(root, 400, 200);
  const names = [...p0.entries, ...p1.entries, ...p2.entries].map((e) => e.name);
  assert.strictEqual(names.length, 452);
  assert.strictEqual(new Set(names).size, 452);
});

test('list: limit is clamped to pageMax and offset is clamped to total', async () => {
  const root = await bigFixture(10);
  const fb = mk(root, { pageMax: 5 });
  const r = await fb.list(root, 0, 99999);
  assert.strictEqual(r.limit, 5);
  assert.strictEqual(r.entries.length, 5);
  const past = await fb.list(root, 9999, 5);
  assert.strictEqual(past.offset, past.total);
  assert.strictEqual(past.entries.length, 0);
});

test('list: a second page does not re-readdir the unchanged directory', async () => {
  const root = await bigFixture(300);
  const fb = mk(root);
  let reads = 0;
  const realReaddir = fsp.readdir;
  fsp.readdir = (...a) => { reads++; return realReaddir(...a); };
  try {
    await fb.list(root, 0, 200);
    await fb.list(root, 200, 200);
    assert.strictEqual(reads, 1);
  } finally { fsp.readdir = realReaddir; }
});

test('list: touching the directory invalidates the cache', async () => {
  const root = await bigFixture(5);
  const fb = mk(root);
  const before = await fb.list(root, 0, 50);
  await fsp.writeFile(path.join(root, 'newfile.txt'), 'x');
  const after = await fb.list(root, 0, 50);
  assert.strictEqual(after.total, before.total + 1);
});

test('list: called on a file returns not_a_dir', async () => {
  const root = await bigFixture(1);
  await assert.rejects(
    () => mk(root).list(path.join(root, 'f0000.txt'), 0, 10),
    (e) => e.code === 'not_a_dir' && e.status === 400,
  );
});

test('list: dotfiles are included by default', async () => {
  const root = await bigFixture(2);
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=1');
  await fsp.mkdir(path.join(root, '.git'));
  const r = await mk(root).list(root, 0, 50);
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes('.env'), '.env should be listed');
  assert.ok(names.includes('.git'), '.git should be listed');
});

test('list: hidden:false drops dotfiles and shrinks total to match', async () => {
  const root = await bigFixture(2);
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=1');
  await fsp.mkdir(path.join(root, '.git'));
  const fb = mk(root);
  const shown = await fb.list(root, 0, 50, { hidden: true });
  const hiddenOff = await fb.list(root, 0, 50, { hidden: false });
  const names = hiddenOff.entries.map((e) => e.name);
  assert.ok(!names.some((n) => n.startsWith('.')), 'no dotfiles when hidden:false');
  // total must reflect the filter, or the client's "203 / 41882" footer and its paging both lie.
  assert.strictEqual(hiddenOff.total, shown.total - 2);
  assert.strictEqual(hiddenOff.entries.length, hiddenOff.total);
});

test('list: hiding does not disturb paging arithmetic', async () => {
  const root = await bigFixture(300);
  for (const d of ['.a', '.b', '.c']) await fsp.writeFile(path.join(root, d), 'x');
  const fb = mk(root);
  const p0 = await fb.list(root, 0, 200, { hidden: false });
  const p1 = await fb.list(root, 200, 200, { hidden: false });
  const all = [...p0.entries, ...p1.entries].map((e) => e.name);
  assert.strictEqual(p0.total, 302);                 // 300 files + 2 dirs, dotfiles excluded
  assert.strictEqual(all.length, 302);
  assert.strictEqual(new Set(all).size, 302);
  assert.ok(!all.some((n) => n.startsWith('.')));
});

test('list: parent is null at the filesystem root', async () => {
  const fb = createFsBrowse({ rootsSpec: '/', workspaceCwds: async () => [] });
  const r = await fb.list('/', 0, 5);
  assert.strictEqual(r.parent, null);
});

test('read: a text file returns its contents and a language hint', async () => {
  const root = await bigFixture(1);
  await fsp.writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
  const r = await mk(root).read(path.join(root, 'a.ts'));
  assert.strictEqual(r.kind, 'text');
  assert.strictEqual(r.text, 'export const x = 1;\n');
  assert.strictEqual(r.lang, 'typescript');
  assert.strictEqual(r.truncated, false);
});

test('read: a file over readMax is truncated to exactly readMax bytes', async () => {
  const root = await bigFixture(1);
  await fsp.writeFile(path.join(root, 'big.txt'), 'a'.repeat(5000));
  const r = await mk(root, { readMax: 1000 }).read(path.join(root, 'big.txt'));
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(Buffer.byteLength(r.text), 1000);
  assert.strictEqual(r.size, 5000);
});

test('read: NUL bytes classify the file as binary with no content', async () => {
  const root = await bigFixture(1);
  await fsp.writeFile(path.join(root, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]));
  const r = await mk(root).read(path.join(root, 'blob.bin'));
  assert.strictEqual(r.kind, 'binary');
  assert.strictEqual(r.text, undefined);
});

test('read: a directory returns not_a_dir', async () => {
  const root = await bigFixture(1);
  await assert.rejects(() => mk(root).read(root), (e) => e.code === 'not_a_dir');
});

// A character device is stat-able and readable but is not a regular file. Our read is bounded,
// so /dev/zero would not hang — it would return a megabyte of NULs and be mislabelled `binary`.
// The guard is what makes it `special`.
test('read: a character device returns special, not binary', async () => {
  const fb = createFsBrowse({ rootsSpec: '/dev', workspaceCwds: async () => [] });
  const r = await Promise.race([
    fb.read('/dev/zero'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG on /dev/zero')), 3000)),
  ]);
  assert.strictEqual(r.kind, 'special');
});

// THE REAL HANG GUARD. A FIFO with no writer blocks forever inside fs.open() — before any
// bounded read can help. Verified by mutation: removing the isFile() check makes this test
// hang the whole process, which in production would wedge the bridge and take the terminal
// mirror down with it.
test('read: a FIFO returns special and RETURNS', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-fifo-')));
  await new Promise((res, rej) => require('child_process')
    .execFile('/usr/bin/mkfifo', [path.join(dir, 'pipe')], (e) => (e ? rej(e) : res())));
  const fb = createFsBrowse({ rootsSpec: dir, workspaceCwds: async () => [] });
  const r = await Promise.race([
    fb.read(path.join(dir, 'pipe')),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG on FIFO')), 3000)),
  ]);
  assert.strictEqual(r.kind, 'special');
});

test('read: an unknown extension still returns text with an empty lang', async () => {
  const root = await bigFixture(1);
  await fsp.writeFile(path.join(root, 'notes.qqq'), 'plain');
  const r = await mk(root).read(path.join(root, 'notes.qqq'));
  assert.strictEqual(r.kind, 'text');
  assert.strictEqual(r.lang, '');
});
