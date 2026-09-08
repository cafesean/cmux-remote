/* cmux-remote — attention sidebar (p17). Dual-export like gitbar.js: `window.cmuxSidebar` in the
 * browser, `module.exports` under node --test. Requiring this file touches no DOM and makes no
 * network call.
 *
 * MODEL (first half): pure. Takes the /api/cmux/fleet payload, what is on screen, and a key/value
 * store, and answers what every machine, workspace and tab is doing:
 *   waiting  — cmux says `Needs input`
 *   done     — was `Running`, went idle while NOT on screen; clears when the tab is opened
 *   running  — cmux says `Running`
 *   idle     — everything else; never listed under a workspace
 * Memory (which tabs were running, which finished unseen) is persisted through the store so a PWA
 * relaunch between `Running` and idle still yields `done`.
 *
 * VIEW (second half, createSidebar): paints a snapshot. Nothing else.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.cmuxSidebar = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RUNNING = /^running/i, NEEDS = /needs input/i;
  const RANK = { waiting: 3, done: 2, running: 1, idle: 0 };
  const KEYS = { seen: 'cmux_seen_running', unseen: 'cmux_unseen', side: 'cmux_side', sidePhone: 'cmux_side_phone', collapsed: 'cmux_side_collapsed' };
  const CAP = 200, STALE_MS = 15000;
  const key = (machine, surface) => machine + '|' + surface;
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

  function createSidebarModel(deps) {
    const store = (deps && deps.store) || { get() { return null; }, set() {}, remove() {} };
    const load = (k) => { try { const v = JSON.parse(store.get(k) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch (_) { return new Set(); } };
    const save = (k, set) => { try { const arr = [...set]; while (arr.length > CAP) arr.shift(); store.set(k, JSON.stringify(arr)); } catch (_) { /* memory only */ } };
    const seenRunning = load(KEYS.seen), unseen = load(KEYS.unseen);
    let fleet = [], lastGoodAt = 0, lastBeatAt = 0;

    const onScreen = (view, m, sid) => !!(view && view.visible !== false && view.machine === m && view.surfaceId === sid);

    // One tab, one beat. Order matters: a `Needs input` tab is waiting whatever it was before; a
    // Running tab is remembered; a tab that WAS running and is now neither becomes done unless the
    // user is looking at it right now; and looking at a done tab clears it.
    function tabState(m, t, view) {
      const st = t.status || '', k = key(m, t.id), seen = onScreen(view, m, t.id);
      if (NEEDS.test(st)) { seenRunning.delete(k); return 'waiting'; }
      if (RUNNING.test(st)) { seenRunning.add(k); if (seen) unseen.delete(k); return 'running'; }
      if (seenRunning.delete(k) && !seen) unseen.add(k);
      if (seen) unseen.delete(k);
      return unseen.has(k) ? 'done' : 'idle';
    }

    function beat(payload, view, nowMs) {
      const now = nowMs || Date.now();
      lastBeatAt = now;
      const machines = (payload && payload.machines) || [];
      const present = new Set();
      fleet = machines.map((m) => {
        if (!m.ok) return { id: m.id, label: m.label, ok: false, error: m.error || 'bridge_unreachable', state: 'idle', count: 0, workspaces: [] };
        let mState = 'idle', mCount = 0;
        const workspaces = (m.workspaces || []).map((w) => {
          let wState = 'idle', wCount = 0; const tabs = [];
          for (const t of (w.tabs || [])) {
            present.add(key(m.id, t.id));
            const s = tabState(m.id, t, view);
            if (s === 'idle') continue;
            tabs.push({ id: t.id, ref: t.ref, title: t.title || t.ref, pane: t.pane || null, state: s });
            wState = worst(wState, s);
            if (s === 'waiting' || s === 'done') wCount++;
          }
          mState = worst(mState, wState); mCount += wCount;
          return { ref: w.ref, id: w.id, title: w.title || w.ref, selected: !!w.selected, state: wState, count: wCount, tabs };
        });
        return { id: m.id, label: m.label, ok: true, state: mState, count: mCount, workspaces };
      });
      // Forget tabs that no longer exist — but only when EVERY machine answered. A partial view
      // would otherwise erase the memory of the machine that happens to be unreachable right now.
      if (machines.length && machines.every((m) => m.ok)) {
        for (const k of [...seenRunning]) if (!present.has(k)) seenRunning.delete(k);
        for (const k of [...unseen]) if (!present.has(k)) unseen.delete(k);
      }
      if (machines.length) lastGoodAt = now;
      save(KEYS.seen, seenRunning); save(KEYS.unseen, unseen);
      return snapshot(now);
    }
    function beatFailed(nowMs) { lastBeatAt = nowMs || Date.now(); return snapshot(lastBeatAt); }
    // Opening a tab clears its done mark NOW — in memory and in the rows the panel is showing — not
    // on the next beat, or the badge would lag five seconds behind the tap that answered it.
    function markSeen(machine, surface) {
      if (!unseen.delete(key(machine, surface))) return;
      save(KEYS.unseen, unseen);
      const m = fleet.find((x) => x.id === machine);
      if (!m) return;
      let mState = 'idle', mCount = 0;
      for (const w of m.workspaces) {
        w.tabs = w.tabs.filter((t) => !(t.id === surface && t.state === 'done'));
        w.state = 'idle'; w.count = 0;
        for (const t of w.tabs) { w.state = worst(w.state, t.state); if (t.state === 'waiting' || t.state === 'done') w.count++; }
        mState = worst(mState, w.state); mCount += w.count;
      }
      m.state = mState; m.count = mCount;
    }
    function snapshot(nowMs) {
      const now = nowMs || lastBeatAt || Date.now();
      let waiting = 0, done = 0;
      for (const m of fleet) for (const w of m.workspaces) for (const t of w.tabs) { if (t.state === 'waiting') waiting++; else if (t.state === 'done') done++; }
      return { machines: fleet, totals: { waiting, done }, stale: !!lastGoodAt && now - lastGoodAt > STALE_MS };
    }
    // The next tab that needs you after `current`, in fleet order: all waiting tabs first, then the
    // done ones; wraps; null when nothing needs you.
    function nextTarget(current) {
      const list = [];
      for (const st of ['waiting', 'done']) for (const m of fleet) for (const w of m.workspaces) for (const t of w.tabs) {
        if (t.state === st) list.push({ machine: m.id, workspaceRef: w.ref, surfaceId: t.id, state: st });
      }
      if (!list.length) return null;
      const i = current ? list.findIndex((x) => x.machine === current.machine && x.surfaceId === current.surfaceId) : -1;
      return list[(i + 1) % list.length];
    }
    function statesFor(machine) {
      const out = {}; const m = fleet.find((x) => x.id === machine);
      if (m) for (const w of m.workspaces) for (const t of w.tabs) out[t.id] = t.state;
      return out;
    }
    return { beat, beatFailed, markSeen, snapshot, nextTarget, statesFor, key };
  }

  // Which tab a workspace opens on: waiting → done → running → the one cmux has in front → first.
  // `tabs` is the raw tree list; `states` maps surface id → state for that machine.
  function pickLandingTab(tabs, states) {
    const term = (tabs || []).filter((t) => t.type !== 'browser');
    const by = (st) => term.find((t) => states && states[t.id] === st);
    return by('waiting') || by('done') || by('running') || term.find((t) => t.inPane || t.selected) || term[0] || null;
  }

  return { createSidebarModel, pickLandingTab, KEYS };
});
