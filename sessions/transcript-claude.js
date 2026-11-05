'use strict';
// p41 A2 — a Claude Code transcript (.jsonl) as the chat-thread messages the native app shows.
//
//   readThread(path, {before, limit = 80, sessionId, bannerPreset, fs}) -> Promise<{title, messages, cursor}>
//     `cursor` is opaque: pass it back as `before`. A cursor that does not parse, or whose message is not at
//     the byte offset it names, throws BadCursorError (code 'bad_cursor'); the route maps it to 400.
//   tailThread(path, fromOffset, {signal, onReset, sessionId, bannerPreset, pollMs}) -> AsyncIterable<Msg>
//   readAttachment(path, n, {fs}) -> Promise<{mime, data: Buffer} | null>
//   readThread/tailThread also take `uploadRoot` (D57: an image path typed inside it is an `attachment`
//   served by /upload/:rel, sessions/uploads.js), `sidechain: true` (a sub-agent transcript: its isSidechain rows are shown)
//   and `agentIdFor(toolUseId)` (an Agent/Task Tool then carries `agentId`, A10).
//
// Msg, Tool and the page cursor are described in sessions/CONTRACT.md. How a record becomes messages
// (rules from the render spike):
//   - a user row that is meta, a sidechain row, or text that starts with `<` (a system tag) or with
//     `Base directory for this skill` is not shown; tool_result rows only complete a tool.
//   - tool_use and tool_result pair by id into one Tool; consecutive tools are one `tools` message whose
//     id is the first tool's id, so a running tool that finishes is sent again under the same id.
//   - D55: a message typed while a turn runs is not a user row: Claude Code writes it as an `attachment`
//     record ({attachment: {type: 'queued_command', prompt, origin: {kind: 'human'}}}) plus queue-operation
//     rows. The attachment is a `user` message at its place; queue-operation rows are never read, and a
//     queued_command from a peer session, a task notification or marked isMeta is not shown. A user row
//     that repeats the queued text right after it (nothing in between) is the same message, shown once.
//   - AskUserQuestion is a `question`, TodoWrite a `todo`, a base64 image an `attachment`.
//   - ids are `<record uuid>:<content index>`, so reading the file again gives the same ids.
//
// Pages are read backwards from the end of the file in 256 KB chunks; the whole file is never read. A
// page ends on a whole message: reading goes on until one more message than the page is in hand, so a
// `tools` group is never cut by the page edge. The one cost of that is the attachment number: `n` in the
// url counts images from the start of the file, so a page that holds an image scans the bytes before it
// (only lines that mention an image are parsed).
//
// Assistant text runs through parseCallouts (callouts.js): each callout becomes a `callout` message after
// the assistant text that is left. Sean's █ banner is lifted as a needs-you callout while `bannerPreset` is
// on (the default).
const fs = require('fs');
const { splitCallouts } = require('./callouts.js');

const CHUNK = 256 * 1024;
const SCAN_CHUNK = 1024 * 1024;
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 500;
const OUTPUT_MAX = 2000;
const TARGET_MAX = 300;
const POLL_MS = 1000;
const IMAGE_MARK = Buffer.from('"type":"image"');
const NL = 10;

// A Claude Code sub-agent id (A10): `a` + hex, or a named teammate `a<name>-<16 hex>`. Never `.`, `/`, `\\`.
// The one definition: sessions/subagents.js and lib/sessions-proxy.js use this.
const AGENT_ID_RE = /^a[A-Za-z0-9][A-Za-z0-9-]{4,78}$/;

const REAL_FS = { open: (...a) => fs.promises.open(...a) };

// The page cursor names the oldest message of a page and where its record starts in the file, so the
// next page seeks straight there and never has to find the message by reading back from the end.
class BadCursorError extends Error {
  constructor(msg) { super(msg || 'bad cursor'); this.name = 'BadCursorError'; this.code = 'bad_cursor'; this.status = 400; }
}
const encodeCursor = (id, off) => Buffer.from(`${id}|${off}`).toString('base64url');
function decodeCursor(c) {
  if (typeof c !== 'string' || !c || !/^[A-Za-z0-9_-]+$/.test(c)) throw new BadCursorError();
  const raw = Buffer.from(c, 'base64url').toString('utf8');
  const bar = raw.lastIndexOf('|');
  const off = raw.slice(bar + 1);
  if (bar <= 0 || !/^\d{1,15}$/.test(off)) throw new BadCursorError();
  return { id: raw.slice(0, bar), off: Number(off) };
}

const short = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function toolTarget(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.pattern) return short(i.pattern + (i.path ? ` ${i.path}` : ''), TARGET_MAX);
  const v = i.file_path || i.notebook_path || i.path || i.command || i.url || i.query || i.skill || i.description || i.prompt || '';
  return short(v, TARGET_MAX);
}

function resultText(content) {
  if (Array.isArray(content)) return content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return String(content == null ? '' : content);
}

// D55: only the human's own queued prompts; peer messages and task notifications are queued the same way.
const isQueuedHuman = (a) => !!a && a.type === 'queued_command' && typeof a.prompt === 'string' && !a.isMeta &&
  (a.commandMode == null || a.commandMode === 'prompt') && !!a.origin && a.origin.kind === 'human';

const isSkippedText = (t) => !t.trim() || t.startsWith('<') || t.startsWith('Base directory for this skill');

// Image blocks that count as attachments, in order. One rule for the reader, the tail and the scans.
function imagesIn(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isSidechain) return [];
  const c = rec.message && rec.message.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string');
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const { splitUploadImages, uploadUrl } = require('./uploads');
const attachmentUrl = (sessionId, n) => `/api/sessions/${encodeURIComponent(sessionId)}/attachment/${n}`;

// Records in file order in, messages out. `push` returns the messages that are new or changed by that
// record (a tools group that gained a tool or a result), which is exactly what a live stream sends.
class Normaliser {
  constructor({ bannerPreset = true, sidechain = false, agentIdFor = null, uploadRoot = null } = {}) {
    this.bannerPreset = bannerPreset;
    this.uploadRoot = uploadRoot;   // D57: image paths typed inside this directory are shown as images
    this.sidechain = sidechain;     // a sub-agent's own transcript: every row is a sidechain row
    this.agentIdFor = agentIdFor;   // toolUseId -> sub-agent id (A10), for Agent/Task rows
    this.out = [];
    this.offs = new Map();   // message id -> byte offset of its record
    this.rels = new Map();   // attachment message id -> index among the images this normaliser saw
    this.tools = new Map();  // tool id -> {tool, group}
    this.group = null;
    this.rel = 0;
    this.title = '';
    this.lastTs = 0;
    this.queuedText = null;  // D55: the queued message just shown, until anything else is shown
  }

  add(msg, off, changed) {
    this.queuedText = null;
    this.out.push(msg);
    this.offs.set(msg.id, off);
    this.group = null;
    changed.push(msg);
  }

  text(kind, id, ts, raw, off, changed) {
    if (isSkippedText(raw)) return;
    this.add({ id, ts, kind, text: raw.trim() }, off, changed);
  }

  // D57: a human message; an uploaded image's path token becomes an attachment after the text.
  userText(id, ts, raw, off, changed) {
    if (isSkippedText(raw)) return;
    const { text, images } = this.uploadRoot ? splitUploadImages(raw, this.uploadRoot) : { text: raw, images: [] };
    if (!images.length) return this.text('user', id, ts, raw, off, changed);
    if (text.trim()) this.text('user', id, ts, text, off, changed);
    images.forEach((im, k) => {
      const msg = { id: `${id}:img:${k}`, ts, kind: 'attachment', attachment: { mime: im.mime, name: im.name, url: '' } };
      Object.defineProperty(msg, 'upload', { value: im.rel, enumerable: false });
      this.add(msg, off, changed);
    });
  }

  push({ off, rec }) {
    const changed = [];
    if (rec.type === 'custom-title') {
      if (typeof rec.customTitle === 'string') this.title = rec.customTitle;
      return changed;
    }
    if (rec.isSidechain && !this.sidechain) return changed;
    if (rec.type === 'attachment') { this.queued(off, rec, changed); return changed; }
    if (rec.type !== 'user' && rec.type !== 'assistant') return changed;
    const parsed = Date.parse(rec.timestamp);
    const ts = Number.isNaN(parsed) ? this.lastTs : parsed;
    this.lastTs = ts;
    const uuid = rec.uuid || `@${off}`;
    let content = rec.message && rec.message.content;
    if (typeof content === 'string') content = [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return changed;
    if (rec.type === 'user' && rec.isMeta) return changed;

    content.forEach((b, i) => {
      if (!b || typeof b !== 'object') return;
      const id = `${uuid}:${i}`;
      if (rec.type === 'assistant') {
        if (b.type === 'text' && typeof b.text === 'string') this.assistantText(id, ts, b.text, off, changed, rec);
        else if (b.type === 'tool_use') this.toolUse(id, ts, b, off, changed);
      } else if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.startsWith('<')) return;
        if (this.queuedText != null && b.text.trim() === this.queuedText) { this.queuedText = null; return; }
        this.userText(id, ts, b.text, off, changed);
      } else if (b.type === 'image') {
        if (imagesIn({ type: 'user', message: { content: [b] } }).length) {
          const mime = b.source.media_type || 'image/png';
          const msg = { id, ts, kind: 'attachment', attachment: { mime, name: `image.${EXT[mime] || 'bin'}`, url: '' } };
          this.rels.set(id, this.rel++);
          this.add(msg, off, changed);
        }
      } else if (b.type === 'tool_result') {
        this.toolResult(b, changed, rec);
      }
    });
    return changed;
  }

  // D55: a human message queued while a turn ran (Claude Code's queued_command attachment).
  queued(off, rec, changed) {
    const a = rec.attachment;
    if (!isQueuedHuman(a)) return;
    const parsed = Date.parse(rec.timestamp || a.timestamp);
    const ts = Number.isNaN(parsed) ? this.lastTs : parsed;
    this.lastTs = ts;
    const raw = a.prompt.replace(/\uFFFC/g, '');
    if (isSkippedText(raw)) return;
    this.userText(`${rec.uuid || `@${off}`}:0`, ts, raw, off, changed);
    this.queuedText = raw.trim();
  }

  assistantText(id, ts, raw, off, changed, rec) {
    if (!raw.trim()) return;
    const { text, callouts } = splitCallouts(raw, { seanBanner: this.bannerPreset });
    if (text.trim()) {
      const msg = { id, ts, kind: 'assistant', text: text.trim() };
      // p41 S2d: Claude Code's own API-error entry (isApiErrorMessage / error code), kept for the
      // bridge's Session.accountError. NON-enumerable: the Thread wire shape does not change.
      if (rec && (rec.isApiErrorMessage === true || (typeof rec.error === 'string' && rec.error))) {
        Object.defineProperty(msg, 'apiError', { value: { code: typeof rec.error === 'string' ? rec.error : null }, enumerable: false });
      }
      this.add(msg, off, changed);
    }
    callouts.forEach((callout, i) => this.add({ id: `${id}:callout:${i}`, ts, kind: 'callout', callout }, off, changed));
  }

  toolUse(id, ts, b, off, changed) {
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    if (b.name === 'TodoWrite') {
      const todos = (Array.isArray(input.todos) ? input.todos : [])
        .map((t) => ({ text: String(t.content || t.activeForm || ''), done: t.status === 'completed' }));
      this.add({ id, ts, kind: 'todo', todos }, off, changed);
      return;
    }
    if (b.name === 'AskUserQuestion') {
      (Array.isArray(input.questions) ? input.questions : []).forEach((q, k) => {
        this.add({ id: k ? `${id}:${k}` : id, ts, kind: 'question', question: {
          header: String(q.header || ''), text: String(q.question || ''), multi: !!q.multiSelect,
          options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
        } }, off, changed);
      });
      return;
    }
    if (!this.group) {
      this.queuedText = null;
      this.group = { id, ts, kind: 'tools', items: [] };
      this.out.push(this.group);
      this.offs.set(id, off);
    }
    const tool = { id: b.id || id, name: String(b.name || ''), target: toolTarget(b.name, input), status: 'running' };
    this.linkAgent(tool, null);
    this.group.items.push(tool);
    this.tools.set(tool.id, { tool, group: this.group });
    if (!changed.includes(this.group)) changed.push(this.group);
  }

  // Agent/Task rows carry the sub-agent's id: the record's own toolUseResult.agentId, else the meta map.
  linkAgent(tool, rec) {
    if (tool.agentId || (tool.name !== 'Agent' && tool.name !== 'Task')) return;
    const tr = rec && rec.toolUseResult;
    let a = tr && typeof tr === 'object' && typeof tr.agentId === 'string' ? tr.agentId : null;
    if (!a && this.agentIdFor) { try { a = this.agentIdFor(tool.id); } catch (_) { a = null; } }
    if (typeof a === 'string' && AGENT_ID_RE.test(a)) tool.agentId = a;
  }

  toolResult(b, changed, rec) {
    const hit = this.tools.get(b.tool_use_id);
    if (!hit) return;
    this.linkAgent(hit.tool, rec);
    const body = resultText(b.content);
    hit.tool.status = b.is_error ? 'error' : 'ok';
    hit.tool.lines = body ? body.split('\n').length : 0;
    if (body) hit.tool.output = body.slice(0, OUTPUT_MAX);
    if (!changed.includes(hit.group)) changed.push(hit.group);
  }

  // Number and name an attachment once the count of images before this window is known.
  numberAttachment(msg, base, sessionId) {
    if (msg.upload) { msg.attachment.url = uploadUrl(sessionId, msg.upload); return; }   // D57
    const n = base + this.rels.get(msg.id);
    msg.attachment.url = attachmentUrl(sessionId, n);
    msg.attachment.name = `image-${n + 1}.${EXT[msg.attachment.mime] || 'bin'}`;
  }
}

// Complete lines of buf (bytes starting at file offset base) as {off, rec}. Lines that are not JSON, and
// record types the thread never uses, are dropped. The text after the last newline counts as a line: a
// torn one fails to parse and is skipped.
function parseLines(buf, base) {
  const entries = [];
  let s = 0;
  while (s < buf.length) {
    let e = buf.indexOf(NL, s);
    if (e < 0) e = buf.length;
    if (e > s) {
      try {
        const rec = JSON.parse(buf.toString('utf8', s, e));
        if (rec && (rec.type === 'user' || rec.type === 'assistant' || rec.type === 'custom-title' ||
          (rec.type === 'attachment' && isQueuedHuman(rec.attachment)))) entries.push({ off: base + s, rec });
      } catch { /* half-written or foreign line */ }
    }
    s = e + 1;
  }
  return entries;
}

async function readAt(h, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await h.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got < len ? buf.subarray(0, got) : buf;
}

// Reads a file backwards, one chunk per `older()`; `entries` is always whole records in file order.
class BackReader {
  constructor(h, end, chunkSize) {
    this.h = h;
    this.pos = end;
    this.chunkSize = chunkSize;
    this.carry = Buffer.alloc(0);   // the partial line at the front of what has been read
    this.entries = [];
    this.completeEnd = null;        // end of the last whole line, known after the first chunk
  }

  async older() {
    if (this.pos <= 0) return false;
    const start = Math.max(0, this.pos - this.chunkSize);
    const chunk = await readAt(this.h, start, this.pos - start);
    if (this.completeEnd == null) {
      const nl = chunk.lastIndexOf(NL);
      if (nl >= 0) this.completeEnd = start + nl + 1;
    }
    const buf = Buffer.concat([chunk, this.carry]);
    let cut = 0;
    if (start > 0) {
      cut = buf.indexOf(NL);
      if (cut < 0) { this.carry = buf; this.pos = start; return true; }
      cut += 1;
    }
    this.entries = parseLines(buf.subarray(cut), start + cut).concat(this.entries);
    this.carry = buf.subarray(0, cut);
    this.pos = start;
    return true;
  }
}

// Calls fn(line Buffer, offset) for every whole line in [0, end) of the file, front to back.
// `start` (default 0) shifts the read: offsets passed to fn stay relative to `start`.
async function eachLine(h, end, fn, start = 0) {
  let carry = Buffer.alloc(0);
  let pos = 0;
  while (pos < end) {
    const chunk = await readAt(h, start + pos, Math.min(SCAN_CHUNK, end - pos));
    if (!chunk.length) break;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = pos - carry.length;
    pos += chunk.length;
    let s = 0;
    for (;;) {
      const e = buf.indexOf(NL, s);
      if (e < 0) break;
      if (fn(buf.subarray(s, e), base + s) === false) return;
      s = e + 1;
    }
    carry = buf.subarray(s);
  }
  if (carry.length && fn(carry, pos - carry.length) === false) return;
}

// Only lines that mention an image are parsed.
async function eachImage(h, end, fn) {
  await eachLine(h, end, (line) => {
    if (line.indexOf(IMAGE_MARK) < 0) return true;
    let rec;
    try { rec = JSON.parse(line.toString('utf8')); } catch { return true; }
    for (const b of imagesIn(rec)) if (fn(b) === false) return false;
    return true;
  });
}

async function countImages(h, end) {
  let n = 0;
  await eachImage(h, end, () => { n++; });
  return n;
}

async function readAttachment(p, n, opts = {}) {
  const h = await (opts.fs || REAL_FS).open(p, 'r');
  try {
    const { size } = await h.stat();
    let i = 0;
    let found = null;
    await eachImage(h, size, (b) => {
      if (i++ === n) { found = { mime: b.source.media_type || 'image/png', data: Buffer.from(b.source.data, 'base64') }; return false; }
      return true;
    });
    return found;
  } finally {
    await h.close();
  }
}

// D57 M1: the upload rels this transcript's HUMAN messages reference, by the same Normaliser rule the
// thread uses (user text + queued prompts; never assistant/tool output). Scans [from, size); `end` is
// the end of the last whole line, so a caller can resume an append-only file from there. Only lines
// that mention the upload root's path are parsed (a root holding a JSON-escaped character: all lines).
async function uploadRefs(p, opts = {}) {
  const { uploadRoot = null, from = 0 } = opts;
  const rels = new Set();
  const h = await (opts.fs || REAL_FS).open(p, 'r');
  try {
    const { size } = await h.stat();
    if (!uploadRoot || from > size) return { rels, end: from > size ? 0 : from, size };
    const mark = /["\\\u0000-\u001f]/.test(uploadRoot) ? null : Buffer.from(uploadRoot);
    let end = from;
    await eachLine(h, size - from, (line, off) => {
      const at = from + off;
      if (at + line.length < size) end = at + line.length + 1;
      if (mark && line.indexOf(mark) < 0) return true;
      for (const { rec } of parseLines(line, at)) {
        for (const m of new Normaliser({ uploadRoot }).push({ off: at, rec })) if (m.upload) rels.add(m.upload);
      }
      return true;
    }, from);
    return { rels, end, size };
  } finally {
    await h.close();
  }
}

// The last custom-title in the first chunk: used when the pages read from the end held none.
async function headTitle(h, size, chunkSize) {
  const buf = await readAt(h, 0, Math.min(size, chunkSize));
  const end = buf.length < size ? buf.lastIndexOf(NL) + 1 : buf.length;
  let title = '';
  for (const { rec } of parseLines(buf.subarray(0, end), 0)) if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') title = rec.customTitle;
  return title;
}

// The record a cursor points at, read alone: it must start a line and must hold the cursor's message.
async function cursorRecord(h, size, { id, off }, bannerPreset, sidechain, uploadRoot) {
  if (off >= size || (off > 0 && (await readAt(h, off - 1, 1))[0] !== NL)) throw new BadCursorError();
  let line = Buffer.alloc(0);
  for (let pos = off; pos < size;) {
    const chunk = await readAt(h, pos, Math.min(CHUNK, size - pos));
    if (!chunk.length) break;
    pos += chunk.length;
    const nl = chunk.indexOf(NL);
    line = Buffer.concat([line, nl < 0 ? chunk : chunk.subarray(0, nl)]);
    if (nl >= 0) break;
  }
  const entry = parseLines(line, off)[0];
  if (!entry || !new Normaliser({ bannerPreset, sidechain, uploadRoot }).push(entry).some((m) => m.id === id)) throw new BadCursorError();
  return entry;
}

const clampLimit = (n) => Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(n)) || DEFAULT_LIMIT));

async function readThread(p, opts = {}) {
  const { before, sessionId = '', bannerPreset = true, chunkSize = CHUNK, sidechain = false, agentIdFor = null, uploadRoot = null } = opts;
  const limit = clampLimit(opts.limit == null ? DEFAULT_LIMIT : opts.limit);
  const h = await (opts.fs || REAL_FS).open(p, 'r');
  try {
    const { size } = await h.stat();
    let end = size;
    let cursorEntry = null;
    let cursorId = null;
    if (before != null) {
      const c = decodeCursor(before);
      cursorId = c.id;
      cursorEntry = await cursorRecord(h, size, c, bannerPreset, sidechain, uploadRoot);
      end = c.off;
    }
    const br = new BackReader(h, end, chunkSize);
    let norm;
    let older;   // the messages older than the page edge
    for (;;) {
      const more = await br.older();
      norm = new Normaliser({ bannerPreset, sidechain, agentIdFor, uploadRoot });
      for (const e of br.entries) norm.push(e);
      if (cursorEntry) norm.push(cursorEntry);
      const edge = cursorId == null ? norm.out.length : norm.out.findIndex((m) => m.id === cursorId);
      older = edge < 0 ? [] : norm.out.slice(0, edge);
      if (!more || older.length > limit) break;
    }
    const finished = br.pos <= 0;
    const messages = older.slice(-limit);
    const hasOlder = older.length > limit;

    if (messages.some((m) => m.kind === 'attachment')) {
      const base = await countImages(h, br.entries.length ? br.entries[0].off : end);
      for (const m of messages) if (m.kind === 'attachment') norm.numberAttachment(m, base, sessionId);
    }
    let title = norm.title;
    if (!title && !finished) title = await headTitle(h, size, chunkSize);
    const cursor = hasOlder ? encodeCursor(messages[0].id, norm.offs.get(messages[0].id)) : null;
    return withEnd({ title, messages, cursor }, br, size);
  } finally {
    await h.close();
  }
}

// Where a tail should pick up: the end of the last whole line read. Not part of the JSON reply.
function withEnd(thread, br, size) {
  Object.defineProperty(thread, 'endOffset', { value: br.completeEnd == null ? size : br.completeEnd, enumerable: false });
  return thread;
}

function waiter(p, signal, pollMs) {
  let dirty = false;
  let wake = null;
  let watcher = null;
  try {
    watcher = fs.watch(p, () => { dirty = true; if (wake) wake(); });
    watcher.on('error', () => {});
  } catch { /* poll only */ }
  return {
    wait() {
      if (dirty || (signal && signal.aborted)) { dirty = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); wake = null; dirty = false; resolve(); };
        const timer = setTimeout(done, pollMs);
        wake = done;
        if (signal) signal.addEventListener('abort', done, { once: true });
      });
    },
    close() { if (watcher) watcher.close(); },
  };
}

async function* tailThread(p, fromOffset, opts = {}) {
  const { signal, onReset, sessionId = '', bannerPreset = true, pollMs = POLL_MS, sidechain = false, agentIdFor = null, uploadRoot = null } = opts;
  const fsx = opts.fs || REAL_FS;
  const w = waiter(p, signal, pollMs);
  let norm = null;
  let base = null;        // images before the first record this normaliser saw
  let windowStart = 0;
  let offset = fromOffset;
  let ino = null;
  let carry = Buffer.alloc(0);

  // Feed the 256 KB before `at` without yielding, so a result that arrives now finds its tool.
  const warm = async (h, at) => {
    norm = new Normaliser({ bannerPreset, sidechain, agentIdFor, uploadRoot });
    base = null;
    carry = Buffer.alloc(0);
    if (at <= 0) { windowStart = 0; base = 0; return; }
    const br = new BackReader(h, at, CHUNK);
    await br.older();
    for (const e of br.entries) norm.push(e);
    windowStart = br.entries.length ? br.entries[0].off : at;
  };

  try {
    while (!(signal && signal.aborted)) {
      let h = null;
      try {
        try { h = await fsx.open(p, 'r'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (h) {
          const st = await h.stat();
          if (offset == null) offset = st.size;
          const rotated = ino != null && st.ino !== ino;
          ino = st.ino;
          if (!norm) await warm(h, Math.min(offset, st.size));
          if (rotated || st.size < offset) {
            offset = 0;
            await warm(h, 0);
            if (onReset) onReset();
          }
          while (offset < st.size) {
            const chunk = await readAt(h, offset, Math.min(SCAN_CHUNK, st.size - offset));
            if (!chunk.length) break;
            const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            const lineBase = offset - carry.length;
            offset += chunk.length;
            const lastNl = buf.lastIndexOf(NL);
            if (lastNl < 0) { carry = buf; continue; }
            carry = buf.subarray(lastNl + 1);
            const changed = [];
            for (const e of parseLines(buf.subarray(0, lastNl + 1), lineBase)) {
              for (const m of norm.push(e)) if (!changed.includes(m)) changed.push(m);
            }
            if (changed.some((m) => m.kind === 'attachment') && base == null) base = await countImages(h, windowStart);
            for (const m of changed) {
              if (m.kind === 'attachment') norm.numberAttachment(m, base, sessionId);
              yield JSON.parse(JSON.stringify(m));
            }
          }
          // The partial last line is read again once it has its newline.
          offset -= carry.length;
          carry = Buffer.alloc(0);
        }
      } finally {
        if (h) await h.close();
      }
      await w.wait();
    }
  } finally {
    w.close();
  }
}

module.exports = { readThread, tailThread, readAttachment, uploadRefs, BadCursorError, AGENT_ID_RE };
