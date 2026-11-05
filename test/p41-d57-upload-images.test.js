'use strict';
// p41 D57 — an image the human attached (uploaded, then its path typed) shows inline in the thread,
// and the upload route serves nothing outside the upload directory. Everything lives in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { splitUploadImages, readUpload, uploadUrl, uploadFullUrl } = require('../sessions/uploads.js');
const { readThread, tailThread } = require('../sessions/transcript-claude.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p41-d57-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, 'uploads');
const day = path.join(root, '2026-11-05');
fs.mkdirSync(day, { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
fs.writeFileSync(path.join(day, 'pasted-1.png'), PNG);
fs.writeFileSync(path.join(day, 'my shot (1).jpg'), PNG);
fs.writeFileSync(path.join(day, 'notes.txt'), 'x');
const outside = path.join(tmp, 'secret.png');
fs.writeFileSync(outside, PNG);
fs.symlinkSync(outside, path.join(day, 'escape.png'));
fs.symlinkSync(tmp, path.join(day, 'dirlink'));
fs.mkdirSync(path.join(day, 'adir.png'));

test('split: an upload image path becomes an image and leaves the text', () => {
  const p = path.join(day, 'pasted-1.png');
  const r = splitUploadImages(`look at this ${p}`, root);
  assert.strictEqual(r.text, 'look at this');
  assert.deepStrictEqual(r.images, [{ rel: '2026-11-05/pasted-1.png', mime: 'image/png', name: 'pasted-1.png' }]);
});

test('split: a single-quoted path with spaces (quotePath) is found', () => {
  const p = path.join(day, 'my shot (1).jpg');
  const r = splitUploadImages(`a '${p}' b`, root);
  assert.strictEqual(r.text, 'a b');
  assert.strictEqual(r.images[0].rel, '2026-11-05/my shot (1).jpg');
  assert.strictEqual(r.images[0].mime, 'image/jpeg');
});

test('split: paths outside the root, traversal, non-images and relative paths stay text', () => {
  const texts = [
    `see ${outside}`,
    `see ${root}/../secret.png`,
    `see ${path.join(day, 'notes.txt')}`,
    'see 2026-11-05/pasted-1.png',
    `see ${root}`,
    `see ${root}-other/x.png`,
  ];
  for (const t of texts) {
    const r = splitUploadImages(t, root);
    assert.deepStrictEqual(r.images, [], t);
    assert.strictEqual(r.text, t);
  }
  assert.deepStrictEqual(splitUploadImages(`x ${path.join(day, 'pasted-1.png')}`, null).images, []);
});

test('readUpload serves an image inside the root', async () => {
  const a = await readUpload('2026-11-05/pasted-1.png', root);
  assert.strictEqual(a.mime, 'image/png');
  assert.ok(a.data.equals(PNG));
  const b = await readUpload('2026-11-05/my shot (1).jpg', () => root);
  assert.strictEqual(b.mime, 'image/jpeg');
});

test('readUpload refuses traversal, absolute, symlink escape, non-image, non-file', async () => {
  const refused = [
    '../secret.png',
    '2026-11-05/../../secret.png',
    outside,
    '/etc/hosts',
    '2026-11-05/escape.png',
    '2026-11-05/dirlink/secret.png',
    '2026-11-05/notes.txt',
    '2026-11-05/adir.png',
    '2026-11-05/missing.png',
    '',
    'a\0.png',
    'x'.repeat(600) + '.png',
  ];
  for (const rel of refused) assert.strictEqual(await readUpload(rel, root), null, rel);
  assert.strictEqual(await readUpload('2026-11-05/pasted-1.png', null), null);
  assert.strictEqual(await readUpload('2026-11-05/pasted-1.png', 'relative/root'), null);
});

test('readUpload: over the size cap is tooLarge, never the bytes', async () => {
  const a = await readUpload('2026-11-05/pasted-1.png', root, { maxBytes: 4 });
  assert.deepStrictEqual(a, { mime: 'image/png', tooLarge: true });
});

const transcript = (rows) => {
  const p = path.join(tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
};
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n, content) => ({ type: 'user', uuid: uid(n), timestamp: new Date(Date.parse('2026-11-05T10:00:00Z') + n * 1000).toISOString(), message: { role: 'user', content } });

test('readThread: a typed upload path is an attachment with an upload url; the text keeps the rest', async () => {
  const img = path.join(day, 'pasted-1.png');
  const p = transcript([user(1, `what is this ${img}`), user(2, img), user(3, `plain ${outside}`)]);
  const { messages } = await readThread(p, { sessionId: 's1', uploadRoot: root });
  assert.deepStrictEqual(messages.map((m) => m.kind), ['user', 'attachment', 'attachment', 'user']);
  assert.strictEqual(messages[0].text, 'what is this');
  assert.deepStrictEqual(messages[1].attachment, { mime: 'image/png', name: 'pasted-1.png', url: uploadUrl('s1', '2026-11-05/pasted-1.png'), fullUrl: uploadFullUrl('s1', '2026-11-05/pasted-1.png') });
  assert.strictEqual(messages[1].attachment.url, '/api/sessions/s1/upload/2026-11-05%2Fpasted-1.png');
  assert.strictEqual(messages[3].text, `plain ${outside}`);
  assert.ok(!('upload' in JSON.parse(JSON.stringify(messages[1]))));
});

test('readThread without uploadRoot: unchanged (the path stays text)', async () => {
  const img = path.join(day, 'pasted-1.png');
  const p = transcript([user(1, `what is this ${img}`)]);
  const { messages } = await readThread(p, { sessionId: 's1' });
  assert.deepStrictEqual(messages.map((m) => [m.kind, m.text]), [['user', `what is this ${img}`]]);
});

test('readThread: an image-only message pages with a cursor', async () => {
  const img = path.join(day, 'pasted-1.png');
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(user(i, i % 2 ? img : `m${i}`));
  const p = transcript(rows);
  const first = await readThread(p, { sessionId: 's1', uploadRoot: root, limit: 2 });
  assert.ok(first.cursor);
  const older = await readThread(p, { sessionId: 's1', uploadRoot: root, limit: 2, before: first.cursor });
  assert.strictEqual(older.messages.length, 2);
});

test('tailThread: a new message with an upload path streams the attachment with its url', async () => {
  const img = path.join(day, 'pasted-1.png');
  const p = transcript([user(1, 'hi')]);
  const ac = new AbortController();
  const got = [];
  const run = (async () => {
    for await (const m of tailThread(p, fs.statSync(p).size, { signal: ac.signal, sessionId: 's1', uploadRoot: root, pollMs: 20 })) {
      got.push(m);
      if (got.length >= 2) ac.abort();
    }
  })();
  fs.appendFileSync(p, JSON.stringify(user(2, `see ${img}`)) + '\n');
  const t = setTimeout(() => ac.abort(), 3000);
  await run;
  clearTimeout(t);
  assert.deepStrictEqual(got.map((m) => m.kind), ['user', 'attachment']);
  assert.strictEqual(got[1].attachment.url, '/api/sessions/s1/upload/2026-11-05%2Fpasted-1.png');
});

// ---- fix round 1 ---------------------------------------------------------------------------------

test('L1: a dir swapped for a symlink around open() never serves the outside file', async () => {
  const fsp = require('fs/promises');
  const sdir = path.join(root, 'swap');
  const away = path.join(tmp, 'away');
  fs.mkdirSync(away, { recursive: true });
  fs.writeFileSync(path.join(away, 'p.png'), Buffer.from('outside-bytes'));
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'p.png'), PNG);
  const toLink = () => { fs.renameSync(sdir, sdir + '.real'); fs.symlinkSync(away, sdir); };
  const toReal = () => { fs.unlinkSync(sdir); fs.renameSync(sdir + '.real', sdir); };
  const io = { ...fsp, async open(...a) { toLink(); try { return await fsp.open(...a); } finally { toReal(); } } };
  const a = await readUpload('swap/p.png', root, { fsp: io });
  assert.strictEqual(a, null);
  assert.ok((await readUpload('swap/p.png', root)).data.equals(PNG));
});

test('M1: uploadRefs lists only rels typed in human messages; resumes from end', async () => {
  const { uploadRefs } = require('../sessions/transcript-claude.js');
  const img = path.join(day, 'pasted-1.png');
  const asst = { type: 'assistant', uuid: uid(9), timestamp: '2026-11-05T10:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: `see ${path.join(day, 'my shot (1).jpg')}` }] } };
  const p = transcript([user(1, `look ${img}`), asst]);
  const r = await uploadRefs(p, { uploadRoot: root });
  assert.deepStrictEqual([...r.rels], ['2026-11-05/pasted-1.png']);
  assert.strictEqual(r.end, fs.statSync(p).size);
  fs.appendFileSync(p, JSON.stringify(user(3, `'${path.join(day, 'my shot (1).jpg')}'`)) + '\n');
  const r2 = await uploadRefs(p, { uploadRoot: root, from: r.end });
  assert.deepStrictEqual([...r2.rels], ['2026-11-05/my shot (1).jpg']);
});
