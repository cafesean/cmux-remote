'use strict';
// Download is the one fs path that hands back the WHOLE original file, so its tests are about the
// three ways that can go wrong: escaping the jail, hanging on something that is not a regular file,
// and mangling the response shape (range arithmetic, header injection through a filename).
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsBrowse, parseRange, contentDisposition } = require('../fsbrowse');

async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-dl-'));
  const root = await fsp.realpath(base);
  await fsp.writeFile(path.join(root, 'notes.txt'), 'hello\n');
  await fsp.writeFile(path.join(root, 'clip.mp4'), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(root, 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  await fsp.mkdir(path.join(root, 'sub'));
  return root;
}
const mk = (root) => createFsBrowse({ rootsSpec: root, workspaceCwds: async () => [] });

test('download: returns the real path, size, and a name to save as', async () => {
  const root = await fixture();
  const r = await mk(root).download(path.join(root, 'notes.txt'));
  assert.strictEqual(r.path, path.join(root, 'notes.txt'));
  assert.strictEqual(r.name, 'notes.txt');
  assert.strictEqual(r.size, 6);
  assert.ok(r.mtime > 0);
});

// The whole point of the feature: these kinds are not viewable, so download is their only exit.
test('download: content type comes from the extension for video and archives', async () => {
  const root = await fixture();
  const fb = mk(root);
  assert.strictEqual((await fb.download(path.join(root, 'clip.mp4'))).contentType, 'video/mp4');
  assert.strictEqual((await fb.download(path.join(root, 'bundle.zip'))).contentType, 'application/zip');
});

test('download: an unknown extension falls back to octet-stream', async () => {
  const root = await fixture();
  await fsp.writeFile(path.join(root, 'thing.qqq'), 'x');
  const r = await mk(root).download(path.join(root, 'thing.qqq'));
  assert.strictEqual(r.contentType, 'application/octet-stream');
});

// download() must be behind the SAME jail as list/read — it is the only endpoint that would hand
// back a whole file, so an escape here is the most expensive one in the module.
test('download: a path outside the roots is refused', async () => {
  const root = await fixture();
  const outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-out-')));
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'nope');
  await assert.rejects(
    () => mk(root).download(path.join(outside, 'secret.txt')),
    (e) => e.code === 'outside_root' && e.status === 403,
  );
});

test('download: ../ cannot climb out of a root', async () => {
  const root = await fixture();
  await assert.rejects(
    () => mk(root).download(path.join(root, 'sub', '..', '..', '..', 'etc', 'hosts')),
    (e) => e.code === 'outside_root' || e.code === 'not_found',
  );
});

test('download: a directory is refused', async () => {
  const root = await fixture();
  await assert.rejects(() => mk(root).download(path.join(root, 'sub')),
    (e) => e.code === 'not_a_dir' && e.status === 400);
});

// SAME HANG GUARD AS read(), and the reason it belongs HERE rather than at the streaming site:
// without the isFile() check download() resolves happily, and the bridge then opens a read stream
// on a FIFO with no writer — which never returns, wedging the bridge and taking the terminal mirror
// down with it. This test is the only place that failure is cheap to catch.
test('download: a FIFO is refused and RETURNS', async () => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p4-dlfifo-')));
  await new Promise((res, rej) => require('child_process')
    .execFile('/usr/bin/mkfifo', [path.join(dir, 'pipe')], (e) => (e ? rej(e) : res())));
  const fb = createFsBrowse({ rootsSpec: dir, workspaceCwds: async () => [] });
  const r = await Promise.race([
    fb.download(path.join(dir, 'pipe')).then(() => 'RESOLVED', (e) => e.code),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG on FIFO')), 3000)),
  ]);
  assert.strictEqual(r, 'not_a_file');
});

test('download: a character device is refused', async () => {
  const fb = createFsBrowse({ rootsSpec: '/dev', workspaceCwds: async () => [] });
  const code = await Promise.race([
    fb.download('/dev/zero').then(() => 'RESOLVED', (e) => e.code),
    new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG on /dev/zero')), 3000)),
  ]);
  assert.strictEqual(code, 'not_a_file');
});

// A file over FS_READ_MAX is TRUNCATED by read() — download must not inherit that cap, or every
// large download would silently be a corrupt file.
test('download: readMax does not cap the download size', async () => {
  const root = await fixture();
  await fsp.writeFile(path.join(root, 'big.bin'), Buffer.alloc(5000, 1));
  const fb = createFsBrowse({ rootsSpec: root, workspaceCwds: async () => [], readMax: 1000 });
  assert.strictEqual((await fb.download(path.join(root, 'big.bin'))).size, 5000);
  assert.strictEqual((await fb.read(path.join(root, 'big.bin'))).truncated, true);
});

// ---- range arithmetic (resumable downloads) ---------------------------------
test('parseRange: absent or unparseable headers mean "send the whole file"', () => {
  assert.strictEqual(parseRange(undefined, 100), null);
  assert.strictEqual(parseRange('', 100), null);
  assert.strictEqual(parseRange('items=0-10', 100), null);
  assert.strictEqual(parseRange('bytes=-', 100), null);
  assert.strictEqual(parseRange('bytes=0-9,20-29', 100), null);   // multi-range: 200, per RFC 9110
});

test('parseRange: explicit, open-ended, and suffix forms', () => {
  assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=50-', 100), { start: 50, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });  // end clamps
  assert.deepStrictEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });     // suffix clamps
});

test('parseRange: unsatisfiable ranges are 416, not a silent full body', () => {
  assert.strictEqual(parseRange('bytes=100-', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=9-5', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=0-0', 0), 'invalid');      // empty file satisfies nothing
});

// ---- Content-Disposition ----------------------------------------------------
// Filenames come off a real disk, so they are attacker-shaped input the moment any directory the
// user can browse is writable by anything else.
test('contentDisposition: CR/LF and quotes cannot break out of the header', () => {
  const h = contentDisposition('a"b\r\nX-Evil: 1\\c;d.txt');
  assert.ok(!/[\r\n]/.test(h), 'no CR/LF may survive');
  assert.strictEqual(h.split('"').length, 3, 'exactly one quoted filename');
  assert.ok(h.startsWith('attachment; filename="'));
});

test('contentDisposition: non-ASCII names get an ASCII fallback plus RFC 5987 utf-8', () => {
  const h = contentDisposition('résumé 日本.pdf');
  const ascii = /filename="([^"]*)"/.exec(h)[1];
  assert.ok(/^[\x20-\x7e]+$/.test(ascii), 'fallback must be pure ASCII');
  assert.ok(h.includes("filename*=UTF-8''"));
  assert.ok(!/['()*!]/.test(h.split("UTF-8''")[1]), 'no non-attr-chars left unencoded');
  assert.strictEqual(decodeURIComponent(h.split("UTF-8''")[1]), 'résumé 日本.pdf');
});

test('contentDisposition: an empty name still yields a usable filename', () => {
  assert.ok(contentDisposition('').includes('filename="download"'));
});
