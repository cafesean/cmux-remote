'use strict';
// p41 D65 — a large uploaded image is shown as a small JPEG thumbnail; the original only on ?size=full.
// The resize function is injected (sips is macOS-only); one real-sips test runs only on darwin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { createThumbs, sipsResize, THUMB_DIR } = require('../sessions/thumbs.js');
const { readUpload, splitUploadImages, uploadUrl, uploadFullUrl } = require('../sessions/uploads.js');
const { readThread } = require('../sessions/transcript-claude.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p41-d65-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshRoot = () => { const r = path.join(tmp, `up${n++}`); fs.mkdirSync(path.join(r, 'd'), { recursive: true }); return r; };

// A valid w x h RGB PNG.
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const read = (rel, root, o) => readUpload(rel, root, o || {});

// A fake resize: records calls, writes a tiny "jpeg"; optional gate to hold it open.
function fakeResize({ gate, fail } = {}) {
  const calls = [];
  let live = 0; let peak = 0;
  const fn = async (src, out, o) => {
    calls.push({ src, out, o, bytes: fs.readFileSync(src).length });
    live++; peak = Math.max(peak, live);
    try {
      if (gate) await gate;
      if (fail) throw fail;
      fs.writeFileSync(out, JPEG);
    } finally { live--; }
  };
  return { fn, calls, peak: () => peak };
}

test('thumb: generated once, then served from the cache (resize not called again)', async () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'd', 'a.png'), png(4, 4));
  const r = fakeResize();
  const t = createThumbs({ resize: r.fn });
  const a = await t.get('d/a.png', root, read);
  assert.equal(a.kind, 'thumb');
  assert.ok(a.data.equals(JPEG));
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].o.maxEdge, 1280);
  assert.equal(r.calls[0].o.quality, 75);
  assert.ok(r.calls[0].src.startsWith(path.join(root, THUMB_DIR) + path.sep), 'sips reads a private copy, not the upload');
  const b = await t.get('d/a.png', root, read);
  assert.equal(b.kind, 'thumb'); assert.equal(b.cached, true);
  assert.equal(r.calls.length, 1);
  const files = fs.readdirSync(path.join(root, THUMB_DIR));
  assert.equal(files.length, 1, `no tmp/src left: ${files}`);
  assert.match(files[0], /^[0-9a-f]{40}\.jpg$/);
  // A changed file (new mtime/size) gets a new thumbnail.
  fs.writeFileSync(path.join(root, 'd', 'a.png'), png(5, 5));
  await t.get('d/a.png', root, read);
  assert.equal(r.calls.length, 2);
});

test('thumb: containment — traversal, symlink escape, and the .thumbs dir itself are refused', async () => {
  const root = freshRoot();
  const out = path.join(tmp, `secret${n}.png`); fs.writeFileSync(out, png(2, 2));
  fs.symlinkSync(out, path.join(root, 'd', 'escape.png'));
  const r = fakeResize();
  const t = createThumbs({ resize: r.fn });
  for (const rel of ['../secret.png', 'd/../../x.png', 'd/escape.png', out]) assert.equal(await t.get(rel, root, read), null, rel);
  fs.writeFileSync(path.join(root, 'd', 'a.png'), png(2, 2));
  await t.get('d/a.png', root, read);
  const [cached] = fs.readdirSync(path.join(root, THUMB_DIR));
  assert.equal(await readUpload(`${THUMB_DIR}/${cached}`, root), null, 'a cached thumb is never an upload');
  assert.equal(splitUploadImages(`see ${path.join(root, THUMB_DIR, cached)}`, root).images.length, 0);
  assert.equal(r.calls.length, 1);
  // A planted .thumbs symlink is refused, not followed.
  const root2 = freshRoot();
  fs.writeFileSync(path.join(root2, 'd', 'a.png'), png(2, 2));
  fs.symlinkSync(tmp, path.join(root2, THUMB_DIR));
  const e = await t.get('d/a.png', root2, read);
  assert.equal(e.kind, 'error'); assert.equal(e.status, 502);
});

test('thumb: resize fails -> small original served as fallback; big original -> 502 thumb_failed; no sips -> 415', async () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'd', 'small.png'), png(3, 3));
  fs.writeFileSync(path.join(root, 'd', 'big.png'), Buffer.alloc(4096, 1));
  const failing = createThumbs({ resize: fakeResize({ fail: new Error('boom') }).fn, limits: { thumbFallbackMaxBytes: 1024 } });
  const s = await failing.get('d/small.png', root, read);
  assert.equal(s.kind, 'fallback'); assert.equal(s.mime, 'image/png');
  assert.ok(s.data.equals(fs.readFileSync(path.join(root, 'd', 'small.png'))));
  const b = await failing.get('d/big.png', root, read);
  assert.deepEqual([b.kind, b.status, b.code], ['error', 502, 'thumb_failed']);
  const nosips = Object.assign(new Error('spawn /usr/bin/sips ENOENT'), { code: 'ENOENT', syscall: 'spawn /usr/bin/sips' });
  const absent = createThumbs({ resize: fakeResize({ fail: nosips }).fn, limits: { thumbFallbackMaxBytes: 1024 } });
  const c = await absent.get('d/big.png', root, read);
  assert.deepEqual([c.kind, c.status, c.code], ['error', 415, 'thumb_unsupported']);
  assert.deepEqual(fs.readdirSync(path.join(root, THUMB_DIR)), [], 'nothing cached on failure');
});

test('thumb: input size cap still applies (413)', async () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'd', 'a.png'), Buffer.alloc(2000, 1));
  const r = fakeResize();
  const t = createThumbs({ resize: r.fn });
  const x = await t.get('d/a.png', root, (rel, rt, o) => readUpload(rel, rt, { ...(o || {}), maxBytes: 1000 }));
  assert.deepEqual([x.kind, x.status, x.code], ['error', 413, 'too_large']);
  assert.equal(r.calls.length, 0);
});

test('thumb: concurrency — one generation per file, at most thumbConcurrency resizes at once', async () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, 'd', `f${i}.png`), png(2 + i, 2));
  let open; const gate = new Promise((r) => { open = r; });
  const r = fakeResize({ gate });
  const t = createThumbs({ resize: r.fn });
  const same = [t.get('d/f0.png', root, read), t.get('d/f0.png', root, read), t.get('d/f0.png', root, read)];
  const others = [1, 2, 3, 4].map((i) => t.get(`d/f${i}.png`, root, read));
  await new Promise((r2) => setTimeout(r2, 100));
  assert.ok(r.calls.length <= 2, `at most 2 started, got ${r.calls.length}`);
  open();
  const all = await Promise.all([...same, ...others]);
  assert.ok(all.every((x) => x.kind === 'thumb'));
  assert.equal(r.calls.length, 5, 'f0 generated once for 3 requests');
  assert.equal(r.peak(), 2);
  assert.deepEqual(t.stats(), { active: 0, queued: 0, inflight: 0 });
});

test('thumb: cache bounded by count (oldest-used dropped)', async () => {
  const root = freshRoot();
  const r = fakeResize();
  const t = createThumbs({ resize: r.fn, limits: { thumbCacheMaxFiles: 2 } });
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(root, 'd', `f${i}.png`), png(2 + i, 2));
    await t.get(`d/f${i}.png`, root, read);
    await new Promise((r2) => setTimeout(r2, 30));
  }
  await new Promise((r2) => setTimeout(r2, 50));
  assert.ok(fs.readdirSync(path.join(root, THUMB_DIR)).length <= 2);
  const before = r.calls.length;
  await t.get('d/f3.png', root, read);
  assert.equal(r.calls.length, before, 'newest still cached');
});

test('thread: an upload image url is the thumbnail; fullUrl is ?size=full', async () => {
  const root = freshRoot();
  const p = path.join(root, 'd', 'a.png'); fs.writeFileSync(p, png(2, 2));
  const tp = path.join(tmp, `t${n++}.jsonl`);
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: `look ${p}` } }) + '\n');
  const { messages } = await readThread(tp, { sessionId: 's1', uploadRoot: root });
  const att = messages.find((m) => m.kind === 'attachment');
  assert.ok(att, JSON.stringify(messages));
  assert.equal(att.attachment.url, uploadUrl('s1', 'd/a.png'));
  assert.equal(att.attachment.fullUrl, uploadFullUrl('s1', 'd/a.png'));
  assert.equal(att.attachment.fullUrl, '/api/sessions/s1/upload/d%2Fa.png?size=full');
});

test('real sips: long edge 1280, JPEG, never upscaled', { skip: process.platform !== 'darwin' && 'sips is macOS-only' }, async () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'd', 'big.png'), png(2000, 1000));
  fs.writeFileSync(path.join(root, 'd', 'small.png'), png(40, 20));
  const t = createThumbs({ resize: sipsResize });
  const dims = async (buf) => {
    const f = path.join(tmp, `probe${n++}.jpg`); fs.writeFileSync(f, buf);
    const out = require('child_process').execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f]).toString();
    return [Number(/pixelWidth:\s*(\d+)/.exec(out)[1]), Number(/pixelHeight:\s*(\d+)/.exec(out)[1])];
  };
  const big = await t.get('d/big.png', root, read);
  assert.equal(big.kind, 'thumb');
  assert.deepEqual([...big.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual(await dims(big.data), [1280, 640]);
  const small = await t.get('d/small.png', root, read);
  assert.equal(small.kind, 'thumb');
  assert.deepEqual(await dims(small.data), [40, 20]);
});
