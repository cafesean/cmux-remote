'use strict';
// p41 D65 — a large uploaded image is shown in the thread as a small JPEG; the original is served only
// on ?size=full. Thumbnails are made by macOS's built-in `sips` (execFile argv, no shell, timeout) from a
// private COPY of the verified upload bytes (sips never opens a path the human controls), cached in
// <upload root>/.thumbs/<sha1(rel, mtime, size)>.jpg (tmp + rename), bounded by count and bytes (LRU by
// mtime, touched on hit). One generation per key at a time; at most LIMITS.thumbConcurrency sips at once.
//
//   createThumbs({resize?, limits?}) -> { get(rel, root, readUpload) -> Promise<result> }
//   result: {kind:'thumb', data} | {kind:'fallback', mime, data} | {kind:'error', status, code} | null
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const THUMB_DIR = '.thumbs';
const LIMITS = {
  thumbMaxEdge: 1280,                        // long edge of a thumbnail, px (never upscaled)
  thumbQuality: 75,                          // JPEG quality (sips formatOptions, 0-100)
  thumbTimeoutMs: 15000,                     // one sips run, then SIGKILL
  thumbConcurrency: 2,                       // sips processes at once, all sessions
  thumbCacheMaxFiles: 500,                   // cached thumbnails kept (oldest-used dropped first)
  thumbCacheMaxBytes: 256 * 1024 * 1024,     // bytes of cached thumbnails kept
  thumbOutMaxBytes: 8 * 1024 * 1024,         // a sips output bigger than this is discarded
  thumbFallbackMaxBytes: 2 * 1024 * 1024,    // no thumbnail possible: the original is served only up to this
};

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// (src, out, {maxEdge, quality, timeoutMs}) -> Promise<void>. Throws {code:'ENOENT'} when sips is absent.
async function sipsResize(src, out, o) {
  if (process.platform !== 'darwin') { const e = new Error('sips unavailable'); e.code = 'ENOENT'; throw e; }
  const info = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], o.timeoutMs);
  const w = Number((/pixelWidth:\s*(\d+)/.exec(info) || [])[1]);
  const h = Number((/pixelHeight:\s*(\d+)/.exec(info) || [])[1]);
  if (!(w > 0 && h > 0)) throw new Error('sips: no dimensions');
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(o.quality)];
  if (Math.max(w, h) > o.maxEdge) args.push('-Z', String(o.maxEdge));   // -Z alone would upscale
  args.push(src, '--out', out);
  await run('/usr/bin/sips', args, o.timeoutMs);
}

const keyOf = (rel, st) => crypto.createHash('sha1').update(`${rel}\0${st.mtimeMs}\0${st.size}`).digest('hex');

function createThumbs(opts = {}) {
  const L = { ...LIMITS, ...(opts.limits || {}) };
  const resize = opts.resize || sipsResize;
  const inflight = new Map();   // key -> Promise
  const waiters = [];
  let active = 0;
  const acquire = () => (active < L.thumbConcurrency ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const release = () => { const n = waiters.shift(); if (n) n(); else active--; };

  // The cache dir, created 0700; refused when it is not a real directory (a planted symlink, a file).
  async function cacheDir(root) {
    const dir = path.join(root, THUMB_DIR);
    await fsp.mkdir(dir, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
    const ls = await fsp.lstat(dir);
    if (!ls.isDirectory() || ls.isSymbolicLink()) throw new Error('thumb dir not a directory');
    return dir;
  }

  async function readCached(file) {
    let fh;
    try {
      fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = await fh.stat();
      if (!st.isFile() || !st.size || st.size > L.thumbOutMaxBytes) return null;
      const data = await fh.readFile();
      const now = new Date();
      fsp.utimes(file, now, now).catch(() => {});   // LRU touch
      return data;
    } catch (_) { return null; } finally { if (fh) await fh.close().catch(() => {}); }
  }

  async function prune(dir) {
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { return; }
    const files = [];
    for (const n of names) {
      if (!/^[0-9a-f]{40}\.jpg$/.test(n)) continue;
      try { const st = await fsp.lstat(path.join(dir, n)); if (st.isFile()) files.push({ n, size: st.size, t: st.mtimeMs }); } catch (_) {}
    }
    files.sort((a, b) => a.t - b.t);
    let bytes = files.reduce((s, f) => s + f.size, 0);
    while (files.length && (files.length > L.thumbCacheMaxFiles || bytes > L.thumbCacheMaxBytes)) {
      const f = files.shift();
      bytes -= f.size;
      await fsp.unlink(path.join(dir, f.n)).catch(() => {});
    }
  }

  async function generate(rel, root, readUpload, dir, key) {
    const a = await readUpload(rel, root);   // re-verified read: the bytes sips gets
    if (!a || a.tooLarge) return a ? { kind: 'error', status: 413, code: 'too_large' } : null;
    const tag = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const src = path.join(dir, `.src.${key}.${tag}${path.extname(rel).toLowerCase()}`);
    const tmp = path.join(dir, `.tmp.${key}.${tag}.jpg`);
    const final = path.join(dir, `${key}.jpg`);
    try {
      await fsp.writeFile(src, a.data, { flag: 'wx', mode: 0o600 });
      await acquire();
      try { await resize(src, tmp, { maxEdge: L.thumbMaxEdge, quality: L.thumbQuality, timeoutMs: L.thumbTimeoutMs }); } finally { release(); }
      const data = await readCached(tmp);
      if (!data) throw new Error('thumb output missing or oversize');
      await fsp.rename(tmp, final);
      prune(dir).catch(() => {});
      return { kind: 'thumb', data };
    } catch (e) {
      if (a.data.length <= L.thumbFallbackMaxBytes) return { kind: 'fallback', mime: a.mime, data: a.data };
      return e && e.code === 'ENOENT' && (!e.syscall || String(e.syscall).startsWith('spawn'))
        ? { kind: 'error', status: 415, code: 'thumb_unsupported' }
        : { kind: 'error', status: 502, code: 'thumb_failed' };
    } finally {
      await fsp.unlink(src).catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  // readUpload(rel, root, {stat:true}) must verify containment and return {mime, size, mtimeMs}; with no
  // options it returns the verified bytes. The caller has already bound rel to the session.
  async function get(rel, root, readUpload) {
    const st = await readUpload(rel, root, { stat: true });
    if (!st) return null;
    if (st.tooLarge) return { kind: 'error', status: 413, code: 'too_large' };
    let dir;
    try { dir = await cacheDir(root); } catch (_) { return { kind: 'error', status: 502, code: 'thumb_failed' }; }
    const key = keyOf(rel, st);
    const hit = await readCached(path.join(dir, `${key}.jpg`));
    if (hit) return { kind: 'thumb', data: hit, cached: true };
    let p = inflight.get(key);
    if (!p) {
      p = generate(rel, root, readUpload, dir, key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  return { get, stats: () => ({ active, queued: waiters.length, inflight: inflight.size }) };
}

module.exports = { createThumbs, sipsResize, THUMB_DIR, LIMITS };
