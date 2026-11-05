'use strict';
// p41 S2p — private surfaces (one gate). A surface is PRIVATE when it sits in the workspace titled
// PRIVATE_WORKSPACE_TITLE, or is listed, unexpired, in the mark file. The bridge refuses (423
// `private`) any request that addresses one and drops them from multi-surface replies, so the phone
// can neither see nor type into the Mac pane where a Claude account is set up.
//
// Mark file: ~/.config/cmux-remote/private-surfaces.json (0600), [{surface, workspace?, until}] with
// `until` in epoch ms. Written by the bridge when it opens a setup/remove pane; re-read on every
// check, so a mark survives a bridge restart. Test seam: HYPERMUX_PRIVATE_FILE.
//
// Fail closed where it matters: an unreadable mark file leaves the title rule in force (the setup
// pane lives in the titled workspace). A failed or stalled tree read (GATE_TIMEOUT_MS): a ref the
// last good tree (<= STALE_MAX_MS old) knows is judged by it; every other ref is private until the
// next good read — a pane created since cannot be proven outside the private workspace. With a good
// fresh tree, an unknown ref is not private (routes addressing it fail on their own).
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRIVATE_WORKSPACE_TITLE = 'Claude accounts';
// The one title rule (the gate and the S2c pane opener both use it).
const isPrivateTitle = (title) => String(title == null ? '' : title).trim() === PRIVATE_WORKSPACE_TITLE;
const TREE_CACHE_MS = 1000;
const FORCE_MIN_MS = 100;   // an unknown ref reloads the tree, unless it was read this recently
const FORCE_EVERY_MS = 1000; // ...and at most once per this window
// The gate's own tree read: no retry; a stall refuses (503 gate_unavailable). 5 s, not 2 s: on a
// loaded Mac (or the full test suite) a cmux spawn alone can take > 2 s, and a 2 s cut turned every
// request into 503. Still bounded well below loadTree's 12 s + retry (~24 s) that it replaces.
const GATE_TIMEOUT_MS = 5000;
const STALE_MAX_MS = 5000;    // after a failed read, a good tree this recent still clears the refs IT knows

const defaultFile = () => process.env.HYPERMUX_PRIVATE_FILE
  || require('./hm-home').statePath('private-surfaces.json', path.join(os.homedir(), '.config', 'cmux-remote', 'private-surfaces.json'));
const key = (v) => String(v == null ? '' : v).trim().toLowerCase();

// -> { entries: [...] } | { error } (file present but unreadable/garbled). Missing file = no entries.
function readFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { entries: [] } : { error: (e && e.code) || 'read_failed' };
  }
  let data;
  try { data = JSON.parse(raw); } catch (_) { return { error: 'bad_json' }; }
  if (!Array.isArray(data)) return { error: 'bad_shape' };
  return { entries: data.filter((e) => e && typeof e.surface === 'string' && Number.isFinite(e.until)) };
}

function writeFile(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function marked(now, opts) {
  const o = opts || {};
  const t = Number.isFinite(now) ? now : Date.now();
  const r = readFile(o.file || defaultFile());
  return r.error ? [] : r.entries.filter((e) => e.until > t);
}

function mark({ surface, workspace, ttlMs }, opts) {
  const o = opts || {};
  const file = o.file || defaultFile();
  const now = (o.now || Date.now)();
  const r = readFile(file);
  const keep = (r.error ? [] : r.entries).filter((e) => e.until > now && key(e.surface) !== key(surface));
  const entry = { surface: String(surface), until: now + Number(ttlMs) };
  if (workspace) entry.workspace = String(workspace);
  keep.push(entry);
  writeFile(file, keep);
}

function unmark(surface, opts) {
  const o = opts || {};
  const file = o.file || defaultFile();
  const r = readFile(file);
  if (r.error) return;
  writeFile(file, r.entries.filter((e) => key(e.surface) !== key(surface)));
}

// loadTree -> bridge.js loadTree shape: [{id, ref, title, tabs:[{id, ref, pane, paneRef}], panes:[{id, ref, tabs:[ids]}]}]
function createPrivacy({ loadTree, now, file, log, timeoutMs } = {}) {
  const clock = now || Date.now;
  const logf = log || ((m) => console.log(m));
  const fileOf = () => file || defaultFile();
  const gateTimeout = Number.isFinite(timeoutMs) ? timeoutMs : GATE_TIMEOUT_MS;
  // cache: a tree array, or null = the last read failed (fail closed). Failures are cached like
  // successes, so a stalled cmux is asked at most once per TREE_CACHE_MS.
  let cache = null, cacheAt = -Infinity, forcedAt = -Infinity, warned = false;
  let lastGood = null, lastGoodAt = -Infinity;

  // Marked surface keys (unexpired) — read fresh on every check.
  function marks() {
    const r = readFile(fileOf());
    if (r.error) {
      if (!warned) { warned = true; logf(`private-surfaces: mark file unreadable (${r.error}) — title rule only`); }
      return new Set();
    }
    warned = false;
    const t = clock();
    return new Set(r.entries.filter((e) => e.until > t).map((e) => key(e.surface)));
  }

  // tree -> { surfaces, panes, workspaces, known } key sets
  function index(tree, m) {
    const ix = { surfaces: new Set(m), panes: new Set(), workspaces: new Set(), known: new Set() };
    for (const ws of tree || []) {
      const wsPriv = isPrivateTitle(ws.title);
      for (const k of [ws.id, ws.ref]) if (k) { ix.known.add(key(k)); if (wsPriv) ix.workspaces.add(key(k)); }
      const privTabIds = new Set();
      for (const t of ws.tabs || []) {
        const tk = [t.id, t.ref].filter(Boolean).map(key);
        tk.forEach((k) => ix.known.add(k));
        const p = wsPriv || tk.some((k) => m.has(k));
        if (p) { tk.forEach((k) => ix.surfaces.add(k)); privTabIds.add(key(t.id)); [t.pane, t.paneRef].filter(Boolean).forEach((k) => ix.panes.add(key(k))); }
      }
      for (const pn of ws.panes || []) {
        const pk = [pn.id, pn.ref].filter(Boolean).map(key);
        pk.forEach((k) => ix.known.add(k));
        if (wsPriv || (pn.tabs || []).some((id) => privTabIds.has(key(id)))) pk.forEach((k) => ix.panes.add(k));
      }
    }
    return ix;
  }

  let inflight = null;
  // A forced reload over the 1/s budget WAITS for the next slot (shared by every waiter) rather than
  // answer from a cache that cannot speak for a ref it lacks: a pane created since — e.g. a new setup
  // pane whose short sequential ref the phone guessed — must never read as clear. Refs the phone
  // learned from a tree are already in the cache (prime), so only absent refs pay this wait.
  let slot = null;
  async function tree(force) {
    const t = clock();
    const age = t - cacheAt;
    if (age <= TREE_CACHE_MS) {
      if (!force || age < FORCE_MIN_MS) return { tr: cache };
      const wait = forcedAt + FORCE_EVERY_MS - t;
      if (wait > 0) {
        if (!slot) {
          slot = new Promise((r) => setTimeout(r, wait))
            .then(() => { forcedAt = clock(); return load(); })
            .finally(() => { slot = null; });
        }
        return { tr: await slot };
      }
    }
    if (force) forcedAt = t;
    return { tr: await load() };
  }
  function load() {
    if (!inflight) {
      inflight = (async () => {
        let timer;
        const stall = new Promise((resolve) => { timer = setTimeout(() => resolve(null), gateTimeout); });
        let ws = null;
        try { ws = await Promise.race([Promise.resolve().then(loadTree), stall]); } catch (_) { ws = null; }
        clearTimeout(timer);
        cache = Array.isArray(ws) ? ws : null;
        cacheAt = clock();
        if (cache) { lastGood = cache; lastGoodAt = cacheAt; }
        return cache;
      })().finally(() => { inflight = null; });
    }
    return inflight;
  }

  // One tree read for many refs: reloads once if any ref is missing from the cached tree. Returns a
  // sync predicate (ref -> private?) over every kind (surface, pane, workspace).
  // -> { ix, unsure }. unsure: the tree read failed (ix = the recent last good tree, or empty), so a
  // ref ix lacks is unproven.
  async function resolve(refs, m) {
    let { tr } = await tree(false);
    if (tr) {
      const ix = index(tr, m);
      if (!(refs || []).some((r) => key(r) && !ix.known.has(key(r)) && !m.has(key(r)))) return { ix, unsure: false };
      const again = await tree(true);
      if (again.tr) return { ix: index(again.tr, m), unsure: false };
    }
    const fresh = lastGood && clock() - lastGoodAt <= STALE_MAX_MS;
    return { ix: index(fresh ? lastGood : [], m), unsure: true };
  }
  // 'private' (a real verdict) | 'unavailable' (cannot be proven either way: refuse) | null (clear)
  const judge = ({ ix, unsure }, k, kinds) => {
    if (kinds.some((kind) => ix[kind].has(k))) return 'private';
    return unsure && !ix.known.has(k) ? 'unavailable' : null;
  };
  const ALL = ['surfaces', 'panes', 'workspaces'];

  async function verdict(refs) {
    const m = marks();
    const r = await resolve(refs, m);
    return (ref) => { const k = key(ref); return k ? judge(r, k, ALL) : null; };
  }
  // boolean form: refuse on both 'private' and 'unavailable'
  async function snapshot(refs) {
    const v = await verdict(refs);
    return (ref) => !!v(ref);
  }

  async function check(ref, kinds) {
    const k = key(ref);
    if (!k) return false;
    const m = marks();
    if (kinds.includes('surfaces') && m.has(k)) return true;
    return !!judge(await resolve([ref], m), k, kinds);
  }

  return {
    isPrivateSurface: (ref) => check(ref, ['surfaces']),
    isPrivatePane: (ref) => check(ref, ['panes']),
    isPrivateWorkspace: (ref) => check(ref, ['workspaces']),
    // Any id/ref of any kind (query/body params whose kind the gate can't know: target, id, …).
    isPrivateRef: (ref) => check(ref, ['surfaces', 'panes', 'workspaces']),
    snapshot,
    verdict,
    // Feed a full tree the bridge read anyway (tree polls, every mutation reply): refs the phone can
    // know are then always in the cache, so the 1/s reload cap never refuses a tab just created.
    prime(ws) {
      if (!Array.isArray(ws)) return;
      cache = ws; cacheAt = clock(); lastGood = ws; lastGoodAt = cacheAt;
    },
    anyPrivate: async (refs) => { const isP = await snapshot(refs); return (refs || []).some(isP); },
    // Drop the private workspace, private tabs, and panes left with no tabs. Never mutates the input.
    filterTree(workspaces) {
      if (!Array.isArray(workspaces)) return workspaces;
      const ix = index(workspaces, marks());
      const out = [];
      for (const ws of workspaces) {
        if (ix.workspaces.has(key(ws.id)) || ix.workspaces.has(key(ws.ref))) continue;
        const tabs = (ws.tabs || []).filter((t) => !ix.surfaces.has(key(t.id)));
        if (tabs.length === (ws.tabs || []).length) { out.push(ws); continue; }
        const keepIds = new Set(tabs.map((t) => t.id));
        const panes = [];
        for (const pn of ws.panes || []) {
          const ids = (pn.tabs || []).filter((id) => keepIds.has(id));
          if (!ids.length) continue;
          const sel = ids.includes(pn.selected) ? pn.selected : ids[0];
          panes.push({ ...pn, tabs: ids, selected: sel });
        }
        out.push({ ...ws, tabs, panes });
      }
      return out;
    },
  };
}

module.exports = { PRIVATE_WORKSPACE_TITLE, isPrivateTitle, TREE_CACHE_MS, GATE_TIMEOUT_MS, createPrivacy, mark, unmark, marked, defaultFile };
