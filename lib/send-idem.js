'use strict';
// p41 D121: idempotent /api/cmux/send. The app gives every message a sendId (a uuid, the SAME on
// each automatic and manual retry of that message). A send the bridge accepted (2xx) is remembered
// per machine + surface + sendId; a repeat answers the first result and never types the text again.
// Anything else (5xx, 4xx, a throw) is forgotten, so the retry really sends.
//
// Persisted (atomic tmp + rename, next to push.json) because the case that matters is a restart:
// the first attempt reached the bridge, the reply was lost to the restart / a tunnel blip, and the
// retry lands on a NEW server process. graceful.js drains in-flight requests on SIGTERM, so the
// result is written before exit. Residual risk: a hard crash between the bridge typing the text and
// the save (no record) -> that one retry sends twice.
// Only the id (machine, surface, sendId), time, status and the bridge's small reply are stored; never the text.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITS = {
  max: 500,              // remembered sends (oldest dropped first)
  ttlMs: 10 * 60 * 1000, // a sendId is remembered this long; the app stops retrying after ~15 s
  bodyMaxChars: 2000,    // a bigger bridge reply is not stored (the repeat then answers { ok: true })
};
const DEFAULT_FILE = require('./hm-home').statePath('send-ids.json', path.join(os.homedir(), '.local', 'share', 'cmux-remote', 'send-ids.json'));
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function validId(v) { return typeof v === 'string' && ID_RE.test(v); }
function idemId(machine, surface, id) { return `${machine}\u0000${surface}\u0000${id}`; }

function createSendIdem({ file = process.env.SEND_IDS_FILE || DEFAULT_FILE, max = LIMITS.max, ttlMs = LIMITS.ttlMs, now = Date.now, log = console } = {}) {
  const done = new Map();     // id -> { at, status, body }; insertion order = age
  const inflight = new Map(); // id -> Promise<{ status, body }>

  function prune() {
    const t = now();
    for (const [k, v] of done) if (t - v.at > ttlMs) done.delete(k);
    while (done.size > max) done.delete(done.keys().next().value);
  }
  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of (s && Array.isArray(s.ids) ? s.ids : [])) {
        if (e && typeof e.k === 'string' && Number.isFinite(e.at) && Number.isInteger(e.status)) done.set(e.k, { at: e.at, status: e.status, body: e.body });
      }
    } catch (_) { /* first run, or a broken file: start empty */ }
    prune();
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ids: [...done].map(([k, v]) => ({ k, ...v })) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log.error(`send-idem: save failed (${(e && e.code) || 'error'}); dedupe is in-memory until the next save`); }
  }
  load();

  // fn() -> Promise<{ status, body }> does the real send. Returns that, or the remembered result with duplicate: true.
  async function run(k, fn) {
    prune();
    const hit = done.get(k);
    if (hit) return { status: hit.status, body: hit.body === undefined ? { ok: true } : hit.body, duplicate: true };
    const pending = inflight.get(k);
    if (pending) {
      const r = await pending;   // the same message is still being sent: wait for it, never send twice
      return r.status >= 200 && r.status < 300 ? { ...r, duplicate: true } : r;
    }
    const mine = Promise.resolve().then(fn);
    inflight.set(k, mine);
    try {
      const r = await mine;
      if (r.status >= 200 && r.status < 300) {
        let body = r.body;
        try { if (JSON.stringify(body).length > LIMITS.bodyMaxChars) body = undefined; } catch (_) { body = undefined; }
        done.set(k, { at: now(), status: r.status, body });
        prune();
        save();
      }
      return r;
    } finally { inflight.delete(k); }
  }
  return { run, size: () => done.size };
}

module.exports = { createSendIdem, validId, idemId, LIMITS };
