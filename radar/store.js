'use strict';
// The ONE write path for every file radar owns (~/.radar/*). Two invariants live here:
//
//  1. ATOMICITY — every file lands by temp+rename. A reader (CLI, server, an external consumer) either sees the
//     whole previous file or the whole new one, never a half-written snapshot.
//  2. SERIALIZATION — every mutation of state.json / aliases.json / decisions.json goes through one
//     in-process queue, including the P1 CLI's. Two `radar tag` calls racing a scan cannot
//     read-modify-write over each other, because there is only ever one writer running.
//
// Radar writes NOTHING outside the directory these helpers are pointed at. No git mutation, no
// Jira PUT, no DB, no deploy. That is the whole security model of the tool.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const defaultRadarDir = () => path.join(os.homedir(), '.radar');

// ---- the write queue -------------------------------------------------------------------------
// A single promise chain. `.then(fn, fn)` (not `.then(fn)`) so a rejected predecessor still lets
// the next mutation run — one bad write must not wedge the queue for the process lifetime.
let chain = Promise.resolve();
let depth = 0;

function enqueue(fn) {
  depth++;
  const run = () => Promise.resolve().then(fn).finally(() => { depth--; });
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

const queueDepth = () => depth;
// Tests and shutdown paths need "all queued writes have landed".
const drain = () => chain.then(() => {}, () => {});

// ---- atomic primitives -----------------------------------------------------------------------
let tmpSeq = 0;

async function writeJsonAtomicUnqueued(file, value) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`);
  const body = JSON.stringify(value, null, 2) + '\n';
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, file);           // atomic within a filesystem
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) { /* nothing to clean */ }
    throw e;
  }
  return body.length;
}

// Publication. Rejects on failure so the caller can apply the whole-file last-good rule: when the
// atomic publication ITSELF fails, the previous state.json is still on disk, untouched.
const writeJsonAtomic = (file, value) => enqueue(() => writeJsonAtomicUnqueued(file, value));

// ---- text + append primitives (p6 §4.8) --------------------------------------------------------
// The seed is Markdown. writeJsonAtomic CANNOT write it: it JSON-quotes the string, so the file
// would gain surrounding quotes and escaped newlines and stop being the seed. Hence a text pair
// beside the JSON pair, with the same queued/unqueued split.
async function writeTextAtomicUnqueued(file, text) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`);
  try {
    await fsp.writeFile(tmp, text, 'utf8');   // byte-exact: no JSON quoting, no trailing newline added
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) { /* nothing to clean */ }
    throw e;
  }
  return Buffer.byteLength(text, 'utf8');
}

const writeTextAtomic = (file, text) => enqueue(() => writeTextAtomicUnqueued(file, text));

// One record is one line, always: JSON escapes every newline, so the serialisation can never
// contain a raw one.
const LINE_MAX = 131072;

// UNQUEUED — the caller already owns a queue slot. `commit` holds one and appends several records,
// and `enqueue` is NOT re-entrant (chain = p.then(...) where p is the running slot), so a nested
// enqueue would await its own caller forever. That is why this pair exists at all.
async function appendLineUnqueued(file, obj) {
  const line = JSON.stringify(obj) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > LINE_MAX) {
    throw Object.assign(new RangeError(`ledger line ${bytes} > LINE_MAX ${LINE_MAX}`), { code: 'ERR_LINE_TOO_LONG' });
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fd = await fsp.open(file, 'a');
  try {
    const { bytesWritten } = await fd.write(line, null, 'utf8');
    // A short write leaves a truncated tail that a later append would fuse onto. Refuse it here
    // rather than detect it at startup. NOTE: bytesWritten bytes may already be on disk — this
    // throws, it does not roll back, and the startup tail repair handles the remains.
    if (bytesWritten !== bytes) {
      throw Object.assign(new Error(`short write: ${bytesWritten}/${bytes}`), { code: 'EIO' });
    }
    // Durable BEFORE we return, because callers act on that: §M4 appends `recovery-op` and then
    // sends signals it cannot un-send. The record must survive a crash one millisecond later.
    await fd.sync();
  } finally {
    await fd.close();
  }
  return bytes;
}

const appendLine = (file, obj) => enqueue(() => appendLineUnqueued(file, obj));

// Never throws. A missing or corrupt radar file is a degraded source, not a crash.
async function readJson(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: fallback, missing: true, error: null };
    return { ok: false, value: fallback, missing: false, error: `read ${path.basename(file)}: ${e.message}` };
  }
  try {
    const value = JSON.parse(text);
    return { ok: true, value, missing: false, error: null };
  } catch (e) {
    return { ok: false, value: fallback, missing: false, error: `parse ${path.basename(file)}: ${e.message}` };
  }
}

function readJsonSync(file, fallback) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: fallback, missing: true, error: null };
    return { ok: false, value: fallback, missing: false, error: `${path.basename(file)}: ${e.message}` };
  }
}

// Queued read-modify-write. The read happens INSIDE the queue slot, which is the point: reading
// outside it would reintroduce the lost-update race the queue exists to remove.
function updateJson(file, fallback, mutate) {
  return enqueue(async () => {
    const cur = await readJson(file, fallback);
    // A corrupt file is not silently overwritten — the caller decides, and the default is to refuse.
    if (!cur.ok) throw new Error(cur.error);
    const next = await mutate(cur.value === undefined ? fallback : cur.value);
    if (next === undefined) return cur.value;      // mutate opted out
    await writeJsonAtomicUnqueued(file, next);
    return next;
  });
}

module.exports = {
  defaultRadarDir,
  enqueue, drain, queueDepth,
  writeJsonAtomic, writeJsonAtomicUnqueued,
  readJson, readJsonSync, updateJson,
  // p6 §4.8 — exactly four additions, in the two queued/unqueued pairs. LINE_MAX is deliberately
  // NOT exported: the spec fixes it at 131072, so a test asserts that literal rather than
  // re-deriving the contract from the implementation.
  appendLine, appendLineUnqueued,
  writeTextAtomic, writeTextAtomicUnqueued,
};
