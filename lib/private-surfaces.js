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
// pane lives in the titled workspace). An unknown ref (in neither the tree nor the file) is not
// private — routes addressing it fail on their own.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRIVATE_WORKSPACE_TITLE = 'Claude accounts';
const TREE_CACHE_MS = 1000;
const FORCE_MIN_MS = 100;   // an unknown ref reloads the tree, unless it was read this recently

const defaultFile = () => process.env.HYPERMUX_PRIVATE_FILE
  || path.join(os.homedir(), '.config', 'cmux-remote', 'private-surfaces.json');
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
function createPrivacy({ loadTree, now, file, log } = {}) {
  const clock = now || Date.now;
  const logf = log || ((m) => console.log(m));
  const fileOf = () => file || defaultFile();
  let cache = null, cacheAt = -Infinity, lastGood = null, warned = false;

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
      const wsPriv = String(ws.title || '').trim() === PRIVATE_WORKSPACE_TITLE;
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
  async function tree(force) {
    const t = clock();
    if (cache && t - cacheAt <= (force ? FORCE_MIN_MS : TREE_CACHE_MS)) return cache;
    if (!inflight) {
      inflight = (async () => {
        let ws = null;
        try { ws = await loadTree(); } catch (_) { ws = null; }
        if (Array.isArray(ws)) lastGood = ws;
        // cmux hiccup: keep judging by the last tree we saw, and cache that too (no hammering)
        cache = Array.isArray(ws) ? ws : (lastGood || []);
        cacheAt = clock();
        return cache;
      })().finally(() => { inflight = null; });
    }
    return inflight;
  }

  // One tree read for many refs: reloads once if any ref is missing from the cached tree. Returns a
  // sync predicate (ref -> private?) over every kind (surface, pane, workspace).
  async function snapshot(refs) {
    const m = marks();
    let ix = index(await tree(false), m);
    if ((refs || []).some((r) => key(r) && !ix.known.has(key(r)) && !m.has(key(r)))) ix = index(await tree(true), m);
    return (ref) => { const k = key(ref); return !!k && (ix.surfaces.has(k) || ix.panes.has(k) || ix.workspaces.has(k)); };
  }

  async function check(ref, kinds) {
    const k = key(ref);
    if (!k) return false;
    const m = marks();
    if (kinds.includes('surfaces') && m.has(k)) return true;
    let ix = index(await tree(false), m);
    if (!ix.known.has(k)) ix = index(await tree(true), m);   // created since the cached read
    return kinds.some((kind) => ix[kind].has(k));
  }

  return {
    isPrivateSurface: (ref) => check(ref, ['surfaces']),
    isPrivatePane: (ref) => check(ref, ['panes']),
    isPrivateWorkspace: (ref) => check(ref, ['workspaces']),
    // Any id/ref of any kind (query/body params whose kind the gate can't know: target, id, …).
    isPrivateRef: (ref) => check(ref, ['surfaces', 'panes', 'workspaces']),
    snapshot,
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

module.exports = { PRIVATE_WORKSPACE_TITLE, TREE_CACHE_MS, createPrivacy, mark, unmark, marked, defaultFile };
