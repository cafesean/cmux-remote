'use strict';
// k185 — avatars for this Mac and its workspace TITLES (specs k185 §3). One JSON file + a pictures dir:
//   file  statePath('avatars.json', ~/.config/cmux-remote/avatars.json)   seam HYPERMUX_AVATARS_FILE
//   dir   statePath('avatars',      ~/.config/cmux-remote/avatars)        seam HYPERMUX_AVATARS_DIR
// Dirs 0700, files 0600 (atomic write as lib/private-surfaces.js).
//
// Every write (PUT, picture POST, rename move) runs `read latest -> change -> commit` inside ONE
// in-process promise chain (run()), so overlapping writes never lose an unrelated entry. `rev` is
// persisted, +1 per committed write, never reset: the app's only ordering key.
//
// Picture order: bytes -> <id>.tmp -> rename to <id> -> commit metadata -> unlink the previous id if
// nothing references it. A failed commit unlinks the new file and leaves the old avatar intact.
// A file we cannot read (unreadable / bad JSON / bad shape / v != 1) refuses every write and the sweep.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { statePath } = require('./hm-home');

const COLORS = Object.freeze(['green', 'blue', 'violet', 'pink', 'orange', 'slate']);
const ID_RE = /^a-[0-9a-f]{16}\.(jpg|png)$/;
const LIMITS = Object.freeze({ imageMax: 256 * 1024, putMax: 4 * 1024, emojiBytes: 16, entriesMax: 500, keyMax: 200 });
const IMAGE_CACHE = 'private, max-age=31536000, immutable';

function paths(env = process.env, homeDir = os.homedir()) {
  const legacy = path.join(homeDir, '.config', 'cmux-remote');
  return {
    file: env.HYPERMUX_AVATARS_FILE || statePath('avatars.json', path.join(legacy, 'avatars.json'), env),
    dir: env.HYPERMUX_AVATARS_DIR || statePath('avatars', path.join(legacy, 'avatars'), env),
  };
}

const empty = () => ({ v: 1, rev: 0, workspaces: {} });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isAvatar = (a) => isObj(a) && COLORS.includes(a.color);

// -> { data } | { code, error }. Missing file = empty (not written until the first change).
function readFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { data: empty() } : { code: 500, error: 'avatars_unreadable' };
  }
  let d;
  try { d = JSON.parse(raw); } catch (_) { return { code: 500, error: 'avatars_unreadable' }; }
  if (!isObj(d)) return { code: 500, error: 'avatars_unreadable' };
  if (d.v !== 1) return { code: 500, error: 'avatars_unsupported' };
  if (!Number.isInteger(d.rev) || d.rev < 0 || !isObj(d.workspaces)) return { code: 500, error: 'avatars_unreadable' };
  if (d.machine != null && !isAvatar(d.machine)) return { code: 500, error: 'avatars_unreadable' };
  if (!Object.values(d.workspaces).every(isAvatar)) return { code: 500, error: 'avatars_unreadable' };
  return { data: d };
}

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const bad = (error = 'bad_avatar') => ({ code: 400, body: { error } });

// One grapheme, <= 16 UTF-8 bytes. Absent ('' / null / undefined) -> { ok, value: undefined }.
function checkEmoji(e) {
  if (e == null || e === '') return { ok: true, value: undefined };
  if (typeof e !== 'string' || Buffer.byteLength(e, 'utf8') > LIMITS.emojiBytes) return { ok: false };
  const n = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(e)].length;
  return n === 1 ? { ok: true, value: e } : { ok: false };
}
// The one target/key validation PUT and POST share. -> { target, key } | null
function checkTarget(target, key) {
  if (target === 'machine') return { target, key: null };
  if (target === 'workspace' && typeof key === 'string' && key.length >= 1 && key.length <= LIMITS.keyMax) return { target, key };
  return null;
}
const checkColor = (c) => COLORS.includes(c);

function imageKind(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

function createAvatars(opts) {
  const o = opts || {};
  const { file, dir } = o.file && o.dir ? o : paths(o.env, o.homeDir);
  const now = o.now || Date.now;
  const write = o.writeFile || writeFile;   // test seam: inject a failing metadata write
  let chain = Promise.resolve();
  const run = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  const get = (d, t) => (t.target === 'machine' ? d.machine : d.workspaces[t.key]);
  const set = (d, t, a) => {
    if (t.target === 'machine') { if (a) d.machine = a; else delete d.machine; return; }
    if (a) d.workspaces[t.key] = a; else delete d.workspaces[t.key];
  };
  const full = (d, t) => t.target === 'workspace' && !d.workspaces[t.key] && Object.keys(d.workspaces).length >= LIMITS.entriesMax;
  const referenced = (d) => new Set([d.machine, ...Object.values(d.workspaces)].filter((a) => a && a.image).map((a) => a.image));
  const unlinkId = (id) => { if (ID_RE.test(String(id))) { try { fs.unlinkSync(path.join(dir, id)); } catch (_) {} } };
  // rev +1, persisted. -> true | false (write failed; the file on disk is unchanged)
  function commit(d) {
    const next = { ...d, rev: d.rev + 1 };
    try { write(file, next); } catch (e) { console.log(`avatars: write failed (${(e && e.code) || 'error'})`); return null; }
    return next;
  }
  // After a commit: drop old pictures nothing references any more.
  function dropUnreferenced(d, ids) { const keep = referenced(d); for (const id of ids) if (id && !keep.has(id)) unlinkId(id); }
  // Neither emoji nor picture -> no entry.
  const entry = (a) => (a.emoji || a.image ? { ...(a.emoji ? { emoji: a.emoji } : {}), color: a.color, ...(a.image ? { image: a.image } : {}), updatedAt: now() } : null);

  function read() {
    const r = readFile(file);
    return r.error ? { code: r.code, body: { error: r.error } } : { code: 200, body: r.data };
  }

  // PUT body: {target, key?} + one of {clear:true} | {emoji?, color, keepImage?}
  function put(b) {
    if (!isObj(b)) return Promise.resolve(bad());
    const t = checkTarget(b.target, b.key);
    if (!t) return Promise.resolve(bad());
    let em;
    if (!b.clear) {
      if (!checkColor(b.color)) return Promise.resolve(bad());
      em = checkEmoji(b.emoji);
      if (!em.ok) return Promise.resolve(bad());
    }
    return run(() => {
      const r = readFile(file);
      if (r.error) return { code: r.code, body: { error: r.error } };
      const d = { ...r.data, workspaces: { ...r.data.workspaces } };
      const was = get(d, t);
      let next = null;
      if (!b.clear) {
        next = b.keepImage === true && was
          ? entry({ emoji: was.emoji, image: was.image, color: b.color })   // recolour the ring, keep picture + emoji
          : entry({ emoji: em.value, color: b.color });                     // emoji avatar: any picture removed
        if (next && full(d, t)) return bad('avatars_full');
      }
      set(d, t, next);
      const done = commit(d);
      if (!done) return { code: 500, body: { error: 'avatars_write_failed' } };
      dropUnreferenced(done, [was && was.image]);
      return { code: 200, body: done };
    });
  }

  // POST raw bytes; params {target, key?, color?, emoji?}. Picture + emoji + colour = ONE queued write.
  function postImage(params, buf) {
    const q = params || {};
    const t = checkTarget(q.target, q.key);
    if (!t) return Promise.resolve(bad());
    if (q.color != null && q.color !== '' && !checkColor(q.color)) return Promise.resolve(bad());
    const em = checkEmoji(q.emoji);
    if (!em.ok) return Promise.resolve(bad());
    if (!Buffer.isBuffer(buf) || buf.length > LIMITS.imageMax) return Promise.resolve({ code: 413, body: { error: 'too_large' } });
    const kind = imageKind(buf);
    if (!kind) return Promise.resolve({ code: 415, body: { error: 'bad_image' } });
    return run(() => {
      const r = readFile(file);
      if (r.error) return { code: r.code, body: { error: r.error } };
      const d = { ...r.data, workspaces: { ...r.data.workspaces } };
      if (full(d, t)) return bad('avatars_full');
      const was = get(d, t);
      const id = `a-${crypto.randomBytes(8).toString('hex')}.${kind}`;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = path.join(dir, `${id}.tmp`);
        fs.writeFileSync(tmp, buf, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, path.join(dir, id));
      } catch (e) {
        try { fs.unlinkSync(path.join(dir, `${id}.tmp`)); } catch (_) {}
        return { code: 500, body: { error: 'avatars_write_failed' } };
      }
      const color = q.color || (was && was.color) || 'slate';
      const emoji = em.value !== undefined ? em.value : (was && was.emoji);
      set(d, t, entry({ emoji, color, image: id }));
      const done = commit(d);
      if (!done) { unlinkId(id); return { code: 500, body: { error: 'avatars_write_failed' } }; }
      dropUnreferenced(done, [was && was.image]);
      return { code: 200, body: done };
    });
  }

  // -> { code:200, bytes, type } | { code:404, body }
  function getImage(id) {
    if (!ID_RE.test(String(id || ''))) return { code: 404, body: { error: 'not_found' } };
    try {
      const bytes = fs.readFileSync(path.join(dir, id));
      return { code: 200, bytes, type: id.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    } catch (_) { return { code: 404, body: { error: 'not_found' } }; }
  }

  // Rename move (specs §3.1 step 3). NOT queued: the caller runs the whole rename inside run().
  // stillUsed = another workspace in the fresh tree still has the old title (copy, not move).
  // -> { moved: bool, error? }
  function moveTitleLocked(oldTitle, newTitle, stillUsed) {
    if (!oldTitle || !newTitle || oldTitle === newTitle) return { moved: false };
    const r = readFile(file);
    if (r.error) return { moved: false, error: r.error };
    const d = { ...r.data, workspaces: { ...r.data.workspaces } };
    const was = d.workspaces[oldTitle];
    if (!was || d.workspaces[newTitle]) return { moved: false };   // nothing to move / target keeps its own
    if (newTitle.length > LIMITS.keyMax) return { moved: false };
    if (stillUsed && Object.keys(d.workspaces).length >= LIMITS.entriesMax) return { moved: false, error: 'avatars_full' };
    d.workspaces[newTitle] = { ...was, updatedAt: now() };
    if (!stillUsed) delete d.workspaces[oldTitle];
    return commit(d) ? { moved: true } : { moved: false, error: 'avatars_write_failed' };
  }

  // Bridge start: delete pictures (and *.tmp) the file does not reference. Skipped when unreadable.
  function sweep() {
    const r = readFile(file);
    if (r.error) return { skipped: true, removed: [] };
    const keep = referenced(r.data);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return { skipped: false, removed: [] }; }
    const removed = [];
    for (const n of names) {
      const tmp = n.endsWith('.tmp') && ID_RE.test(n.slice(0, -4));
      if ((ID_RE.test(n) && !keep.has(n)) || tmp) {
        try { fs.unlinkSync(path.join(dir, n)); removed.push(n); } catch (_) {}
      }
    }
    return { skipped: false, removed };
  }

  return { file, dir, run, read, put, postImage, getImage, moveTitleLocked, sweep };
}

module.exports = { createAvatars, paths, readFile, imageKind, checkEmoji, COLORS, ID_RE, LIMITS, IMAGE_CACHE };
