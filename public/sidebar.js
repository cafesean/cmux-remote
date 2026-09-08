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

    // On screen = on the selected machine, page visible, AND either the focused tab or a surface
    // currently mirrored in a visible pane. In a split view both panes are on screen: a pane you are
    // looking at must never badge `done` just because the focus is in the other one.
    const onScreen = (view, m, sid) => !!(view && view.visible !== false && view.machine === m
      && (view.surfaceId === sid || (Array.isArray(view.visibleSurfaces) && view.visibleSurfaces.includes(sid))));

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

  const GLYPH = { waiting: '●', done: '◑', running: '◐', idle: '○', unreachable: '✗' };

  // VIEW. Paints a snapshot into `mount` (<aside id="side">). Owns the mode (full | rail | hidden),
  // its persistence per form factor, the phone drawer's scrim, collapsed machines, and the
  // long-press sheet. Every action goes out through a callback; it never touches app state.
  function createSidebar(o) {
    const doc = o.doc || document, mount = o.mount, scrim = o.scrim || null;
    const store = o.store || { get() { return null; }, set() {}, remove() {} };
    const isPhone = o.isPhone || (() => false);
    const modeKey = () => (isPhone() ? KEYS.sidePhone : KEYS.side);
    const load = (k, dflt) => { try { return store.get(k) || dflt; } catch (_) { return dflt; } };
    let mode = load(modeKey(), isPhone() ? 'hidden' : 'full');
    if (!['full', 'rail', 'hidden'].includes(mode)) mode = isPhone() ? 'hidden' : 'full';
    let lastOpen = mode === 'hidden' ? 'full' : mode;
    let collapsed = new Set(); try { collapsed = new Set(JSON.parse(load(KEYS.collapsed, '[]'))); } catch (_) {}
    let snap = null, sheet = null;

    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const apply = () => {
      mount.dataset.mode = mode;
      if (scrim) scrim.hidden = !(mode === 'full' && isPhone());
      try { store.set(modeKey(), mode); } catch (_) {}
      const chip = doc.getElementById('wsChip'); if (chip) chip.setAttribute('aria-expanded', mode === 'hidden' ? 'false' : 'true');
    };
    function setMode(m) { if (!['full', 'rail', 'hidden'].includes(m)) return; mode = m; if (m !== 'hidden') lastOpen = m; apply(); render(snap); }
    function toggle() { setMode(mode === 'hidden' ? lastOpen : 'hidden'); }
    // a navigating tap closes the drawer on a phone; everything else leaves it open
    const afterNav = () => { if (isPhone() && mode === 'full') setMode('hidden'); };
    const closeSheet = () => { if (sheet) { sheet.remove(); sheet = null; } };

    function openSheet(anchor, machineId, ws) {
      closeSheet();
      sheet = el('div', 'sidesheet');
      const r = el('button', null, 'Rename workspace'); r.type = 'button';
      r.onclick = (e) => { e.stopPropagation(); closeSheet(); if (o.onRename) o.onRename(machineId, ws); };
      const c = el('button', null, 'Close workspace'); c.type = 'button';
      c.onclick = (e) => { e.stopPropagation(); closeSheet(); if (o.onClose) o.onClose(machineId, ws); };
      sheet.append(r, c);
      // The sheet is `position: fixed`, so it is placed in VIEWPORT coordinates and is not clipped by
      // #side's `overflow: hidden` — positioning it inside the panel meant a long-press on a row near
      // the bottom opened a sheet nobody could see. It still lives inside #side so closeSheet() owns it.
      const rc = anchor.getBoundingClientRect();
      sheet.style.left = Math.max(8, rc.left + 24) + 'px';
      sheet.style.top = (rc.bottom + 4) + 'px';
      mount.appendChild(sheet);
      // ...and a row near the bottom of the SCREEN gets the sheet above it rather than off the edge.
      const vh = (doc.defaultView && doc.defaultView.innerHeight) || 0;
      const h = sheet.offsetHeight || 0;
      if (vh && rc.bottom + 4 + h > vh - 8) sheet.style.top = Math.max(8, rc.top - h - 4) + 'px';
    }
    function longPress(node, fn) {
      let timer = null;
      const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
      node.addEventListener('touchstart', () => { clear(); timer = setTimeout(() => { timer = null; fn(); }, 500); }, { passive: true });
      node.addEventListener('touchend', clear); node.addEventListener('touchmove', clear); node.addEventListener('touchcancel', clear);
    }

    function render(s) {
      if (s) snap = s;
      closeSheet();
      // A repaint happens every 5-second beat and rebuilds the list, which resets the scroll to the
      // top. On a fleet taller than the viewport that makes the panel unscrollable in practice — you
      // scroll down and the next beat puts you back. Carry the offset across the rebuild.
      const prevList = mount.querySelector('.sidelist');
      const prevTop = prevList ? prevList.scrollTop : 0;
      mount.replaceChildren();
      mount.classList.toggle('stale', !!(snap && snap.stale));
      if (!snap) return;
      const cur = o.current ? o.current() : {};
      const t = snap.totals || { waiting: 0, done: 0 };
      const sum = el('div', 'sidesum' + (snap.stale ? ' stale' : ''));
      sum.setAttribute('role', 'button');
      if (snap.stale) sum.textContent = 'reconnecting…';
      else {
        const parts = []; if (t.waiting) parts.push(t.waiting + ' waiting'); if (t.done) parts.push(t.done + ' done');
        sum.textContent = parts.join(' · ');
        sum.hidden = !parts.length;
      }
      sum.onclick = () => {
        const n = o.model && o.model.nextTarget({ machine: cur.machine, surfaceId: cur.surfaceId });
        if (n && o.onJump) { o.onJump(n); afterNav(); }
      };
      mount.appendChild(sum);

      const list = el('div', 'sidelist');
      for (const m of snap.machines) {
        const box = el('div', 'sidem'); box.dataset.machine = m.id;
        const head = el('button', 'sidemh'); head.type = 'button';
        head.setAttribute('aria-expanded', collapsed.has(m.id) ? 'false' : 'true');
        head.title = m.label;
        const init = el('span', 'sideinit', ((m.label || m.id).trim().charAt(0) || '?').toUpperCase());
        const g = el('span', 'sideglyph ' + (m.ok ? m.state : 'unreachable'), m.ok ? GLYPH[m.state] : GLYPH.unreachable);
        const lab = el('span', 'sidelabel', m.label || m.id);
        const cnt = el('span', 'sidecount ' + m.state, String(m.count)); cnt.hidden = !m.count;
        head.append(init, g, lab, cnt);
        head.onclick = () => {
          if (mode === 'rail') { setMode('full'); return; }
          if (collapsed.has(m.id)) collapsed.delete(m.id); else collapsed.add(m.id);
          try { store.set(KEYS.collapsed, JSON.stringify([...collapsed])); } catch (_) {}
          render(null);
        };
        box.appendChild(head);
        if (!m.ok) {
          const err = el('div', 'sideerr', (o.errorText ? o.errorText(m.error, m.id) : (m.label + ': ' + m.error)) + ' — tap to retry');
          err.setAttribute('role', 'button');
          err.onclick = () => { if (o.onRetry) o.onRetry(); };
          box.appendChild(err);
        } else if (!collapsed.has(m.id)) {
          const wsBox = el('div', 'sidews');
          for (const w of m.workspaces) {
            const row = el('div', 'siderow ws' + (m.id === cur.machine && w.ref === cur.wsRef ? ' sel' : ''));
            row.setAttribute('role', 'button'); row.dataset.ws = w.ref;
            const wg = el('span', 'sideglyph ' + w.state, GLYPH[w.state]);
            const wl = el('span', 'sidelabel', w.title);
            const wc = el('span', 'sidecount ' + w.state, String(w.count)); wc.hidden = !w.count;
            const ed = el('span', 'sideact edit', '✎'); ed.setAttribute('role', 'button'); ed.setAttribute('aria-label', 'Rename workspace');
            ed.onclick = (e) => { e.stopPropagation(); if (o.onRename) o.onRename(m.id, w); };
            const cl = el('span', 'sideact close', '×'); cl.setAttribute('role', 'button'); cl.setAttribute('aria-label', 'Close workspace');
            cl.onclick = (e) => { e.stopPropagation(); if (o.onClose) o.onClose(m.id, w); };
            row.append(wg, wl, wc, ed, cl);
            row.onclick = () => { if (o.onJump) o.onJump({ machine: m.id, workspaceRef: w.ref }); afterNav(); };
            longPress(row, () => openSheet(row, m.id, w));
            wsBox.appendChild(row);
            for (const tb of w.tabs) {
              const tr = el('div', 'siderow tab'); tr.setAttribute('role', 'button'); tr.dataset.surface = tb.id;
              tr.append(el('span', 'sideglyph ' + tb.state, GLYPH[tb.state]), el('span', 'sidelabel', tb.title));
              tr.onclick = (e) => { e.stopPropagation(); if (o.onJump) o.onJump({ machine: m.id, workspaceRef: w.ref, surfaceId: tb.id }); afterNav(); };
              wsBox.appendChild(tr);
            }
          }
          const nw = el('button', 'siderow new', '+ New workspace'); nw.type = 'button';
          nw.onclick = () => { if (o.onNew) o.onNew(m.id); };
          wsBox.appendChild(nw);
          box.appendChild(wsBox);
        }
        list.appendChild(box);
      }
      mount.appendChild(list);
      if (prevTop) list.scrollTop = prevTop;   // after the append, or there is nothing to scroll yet
      const foot = el('div', 'sidefoot');
      const rail = el('button', 'siderail', mode === 'rail' ? '⟩' : '⟨'); rail.type = 'button';
      rail.setAttribute('aria-label', mode === 'rail' ? 'Expand sidebar' : 'Collapse to rail');
      rail.onclick = () => setMode(mode === 'rail' ? 'full' : 'rail');
      foot.appendChild(rail);
      mount.appendChild(foot);
    }
    if (scrim) scrim.onclick = () => setMode('hidden');
    apply();
    return { render, mode: () => mode, setMode, toggle, destroy() { closeSheet(); mount.replaceChildren(); } };
  }

  return { createSidebarModel, createSidebar, pickLandingTab, KEYS };
});
