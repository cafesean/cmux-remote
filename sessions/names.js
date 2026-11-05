'use strict';
// p41 A16 — user-chosen session names, kept on the machine in ~/.cmux-remote/session-names.json (0600).
// Key = the transcript sessionId when the session has a Claude/Codex transcript (survives tab moves and
// account swaps), else the machine-local surface id. Value {name, setAt}. Read fresh (mtime-cached) so a
// bridge restart or a second process sees the same names; written atomically (tmp + rename).
const fs = require('fs');
const path = require('path');

const LIMITS = {
  nameMax: 80,          // longest name after trim; more -> 400
  nameKeyMax: 128,      // longest store key accepted
  nameEntriesMax: 500,  // entries in the store; a new key past this -> 409 names_full (clearing one frees a slot)
  nameFileMaxBytes: 256 * 1024,
};
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

// -> {name} | {error:'bad_name'}. Empty (after trim) means clear: {name:''}.
function validateName(raw, cfg) {
  const c = cfg || LIMITS;
  if (typeof raw !== 'string') return { error: 'bad_name' };
  const name = raw.trim();
  if (name.length > c.nameMax || CONTROL_RE.test(name)) return { error: 'bad_name' };
  return { name };
}

function createNameStore({ home, now, limits }) {
  const c = limits || LIMITS;
  const file = path.join(home, '.cmux-remote', 'session-names.json');
  const clock = now || Date.now;
  let cache = null;   // {mtimeMs, size, map}

  function load() {
    let st;
    try { st = fs.statSync(file); } catch (_) { cache = null; return {}; }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.map;
    let map = {};
    try {
      if (st.size <= c.nameFileMaxBytes) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          for (const [k, v] of Object.entries(j)) {
            if (k.length <= c.nameKeyMax && v && typeof v.name === 'string' && v.name) map[k] = { name: v.name, setAt: Number(v.setAt) || 0 };
          }
        }
      }
    } catch (_) { map = {}; }
    cache = { mtimeMs: st.mtimeMs, size: st.size, map };
    return map;
  }
  function save(map) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    cache = null;
  }
  const get = (key) => { const e = key ? load()[key] : null; return e ? e.name : ''; };
  // name '' clears. -> {ok:true, name} | {ok:false, error}
  function set(key, name) {
    if (typeof key !== 'string' || !key || key.length > c.nameKeyMax) return { ok: false, error: 'bad_key' };
    const map = { ...load() };
    if (!name) { delete map[key]; save(map); return { ok: true, name: '' }; }
    if (!map[key] && Object.keys(map).length >= c.nameEntriesMax) return { ok: false, error: 'names_full' };
    map[key] = { name, setAt: clock() };
    save(map);
    return { ok: true, name };
  }
  return { get, set, file };
}

module.exports = { createNameStore, validateName, LIMITS };
