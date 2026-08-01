'use strict';
// cmux-remote filesystem browse — all fs concerns for the Files tab live here, deliberately
// separate from bridge.js so the security-critical jail is unit-testable without HTTP or cmux.
//
// READ-ONLY BY DESIGN. Nothing in this module creates, modifies, renames, or deletes a file,
// except transient JPEGs in os.tmpdir() for image transcoding, which are unlinked immediately.
//
// Two ways out: `read` is for VIEWING (bounded, images downscaled) and `download` is for KEEPING
// (the original bytes, whole). Both enter through the same jail; only `download` can be gigabytes,
// so it hands the caller a validated path to stream rather than a buffer.
//
// Root model (spec D2): FS_ROOTS is a colon-separated list of absolute paths and/or the literal
// `workspace-cwds`, which means "derive from cmux's open workspaces". The DEFAULT is
// workspace-cwds — never `/`. This repo is public; full-disk read is opt-in per deployment.
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_PATH_LEN = 4096;
const MAX_DEPTH = 64;              // defensive stop for pathological firmlink chains that survive realpath
const DIR_CACHE_TTL = 30000;
const DIR_CACHE_MAX = 200;
const ROOTS_TTL = 30000;

const ERR_STATUS = {
  bad_path: 400, not_a_dir: 400, not_a_file: 400, too_deep: 400,
  outside_root: 403, tcc_denied: 403,
  not_found: 404, read_failed: 500,
};

class FsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FsError';
    this.code = code;
    this.status = ERR_STATUS[code] || 500;
  }
}
const fail = (code) => { throw new FsError(code); };

// errno -> our taxonomy. EPERM/EACCES is overwhelmingly macOS TCC (the bridge runs under launchd
// and has no Full Disk Access until granted), so it gets its own code and its own UI message.
function mapErrno(e) {
  if (!e || !e.code) fail('read_failed');
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail('not_found');
  if (e.code === 'EACCES' || e.code === 'EPERM') fail('tcc_denied');
  if (e.code === 'ELOOP' || e.code === 'ENAMETOOLONG') fail('bad_path');
  fail('read_failed');
}

function parseRootsSpec(spec) {
  const out = { dynamic: false, fixed: [] };
  for (const part of String(spec == null ? '' : spec).split(':')) {
    const t = part.trim();
    if (!t) continue;
    if (t === 'workspace-cwds') { out.dynamic = true; continue; }
    if (path.isAbsolute(t)) out.fixed.push(t);
  }
  // An empty or malformed spec must fall back to the SAFE default, never to `/`.
  if (!out.dynamic && out.fixed.length === 0) out.dynamic = true;
  return out;
}

// Directory listing cache. Key is `realpath:mtimeMs`, so a directory that changes gets a new key
// and the stale entry simply ages out — no explicit invalidation needed. This is what makes
// paging through a 100k-entry node_modules cost ONE readdir for the whole session.
const dirCache = new Map();

function dirCacheGet(key) {
  const hit = dirCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > DIR_CACHE_TTL) { dirCache.delete(key); return null; }
  dirCache.delete(key); dirCache.set(key, hit);      // Map preserves insertion order → LRU touch
  return hit.names;
}

function dirCacheSet(key, names) {
  dirCache.set(key, { names, at: Date.now() });
  while (dirCache.size > DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value);
}

// Type comes from the dirent itself — readdir({withFileTypes:true}) needs NO stat per entry,
// which is the whole reason a 100k-entry directory lists in milliseconds. A symlink's target
// type is deliberately not resolved here; that would cost one stat per row.
const direntType = (d) =>
  d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : d.isFile() ? 'file' : 'special';

const typeRank = (t) => (t === 'dir' ? 0 : 1);
const byDirThenName = (a, b) =>
  typeRank(a.type) - typeRank(b.type) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);   // tiebreak keeps paging stable

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.tif', '.tiff']);

// extension -> highlight.js language id. A miss yields '' and highlight.js auto-detects.
const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.java': 'java', '.swift': 'swift',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.conf': 'ini',
  '.sql': 'sql', '.css': 'css', '.scss': 'scss', '.html': 'xml', '.xml': 'xml', '.svg': 'xml',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.m': 'objectivec',
  '.md': 'markdown', '.markdown': 'markdown', '.diff': 'diff', '.patch': 'diff',
};

// extension -> Content-Type for downloads. A miss ships application/octet-stream. Every download
// goes out as `Content-Disposition: attachment`, so this never decides whether the browser renders
// a file inline — only what the OS does with it once saved.
const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2', '.xz': 'application/x-xz', '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.dmg': 'application/x-apple-diskimage',
};

// Single-range parser for the download endpoint. Range support is what makes a large download
// RESUMABLE — an interrupted 2 GB file over a phone tunnel is otherwise 2 GB thrown away. A
// multi-range request (`bytes=0-9,20-29`) returns null, and the caller then answers 200 with the
// whole file, which RFC 9110 explicitly permits.
// Returns: null (absent or ignorable) | { start, end } | 'invalid' (caller must answer 416).
function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (!size) return 'invalid';                     // nothing is satisfiable in an empty file
  let start, end;
  if (a === '') {                                  // suffix form: the last N bytes
    const n = Number(b);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
    if (start >= size || end < start) return 'invalid';
    if (end >= size) end = size - 1;               // an over-long end is clamped, not rejected
  }
  return { start, end };
}

// Content-Disposition for a name that came off a real disk: it may contain quotes, CR/LF (header
// INJECTION — the reason this is scrubbed rather than interpolated raw), and non-ASCII. Emit a
// scrubbed ASCII `filename=` for naive clients plus an RFC 5987 `filename*=` for everything else.
function contentDisposition(name) {
  const clean = String(name || 'download').replace(/[\r\n"\\;]/g, '_');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_') || 'download';
  // encodeURIComponent leaves !'()* alone, none of which are RFC 5987 attr-chars.
  const utf8 = encodeURIComponent(clean)
    .replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const FS_IMAGE_MAX_DIM = 1600;   // px, longest edge after sips downscale
const FS_IMAGE_JPEG_Q = '70';

// Bounded read: open + read at most `max` bytes. NEVER readFile-then-slice — a 4 GB VM image
// would be pulled into memory before the slice ever happened.
async function headBytes(file, max) {
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch (e) { mapErrno(e); }
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } catch (e) {
    mapErrno(e);
  } finally {
    await fh.close().catch(() => {});
  }
}

// A NUL byte in the first 8 KB is the practical binary signal — it never appears in valid UTF-8 text.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Transcode through macOS's built-in sips — same technique bridge.js already uses for browser
// frames (zero npm deps). A 12 MP HEIC becomes a phone-sized JPEG. Returns null on any failure;
// the caller degrades to `binary` rather than failing the request.
function imageDataUri(file) {
  const out = path.join(os.tmpdir(), `cmux-remote-fs-${crypto.randomBytes(8).toString('hex')}.jpg`);
  return new Promise((resolve) => {
    execFile('/usr/bin/sips',
      ['-Z', String(FS_IMAGE_MAX_DIM), '-s', 'format', 'jpeg', '-s', 'formatOptions', FS_IMAGE_JPEG_Q, file, '--out', out],
      { timeout: 15000 },
      (err) => {
        if (err) return resolve(null);
        fsp.readFile(out)
          .then((b) => resolve('data:image/jpeg;base64,' + b.toString('base64')))
          .catch(() => resolve(null))
          .finally(() => { fsp.unlink(out).catch(() => {}); });
      });
  });
}

function createFsBrowse(opts = {}) {
  const rootsSpec = opts.rootsSpec != null ? opts.rootsSpec : (process.env.FS_ROOTS || 'workspace-cwds');
  const workspaceCwds = opts.workspaceCwds || (async () => []);
  const readMax = Number(opts.readMax || process.env.FS_READ_MAX || 1048576);
  const pageMax = Number(opts.pageMax || process.env.FS_PAGE_MAX || 500);

  let rootsCache = null;   // { paths: string[], at: number }

  // Every configured root, realpath'd. Unresolvable roots are dropped silently — a closed
  // workspace or an unmounted volume must not break browsing the others.
  async function _resolvedRoots() {
    if (rootsCache && Date.now() - rootsCache.at < ROOTS_TTL) return rootsCache.paths;
    const spec = parseRootsSpec(rootsSpec);
    const candidates = [...spec.fixed];
    if (spec.dynamic) for (const w of await workspaceCwds()) if (w && w.path) candidates.push(w.path);
    const resolved = [];
    for (const c of candidates) {
      try { resolved.push(await fsp.realpath(c)); } catch (_) { /* gone or unreadable — skip */ }
    }
    const paths = [...new Set(resolved)];
    rootsCache = { paths, at: Date.now() };
    return paths;
  }

  const within = (root, p) => {
    if (p === root) return true;
    const rel = path.relative(root, p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  // THE JAIL. Order matters: validate the string, realpath it (which collapses `..`, symlinks,
  // and macOS firmlinks in one step), depth-cap it, then compare against realpath'd roots.
  // Every public function starts here. Nothing bypasses it.
  async function _jail(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath) fail('bad_path');
    if (rawPath.length > MAX_PATH_LEN || rawPath.includes('\0')) fail('bad_path');
    let real;
    try { real = await fsp.realpath(rawPath); } catch (e) { mapErrno(e); }
    if (real.split(path.sep).filter(Boolean).length > MAX_DEPTH) fail('too_deep');
    for (const r of await _resolvedRoots()) if (within(r, real)) return real;
    fail('outside_root');
  }

  // Landing screen. Configured roots first; then the well-known places, but ONLY those that are
  // themselves inside a root — with the default workspace-cwds spec, `/` is not browsable and
  // must not be offered as a dead row.
  async function roots() {
    const spec = parseRootsSpec(rootsSpec);
    const resolved = await _resolvedRoots();
    const out = [];
    const seen = new Set();
    const push = (kind, label, p) => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      out.push({ kind, label, path: p });
    };
    if (spec.dynamic) {
      for (const w of await workspaceCwds()) {
        let rp; try { rp = await fsp.realpath(w.path); } catch (_) { continue; }
        push('workspace', w.label || path.basename(rp) || rp, rp);
      }
    }
    for (const f of spec.fixed) {
      let rp; try { rp = await fsp.realpath(f); } catch (_) { continue; }
      push('fixed', rp, rp);
    }
    for (const place of ['/', os.homedir(), '/Volumes']) {
      let rp; try { rp = await fsp.realpath(place); } catch (_) { continue; }
      if (resolved.some((r) => within(r, rp))) push('place', place === os.homedir() ? '~' : place, rp);
    }
    return { roots: out };
  }

  // opts.hidden — include dotfiles (default true). Filtering happens HERE, server-side, rather
  // than in the client: `total` has to reflect the filter or the footer count and every
  // subsequent offset would be computed against a different list than the one being shown.
  async function list(rawPath, offset, limit, opts = {}) {
    const dir = await _jail(rawPath);
    let st;
    try { st = await fsp.stat(dir); } catch (e) { mapErrno(e); }
    if (!st.isDirectory()) fail('not_a_dir');

    const key = `${dir}:${st.mtimeMs}`;
    let names = dirCacheGet(key);
    if (!names) {
      let dirents;
      try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { mapErrno(e); }
      names = dirents.map((d) => ({ name: d.name, type: direntType(d) })).sort(byDirThenName);
      dirCacheSet(key, names);
    }
    // Filter after the cache, never before — one cached readdir serves both toggle states.
    const showHidden = opts.hidden !== false;
    if (!showHidden) names = names.filter((e) => !e.name.startsWith('.'));

    const total = names.length;
    const lim = Math.min(Math.max(1, Math.trunc(Number(limit)) || 200), pageMax);
    const off = Math.min(Math.max(0, Math.trunc(Number(offset)) || 0), total);

    // stat ONLY the requested window — never the whole directory.
    const entries = await Promise.all(names.slice(off, off + lim).map(async (e) => {
      try {
        const s = await fsp.lstat(path.join(dir, e.name));
        return { name: e.name, type: e.type, size: s.isFile() ? s.size : null, mtime: s.mtimeMs };
      } catch (_) {
        return { name: e.name, type: e.type, size: null, mtime: null };   // unreadable row, not a failed page
      }
    }));

    const parent = dir === path.parse(dir).root ? null : path.dirname(dir);
    return { path: dir, parent, entries, total, offset: off, limit: lim };
  }

  async function read(rawPath) {
    const file = await _jail(rawPath);
    let st;
    try { st = await fsp.stat(file); } catch (e) { mapErrno(e); }
    if (st.isDirectory()) fail('not_a_dir');

    // HANG GUARD — must come before any read. /dev/zero, fifos, and sockets are stat-able but
    // reading them never returns, which would wedge the bridge and kill the terminal mirror too.
    if (!st.isFile()) return { kind: 'special', path: file, size: 0, mtime: st.mtimeMs };

    const base = { path: file, size: st.size, mtime: st.mtimeMs };
    const ext = path.extname(file).toLowerCase();

    if (IMAGE_EXT.has(ext)) {
      const dataUri = await imageDataUri(file);
      return dataUri ? { kind: 'image', ...base, dataUri } : { kind: 'binary', ...base };
    }

    const buf = await headBytes(file, readMax);
    if (looksBinary(buf)) return { kind: 'binary', ...base };
    return {
      kind: 'text',
      ...base,
      text: buf.toString('utf8'),
      lang: LANG_BY_EXT[ext] || '',
      truncated: st.size > readMax,
    };
  }

  // Byte-for-byte download of the ORIGINAL file: no transcode, no truncation, no FS_READ_MAX.
  // `read` exists to put a file on screen (bounded, HEIC downscaled through sips); this exists to
  // put it on the user's device, so a zip, a 2 GB video, or the untouched HEIC comes back exactly
  // as it sits on disk.
  //
  // Returns METADATA ONLY. `path` is the value the jail returned — already realpath'd and
  // root-checked — so a read stream opened on it cannot land outside a root, and the caller never
  // has to re-validate what the user typed.
  async function download(rawPath) {
    const file = await _jail(rawPath);
    let st;
    try { st = await fsp.stat(file); } catch (e) { mapErrno(e); }
    if (st.isDirectory()) fail('not_a_dir');
    // SAME HANG GUARD AS read(): a FIFO with no writer blocks forever inside open(), and a
    // character device has no end — either would wedge the bridge and take the terminal mirror
    // down with it. Only regular files are streamable.
    if (!st.isFile()) fail('not_a_file');
    return {
      path: file,
      name: path.basename(file) || 'download',
      size: st.size,
      mtime: st.mtimeMs,
      contentType: MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream',
    };
  }

  return { roots, list, read, download, _jail, _resolvedRoots };
}

module.exports = { createFsBrowse, parseRootsSpec, parseRange, contentDisposition, FsError };
