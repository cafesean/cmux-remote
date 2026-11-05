'use strict';
// p41 D57 — images the human attached from the app or the PWA, shown inline in the thread.
//
// The app uploads a file to the bridge's upload directory and types its PATH into the message, so the
// transcript user row is plain text. splitUploadImages() finds the path tokens in that text that sit
// inside the upload directory and carry an image extension; the normaliser shows each one as an
// `attachment` message (the path token itself is dropped from the text). readUpload() is the only way
// those bytes are served, and it serves nothing whose REAL path is outside the upload directory.
//
//   splitUploadImages(text, root) -> {text, images: [{rel, mime, name}]}   (lexical, no fs)
//   readUpload(rel, root, {maxBytes}) -> Promise<{mime, data: Buffer} | null>
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' };
const LIMITS = {
  uploadMaxBytes: 20 * 1024 * 1024,   // one inline upload image
  uploadRelMax: 512,                  // longest path (relative to the upload root) a url may name
  uploadImagesPerMessage: 20,         // path tokens turned into images per user message
  uploadRefsCacheMax: 64,             // M1: sessions whose referenced-upload set is cached (LRU)
  uploadRefsPerSession: 10000,        // M1: upload rels kept per cached session
};

// A path token as the app and PWA type it (quotePath): bare when it has no shell-special character,
// else single-quoted with ' written as '\''.
const TOKEN_RE = /'((?:[^']|'\\'')*)'|(\S+)/g;

const mimeOf = (p) => IMAGE_EXT[path.extname(p).slice(1).toLowerCase()] || null;
const rootOf = (root) => (typeof root === 'function' ? root() : root);

// rel when `abs` is lexically inside `root` (not the root itself), else null.
function inside(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function splitUploadImages(text, rootArg) {
  const root = rootOf(rootArg);
  const images = [];
  if (typeof text !== 'string' || !root || !path.isAbsolute(root)) return { text, images };
  const base = path.resolve(root);
  const cut = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) && images.length < LIMITS.uploadImagesPerMessage) {
    const p = m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2];
    if (!p.startsWith('/') || p.includes('\0')) continue;
    const abs = path.resolve(p);
    const rel = inside(base, abs);
    const mime = rel && mimeOf(abs);
    if (!mime || rel.length > LIMITS.uploadRelMax) continue;
    images.push({ rel, mime, name: path.basename(abs) });
    cut.push([m.index, m.index + m[0].length]);
  }
  if (!cut.length) return { text, images };
  let out = '';
  let at = 0;
  for (const [s, e] of cut) { out += text.slice(at, s); at = e; }
  out += text.slice(at);
  return { text: out.replace(/[ \t]{2,}/g, ' ').trim(), images };
}

// Serve one upload. Refused (null): a rel that leaves the root, a symlink (anywhere on the way) whose
// target is outside the root's real path, a non-image extension, a non-regular file, an oversize file.
async function readUpload(rel, rootArg, opts = {}) {
  const maxBytes = opts.maxBytes || LIMITS.uploadMaxBytes;
  const root = rootOf(rootArg);
  if (!root || !path.isAbsolute(root) || typeof rel !== 'string' || !rel || rel.length > LIMITS.uploadRelMax || rel.includes('\0')) return null;
  if (path.isAbsolute(rel)) return null;
  const target = path.resolve(root, rel);
  if (!inside(path.resolve(root), target)) return null;
  // L1: open FIRST (no realpath/open window), then prove the fd is the file whose real path is inside
  // the real root: realpath + lstat of that path must be the fd's dev+ino, and realpath must not move.
  const io = opts.fsp || fsp;
  let fh;
  try {
    fh = await io.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = await fh.stat();
    const realRoot = await io.realpath(root);
    const real = await io.realpath(target);
    if (!inside(realRoot, real)) return null;
    const mime = mimeOf(real);
    if (!mime || mimeOf(target) !== mime) return null;
    const ls = await io.lstat(real);
    if (!ls.isFile() || ls.dev !== st.dev || ls.ino !== st.ino) return null;
    if ((await io.realpath(target)) !== real) return null;
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return { mime, tooLarge: true };
    const data = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const { bytesRead } = await fh.read(data, got, st.size - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return { mime, data: data.subarray(0, got) };
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const uploadUrl = (sessionId, rel) => `/api/sessions/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(rel)}`;

module.exports = { splitUploadImages, readUpload, uploadUrl, IMAGE_EXT, LIMITS };
