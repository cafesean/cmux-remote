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
};
