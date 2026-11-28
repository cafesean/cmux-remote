'use strict';
// p46 C1 — a Codex rollout (.jsonl under ~/.codex/sessions) as the chat-thread messages the native app shows.
//
//   readThread(path, {before, limit = 80, fs, log}) -> Promise<{title, messages, cursor}>
//     Same contract as sessions/transcript-claude.js readThread: `cursor` is opaque, pass it back as
//     `before`; a cursor that does not parse, or whose message is not at the byte offset it names, throws
//     BadCursorError (code 'bad_cursor'). `endOffset` (non-enumerable) is where a tail should pick up.
//   tailThread(path, fromOffset, {signal, onReset, pollMs, fs, log}) -> AsyncIterable<Msg>
//     Offset-based like the Claude tail: appended records are read from `fromOffset` on; a file that
//     shrinks or is replaced (new inode) starts again from 0 and calls onReset.
//
// Msg and Tool are described in sessions/CONTRACT.md. Codex emits only `user`, `assistant` and `tools`.
// How a record becomes messages (shapes measured on rollouts written by Codex CLI 0.154-0.171):
//   - Every line is {timestamp, type, payload}. `session_meta` gives the title (basename of payload.cwd).
//   - event_msg item_completed (and item_started) carry payload.item:
//       UserMessage      {id, content: [{type:'text', text}]}  -> user
//       AgentMessage     {id, content: [{type:'Text', text}]}  -> assistant
//       CommandExecution {id, command: [argv], status, exit_code, aggregated_output} -> one Tool `shell`
//       Reasoning        -> hidden
//   - response_item function_call {call_id, name, arguments} + function_call_output {call_id, output},
//     paired by call_id -> one Tool. response_item message repeats the event_msg text and reasoning holds
//     encrypted_content: both are hidden and never read. custom_tool_call `exec` (+ output) is hidden too:
//     the commands it runs arrive as CommandExecution items, so each command is exactly one row.
//   - FileChange, McpToolCall and Extension items are skipped + warn-once in v1 (chief, p46).
//   - An old-format rollout (no payload envelope) reads as {title: '', messages: [], cursor: null,
//     unsupported: 'codex'}; its tail yields nothing.
//   - Consecutive tools are one `tools` message whose id is the first tool's id, so a running tool that
//     finishes is sent again under the same id. Tool ids are the rollout's call_id / item id.
//   - Any other record type or item type is skipped and counted; the first time this process meets a
//     given type it logs one warn line (type name only, never content).
const fs = require('fs');
const path = require('path');
const { BadCursorError } = require('./transcript-claude.js');

const CHUNK = 256 * 1024;
const SCAN_CHUNK = 1024 * 1024;
const HEAD_MAX = 4 * 1024 * 1024;   // session_meta (line 1) carries the base instructions; read at most this
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 500;
const OUTPUT_MAX = 2000;            // CONTRACT § Tool output cut, reused for Codex (LIMITS row owed, spec § 6)
const TARGET_MAX = 300;
const POLL_MS = 1000;
const NL = 10;

const REAL_FS = { open: (...a) => fs.promises.open(...a) };

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

// Records that are known and never thread content.
const HIDDEN_RECORDS = new Set(['session_meta', 'turn_context', 'token_usage_record', 'world_state', 'compacted']);
const HIDDEN_EVENTS = new Set(['token_count', 'task_started', 'task_complete', 'thread_settings_applied', 'turn_aborted']);
// custom_tool_call `exec` (+ its output) wraps the commands it runs; each command is its own
// CommandExecution item, so the exec call is never a row of its own (one command = one row).
const HIDDEN_RESPONSES = new Set(['message', 'reasoning', 'custom_tool_call', 'custom_tool_call_output']);
const HIDDEN_ITEMS = new Set(['Reasoning']);

// warn-once per type for the process lifetime.
const warned = new Set();
const safeType = (t) => (typeof t === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(t) ? t : '?');

// `[sh, -c|-lc, script]` -> the script; any other argv -> the words joined.
function commandTarget(cmd) {
  if (Array.isArray(cmd)) {
    const words = cmd.map((w) => String(w));
    if (words.length >= 3 && /^-l?c$/.test(words[1])) return short(words.slice(2).join(' '), TARGET_MAX);
    return short(words.join(' '), TARGET_MAX);
  }
  return short(cmd, TARGET_MAX);
}

function argsTarget(args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return short(a, TARGET_MAX); } }
  if (!a || typeof a !== 'object') return short(a, TARGET_MAX);
  if (a.command != null) return commandTarget(a.command);
  const v = a.path || a.file_path || a.url || a.query || a.cmd || a.prompt || '';
  return short(v, TARGET_MAX);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter(Boolean).join('\n');
}

// Records in file order in, messages out. `push` returns the messages new or changed by that record.
class Normaliser {
  constructor({ log } = {}) {
    this.log = log || ((m) => console.warn(m));
    this.out = [];
    this.offs = new Map();     // message id -> byte offset of its record
    this.tools = new Map();    // tool id -> {tool, group}
    this.group = null;
    this.title = '';
    this.lastTs = 0;
    this.skipped = new Map();  // unknown type -> count
  }

  skip(kind, type) {
    const key = `${kind}:${safeType(type)}`;
    this.skipped.set(key, (this.skipped.get(key) || 0) + 1);
    if (warned.has(key)) return;
    warned.add(key);
    this.log(`codex: skipped unknown rollout ${kind} type ${safeType(type)} (logged once)`);
  }

  ts(rec) {
    const parsed = Date.parse(rec.timestamp);
    if (!Number.isNaN(parsed)) this.lastTs = parsed;
    return this.lastTs;
  }

  add(msg, off, changed) {
    this.out.push(msg);
    this.offs.set(msg.id, off);
    this.group = null;
    changed.push(msg);
  }

  text(kind, id, ts, raw, off, changed) {
    const t = String(raw || '').trim();
    if (!t || this.offs.has(id)) return;
    this.add({ id, ts, kind, text: t }, off, changed);
  }

  // A new tool, or the finished copy of one already shown (same id).
  tool(tool, ts, off, changed) {
    const hit = this.tools.get(tool.id);
    if (hit) {
      Object.assign(hit.tool, tool);
      if (!changed.includes(hit.group)) changed.push(hit.group);
      return;
    }
    if (!this.group) {
      this.group = { id: tool.id, ts, kind: 'tools', items: [] };
      this.out.push(this.group);
      this.offs.set(tool.id, off);
    }
    this.group.items.push(tool);
    this.tools.set(tool.id, { tool, group: this.group });
    if (!changed.includes(this.group)) changed.push(this.group);
  }

  push({ off, rec }) {
    const changed = [];
    if (!rec || typeof rec !== 'object') return changed;
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : null;
    if (rec.type === 'session_meta') {
      if (p && typeof p.cwd === 'string' && p.cwd) this.title = path.basename(p.cwd);
      return changed;
    }
    if (HIDDEN_RECORDS.has(rec.type)) return changed;
    if (!p) { this.skip('record', rec.type || (rec.record_type && `record_type:${rec.record_type}`)); return changed; }
    if (rec.type === 'event_msg') this.event(off, rec, p, changed);
    else if (rec.type === 'response_item') this.response(off, rec, p, changed);
    else this.skip('record', rec.type);
    return changed;
  }

  event(off, rec, p, changed) {
    if (HIDDEN_EVENTS.has(p.type)) return;
    if (p.type !== 'item_completed' && p.type !== 'item_started') return this.skip('event', p.type);
    const it = p.item && typeof p.item === 'object' ? p.item : null;
    if (!it) return this.skip('event', p.type);
    const done = p.type === 'item_completed';
    const ts = this.ts(rec);
    const id = typeof it.id === 'string' && it.id ? it.id : `@${off}`;
    if (HIDDEN_ITEMS.has(it.type)) return;
    if (it.type === 'UserMessage') { if (done) this.text('user', id, ts, textOf(it.content), off, changed); return; }
    if (it.type === 'AgentMessage') { if (done) this.text('assistant', id, ts, textOf(it.content), off, changed); return; }
    if (it.type === 'CommandExecution') {
      const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
      const status = !done || it.status === 'in_progress' ? 'running' : failed ? 'error' : 'ok';
      const tool = { id, name: 'shell', target: commandTarget(it.command), status };
      if (status !== 'running') {
        const body = typeof it.aggregated_output === 'string' ? it.aggregated_output
          : [it.stdout, it.stderr].filter((s) => typeof s === 'string' && s).join('\n');
        tool.lines = body ? body.split('\n').length : 0;
        if (body) tool.output = body.slice(0, OUTPUT_MAX);
      }
      this.tool(tool, ts, off, changed);
      return;
    }
    this.skip('item', it.type);
  }

  response(off, rec, p, changed) {
    if (HIDDEN_RESPONSES.has(p.type)) return;
    if (p.type === 'function_call') {
      if (typeof p.call_id !== 'string' || !p.call_id) return this.skip('response', p.type);
      const hit = this.tools.get(p.call_id);
      if (hit) return;   // the same call written again: keep the shown copy and its result
      this.tool({ id: p.call_id, name: String(p.name || ''), target: argsTarget(p.arguments), status: 'running' }, this.ts(rec), off, changed);
      return;
    }
    if (p.type === 'function_call_output') {
      const hit = this.tools.get(p.call_id);
      if (!hit) return;
      const out = p.output;
      const body = typeof out === 'string' ? out : Array.isArray(out) ? textOf(out)
        : out && typeof out === 'object' ? textOf(out.content) : '';
      const failed = out && typeof out === 'object' && !Array.isArray(out) && out.success === false;
      hit.tool.status = failed ? 'error' : 'ok';
      hit.tool.lines = body ? body.split('\n').length : 0;
      if (body) hit.tool.output = body.slice(0, OUTPUT_MAX);
      if (!changed.includes(hit.group)) changed.push(hit.group);
      return;
    }
    this.skip('response', p.type);
  }
}

// Complete lines of buf (bytes at file offset base) as {off, rec}; a line that is not JSON is dropped.
function parseLines(buf, base) {
  const entries = [];
  let s = 0;
  while (s < buf.length) {
    let e = buf.indexOf(NL, s);
    if (e < 0) e = buf.length;
    if (e > s) {
      try {
        const rec = JSON.parse(buf.toString('utf8', s, e));
        if (rec && typeof rec === 'object') entries.push({ off: base + s, rec });
      } catch { /* half-written line */ }
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
    this.carry = Buffer.alloc(0);
    this.entries = [];
    this.completeEnd = null;
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

// The first line read alone, up to HEAD_MAX bytes -> the parsed record or null. It is session_meta (the
// title when the pages held none) in the current format.
async function headRecord(h, size) {
  let line = Buffer.alloc(0);
  for (let pos = 0; pos < Math.min(size, HEAD_MAX);) {
    const chunk = await readAt(h, pos, Math.min(CHUNK, size - pos));
    if (!chunk.length) break;
    pos += chunk.length;
    const nl = chunk.indexOf(NL);
    line = Buffer.concat([line, nl < 0 ? chunk : chunk.subarray(0, nl)]);
    if (nl >= 0) break;
  }
  const e = parseLines(line, 0)[0];
  return e ? e.rec : null;
}

// The old rollout format (Codex CLI before the {timestamp, type, payload} envelope: a bare first line
// {id, timestamp, instructions, git}, then record_type lines and bare response items) is not read:
// the thread answers `unsupported: 'codex'`, never an empty thread.
const isOldFormat = (head) => !!head && !(head.payload && typeof head.payload === 'object');

async function cursorRecord(h, size, { id, off }, log) {
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
  if (!entry || !new Normaliser({ log }).push(entry).some((m) => m.id === id)) throw new BadCursorError();
  return entry;
}

const clampLimit = (n) => Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(n)) || DEFAULT_LIMIT));

async function readThread(p, opts = {}) {
  const { before, chunkSize = CHUNK, log } = opts;
  const limit = clampLimit(opts.limit == null ? DEFAULT_LIMIT : opts.limit);
  const h = await (opts.fs || REAL_FS).open(p, 'r');
  try {
    const { size } = await h.stat();
    const head = await headRecord(h, size);
    if (isOldFormat(head)) {
      const thread = { title: '', messages: [], cursor: null, unsupported: 'codex' };
      Object.defineProperty(thread, 'endOffset', { value: size, enumerable: false });
      return thread;
    }
    let end = size;
    let cursorEntry = null;
    let cursorId = null;
    if (before != null) {
      const c = decodeCursor(before);
      cursorId = c.id;
      cursorEntry = await cursorRecord(h, size, c, log);
      end = c.off;
    }
    const br = new BackReader(h, end, chunkSize);
    let norm;
    let older;
    for (;;) {
      const more = await br.older();
      norm = new Normaliser({ log });
      for (const e of br.entries) norm.push(e);
      if (cursorEntry) norm.push(cursorEntry);
      const edge = cursorId == null ? norm.out.length : norm.out.findIndex((m) => m.id === cursorId);
      older = edge < 0 ? [] : norm.out.slice(0, edge);
      if (!more || older.length > limit) break;
    }
    const messages = older.slice(-limit);
    const hasOlder = older.length > limit;
    let title = norm.title;
    if (!title && head && head.type === 'session_meta') {
      const hn = new Normaliser({ log });
      hn.push({ off: 0, rec: head });
      title = hn.title;
    }
    const cursor = hasOlder ? encodeCursor(messages[0].id, norm.offs.get(messages[0].id)) : null;
    const thread = { title, messages, cursor };
    Object.defineProperty(thread, 'endOffset', { value: br.completeEnd == null ? size : br.completeEnd, enumerable: false });
    Object.defineProperty(thread, 'skipped', { value: Object.fromEntries(norm.skipped), enumerable: false });
    return thread;
  } finally {
    await h.close();
  }
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
  const { signal, onReset, pollMs = POLL_MS, log } = opts;
  const fsx = opts.fs || REAL_FS;
  const w = waiter(p, signal, pollMs);
  let norm = null;
  let offset = fromOffset;
  let ino = null;
  let carry = Buffer.alloc(0);

  // Feed the 256 KB before `at` without yielding, so an output that arrives now finds its call.
  const warm = async (h, at) => {
    norm = new Normaliser({ log });
    carry = Buffer.alloc(0);
    if (at <= 0) return;
    const br = new BackReader(h, at, CHUNK);
    await br.older();
    for (const e of br.entries) norm.push(e);
  };

  try {
    while (!(signal && signal.aborted)) {
      let h = null;
      try {
        try { h = await fsx.open(p, 'r'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (h) {
          const st = await h.stat();
          if (st.ino !== ino && isOldFormat(await headRecord(h, st.size))) return;   // old format: nothing to tail
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
            for (const m of changed) yield JSON.parse(JSON.stringify(m));
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

module.exports = { readThread, tailThread, BadCursorError, OUTPUT_MAX };
