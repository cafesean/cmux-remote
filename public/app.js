// cmux-remote web UI (v2). Talks only to /api/cmux/* (the server holds the machine registry + bridge
// secrets; the browser only ever gets labels). Self-contained, no build step.
//
// Model: Machine > Workspace > Tab. The header is the current-workspace dropdown; the strip below is the
// tabs of THAT workspace; each tab is a cmux surface, addressed by its surface ref. Two input modes:
// Compose (batched line, autocorrect on) and Live (each keystroke forwarded, autocorrect off). The grid
// is delta-patched (changed rows only) so scroll + selection survive live updates. Grids are cached
// per tab (paint instantly on reopen) and polls are conditional (hash echo → `{same:1}` when idle).
(() => {
  'use strict';

  // ---- auth ----
  let TOKEN = null;
  try {
    const h = new URLSearchParams(location.hash.slice(1)).get('token');
    if (h) { localStorage.setItem('cmux_token', h); history.replaceState(null, '', location.pathname + location.search); }
    TOKEN = localStorage.getItem('cmux_token');
  } catch (_) {}
  const authHeaders = (h = {}) => (TOKEN ? { ...h, Authorization: 'Bearer ' + TOKEN } : h);
  const noCacheUrl = (url) => url + (url.includes('?') ? '&' : '?') + '_=' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const jget = (url) => fetch(noCacheUrl(url), { headers: authHeaders({ 'cache-control': 'no-cache' }), credentials: 'same-origin', cache: 'no-store' });
  const jpost = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  function promptToken() { const t = prompt('Access token'); if (t) { try { localStorage.setItem('cmux_token', t); } catch (_) {} location.reload(); } }

  const $ = (id) => document.getElementById(id);
  const elTabs = $('tabs'), elScreen = $('screen'), elEmpty = $('empty'), elStatus = $('status'), elJump = $('jump');
  const elText = $('text'), elSend = $('send'), elNewTab = $('newTab'), elRefresh = $('refresh');
  const elWsChip = $('wsChip'), elWsLabel = $('wsLabel'), elHost = $('hostLabel'), elWsMenu = $('wsMenu');
  const elKeys = $('keys'), elKbToggle = $('kbToggle'), elHint = $('hint');
  const elModeCompose = $('modeCompose'), elModeLive = $('modeLive');
  const elSettingsBtn = $('settingsBtn'), elSetMenu = $('setMenu');
  const elFontUp = $('fontUp'), elFontDown = $('fontDown'), elFontVal = $('fontVal'), elFontReset = $('fontReset');
  // browser-mirror elements
  const elNewBrowser = $('newBrowser'), elBrowser = $('browser'), elBshot = $('bshot'), elBspin = $('bspin');
  const elBurl = $('burl'), elBGo = $('bGo'), elBBack = $('bBack'), elBFwd = $('bFwd'), elBReload = $('bReload');
  const elBZoomIn = $('bZoomIn'), elBZoomOut = $('bZoomOut'), elBtext = $('btext'), elBfoot = $('bfoot');

  const state = {
    machine: null, machines: [],
    workspaces: [],           // [{ ref, id, title, selected, tabs:[{id,ref,title,type,selected,status}] }]
    wsRef: null,              // current workspace ref
    tab: null,                // { id, ref } — id = stable identity, ref = cmux address
    pollTimer: null, treeTimer: null,
    mode: 'compose',          // 'compose' | 'live'
    followTail: true,
    rowSig: [],               // per-row signature cache for delta-patch
    cols: 0,                  // source terminal column count (for width auto-fit)
    zoom: 1,                  // font multiplier on top of the width auto-fit (1 = fit exactly)
    tabType: 'terminal',      // 'terminal' | 'browser' — which pane + footer is active
    browser: { es: null, surface: null, w: 800, h: 600, urlTimer: null },  // browser-surface mirror state
  };
  try { const z = parseFloat(localStorage.getItem('cmux_fontzoom')); if (z > 0) state.zoom = Math.max(0.6, Math.min(3, z)); } catch (_) {}

  function gate(msg, showToken) {
    const g = $('gate'); g.replaceChildren(); g.style.flexDirection = 'column';
    const p = document.createElement('div'); p.textContent = msg; g.appendChild(p);
    if (showToken) { const a = document.createElement('a'); a.href = '#'; a.textContent = 'Enter access token →'; a.style.marginTop = '16px'; a.onclick = (e) => { e.preventDefault(); promptToken(); }; g.appendChild(a); }
    g.style.display = 'flex';
  }
  function setStatus(txt, err) {
    if (!txt) { elStatus.hidden = true; return; }
    elStatus.hidden = false; elStatus.textContent = txt; elStatus.classList.toggle('err', !!err);
  }

  // ---- render: delta-patch the colored grid ----
  function styleSpan(el, st, def0) {
    if (!st) return;
    let fg = st.foreground, bg = st.background;
    if (st.inverse) { const t = fg; fg = bg || (def0 && def0.background); bg = t || (def0 && def0.foreground); }
    if (fg) el.style.color = fg;
    if (bg && (!def0 || bg !== def0.background)) el.style.backgroundColor = bg;
    if (st.bold) el.style.fontWeight = '700';
    if (st.faint) el.style.opacity = '0.65';
    if (st.italic) el.style.fontStyle = 'italic';
    let deco = '';
    if (st.underline) deco += 'underline ';
    if (st.strikethrough) deco += 'line-through';
    if (deco) el.style.textDecoration = deco.trim();
  }
  function buildRow(spans, byId, def0) {
    const line = document.createElement('div'); line.className = 'trow';
    let col = 0;
    for (const sp of spans) {
      if (sp.column > col) line.appendChild(document.createTextNode(' '.repeat(sp.column - col)));
      const el = document.createElement('span'); styleSpan(el, byId[sp.style_id], def0); el.textContent = sp.text; line.appendChild(el);
      col = sp.column + (sp.cell_width || sp.text.length);
    }
    if (!spans.length) line.appendChild(document.createTextNode(' '));
    return line;
  }
  function rowSig(spans) {
    let s = '';
    for (const sp of spans) s += sp.column + '' + sp.style_id + '' + sp.text + '';
    return s;
  }
  function renderGrid(g) {
    if (!g) return;
    const byId = {}; (g.styles || []).forEach((s) => { byId[s.id] = s; });
    const def0 = byId[0];
    if (def0 && def0.background) elScreen.style.background = def0.background;
    const byRow = {}; (g.spans || []).forEach((sp) => { (byRow[sp.row] = byRow[sp.row] || []).push(sp); });
    let rows = g.rows || 0;
    if (!rows) (g.spans || []).forEach((sp) => { if (sp.row + 1 > rows) rows = sp.row + 1; });

    // scale font so the source terminal's columns fill the browser width (before measuring line height)
    if (g.columns && g.columns > 1) { state.cols = g.columns; fitFont(); }

    // fill blank rows so a short source grid still occupies the viewport (phones)
    const cs = getComputedStyle(elScreen);
    const fs = parseFloat(cs.fontSize) || 13;
    const lh = parseFloat(cs.lineHeight) || fs * 1.32;
    const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
    const fillRows = Math.max(rows, Math.ceil(Math.max(0, elScreen.clientHeight - padY) / lh));

    const wasAtBottom = elScreen.scrollHeight - elScreen.scrollTop - elScreen.clientHeight < 40;

    // patch row-by-row: only rebuild rows whose signature changed → preserves selection + scroll
    const kids = elScreen.childNodes;
    for (let r = 0; r < fillRows; r++) {
      const spans = (byRow[r] || []).sort((a, b) => a.column - b.column);
      const sig = spans.length ? rowSig(spans) : '';
      if (state.rowSig[r] === sig && kids[r]) continue;
      const node = buildRow(spans, byId, def0);
      if (kids[r]) elScreen.replaceChild(node, kids[r]); else elScreen.appendChild(node);
      state.rowSig[r] = sig;
    }
    while (elScreen.childNodes.length > fillRows) { elScreen.removeChild(elScreen.lastChild); state.rowSig.pop(); }

    if (state.followTail && wasAtBottom) elScreen.scrollTop = elScreen.scrollHeight;
    updateJump();
  }
  function clearScreen() { elScreen.replaceChildren(); state.rowSig = []; elScreen.style.background = ''; }

  // ---- per-tab grid cache: reopening a tab paints instantly from the last known grid (0 network),
  // then the poll (seeded with the cached hash) delta-patches only what changed. Without this every
  // tab switch re-downloaded + re-rendered the WHOLE scrollback — seconds on a long session.
  // Backed by localStorage (throttled) so a COLD page load paints the last-seen grid before any
  // network round trip — over a tunnel the boot chain is RTT-bound and used to sit blank for seconds.
  const gridCache = new Map();   // machine|surfaceId -> { raw, h }
  const GRID_CACHE_MAX = 16;
  const GRID_LS_PREFIX = 'cmux_grid_';
  const GRID_LS_MAX = 6;         // persisted tabs (grids are ~100KB+; keep well under the 5MB quota)
  const gridCacheKey = (sid) => state.machine + '|' + sid;
  const lsIndex = () => { try { return JSON.parse(localStorage.getItem('cmux_grid_idx') || '[]'); } catch (_) { return []; } };
  function lsPersist(k, raw) {
    try {
      const idx = lsIndex().filter((x) => x !== k); idx.push(k);
      while (idx.length > GRID_LS_MAX) localStorage.removeItem(GRID_LS_PREFIX + idx.shift());
      localStorage.setItem(GRID_LS_PREFIX + k, raw);
      localStorage.setItem('cmux_grid_idx', JSON.stringify(idx));
    } catch (_) {   // quota — drop all persisted grids rather than fight it
      try { lsIndex().forEach((x) => localStorage.removeItem(GRID_LS_PREFIX + x)); localStorage.removeItem('cmux_grid_idx'); } catch (__) {}
    }
  }
  const lsPersistAt = new Map();   // key -> last persist ts (a 100KB+ sync write per frame would jank)
  function gridCachePut(sid, raw, h) {
    const k = gridCacheKey(sid);
    gridCache.delete(k); gridCache.set(k, { raw, h });
    while (gridCache.size > GRID_CACHE_MAX) gridCache.delete(gridCache.keys().next().value);
    const now = Date.now();
    if ((lsPersistAt.get(k) || 0) + 3000 < now) { lsPersistAt.set(k, now); lsPersist(k, raw); }
  }
  function flushGridCache() {   // pagehide: make sure the freshest frames survive the unload
    for (const [k, c] of gridCache) lsPersist(k, c.raw);
  }
  function cacheEntry(k) {      // memory first, then localStorage (cold load)
    let c = gridCache.get(k);
    if (!c) {
      try {
        const raw = localStorage.getItem(GRID_LS_PREFIX + k);
        if (raw) { const d = JSON.parse(raw); if (d && d.grid) { c = { raw, h: d.h || null }; gridCache.set(k, c); } }
      } catch (_) {}
    }
    return c || null;
  }
  function paintFromCache(sid) {   // -> the cache entry if painted, else null
    const c = cacheEntry(gridCacheKey(sid));
    if (!c) return null;
    try { const d = JSON.parse(c.raw); if (d && d.grid) { renderGrid(d.grid); return c; } } catch (_) {}
    return null;
  }
  function dropCache(sid) {
    const k = gridCacheKey(sid);
    gridCache.delete(k);
    try { localStorage.removeItem(GRID_LS_PREFIX + k); localStorage.setItem('cmux_grid_idx', JSON.stringify(lsIndex().filter((x) => x !== k))); } catch (_) {}
  }

  // Auto-fit: cmux owns the pty geometry, so a tab has a FIXED column count (its width on the Mac).
  // We can't resize it (that would shrink the same tab on the desktop). Instead scale the font so those
  // columns exactly fill the browser width — the mirror then fills + reflows with the viewport.
  let _charRatio = 0;
  function charRatio() {
    if (_charRatio) return _charRatio;
    const s = document.createElement('span');
    s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:100px;';
    s.textContent = '0'.repeat(100);
    elScreen.appendChild(s);
    const w = s.getBoundingClientRect().width; s.remove();
    _charRatio = w ? (w / 100) / 100 : 0.6;   // width per char, per px of font-size
    return _charRatio;
  }
  function fitFont() {
    const cols = state.cols;
    if (!cols || cols < 2) return;
    const cs = getComputedStyle(elScreen);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    const avail = elScreen.clientWidth - padX;
    if (avail <= 0) return;
    // Baseline = font at which the source columns exactly fill the width. Clamp the BASELINE to a
    // readable floor FIRST, then apply the user's zoom. If we instead multiplied then floored (the old
    // order), a wide source terminal on a narrow phone gives a ~3px baseline and the 7px floor swallows
    // the whole zoom range — A+/A− bump the % label but the text stays pinned at 7px. #screen is
    // white-space: pre-wrap, so a baseline wider than the viewport wraps rather than overflowing.
    const base = Math.max(7, Math.min(avail / (cols * charRatio()), 48));
    const fs = Math.max(7, Math.min(base * state.zoom, 72));
    elScreen.style.fontSize = fs.toFixed(2) + 'px';
  }

  // ---- font zoom (settings) ----
  function updateFontVal() { if (elFontVal) elFontVal.textContent = Math.round(state.zoom * 100) + '%'; }
  function applyZoom() {
    try { localStorage.setItem('cmux_fontzoom', String(state.zoom)); } catch (_) {}
    updateFontVal();
    fitFont();
    if (state.followTail) elScreen.scrollTop = elScreen.scrollHeight;
    updateJump();
  }
  function nudgeZoom(mult) {
    const next = Math.max(0.6, Math.min(3, +(state.zoom * mult).toFixed(3)));
    if (next === state.zoom) return;
    state.zoom = next; applyZoom();
  }
  function resetZoom() { if (state.zoom === 1) return; state.zoom = 1; applyZoom(); }

  // ---- settings popover (gear) ----
  function openSettings() {
    closeWsMenu(); updateFontVal();
    elSetMenu.hidden = false;
    const rc = elSettingsBtn.getBoundingClientRect();
    elSetMenu.style.left = 'auto';
    elSetMenu.style.right = Math.max(8, Math.round(window.innerWidth - rc.right)) + 'px';
    elSetMenu.style.top = Math.round(rc.bottom + 6) + 'px';
    elSettingsBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSettings() { elSetMenu.hidden = true; elSettingsBtn.setAttribute('aria-expanded', 'false'); }
  function toggleSettings() { if (elSetMenu.hidden) openSettings(); else closeSettings(); }
  function updateJump() {
    const atBottom = elScreen.scrollHeight - elScreen.scrollTop - elScreen.clientHeight < 40;
    elJump.classList.toggle('show', !atBottom);
  }

  // ---- tree: workspaces + tabs ----
  function applyTree(workspaces) {
    state.workspaces = workspaces || [];

    // resolve current workspace: keep it if still present, else cmux's selected, else first
    let ws = state.workspaces.find((w) => w.ref === state.wsRef)
          || state.workspaces.find((w) => w.selected)
          || state.workspaces[0] || null;
    state.wsRef = ws ? ws.ref : null;
    renderHeader();
    renderTabs();

    if (!ws) { elEmpty.style.display = 'flex'; return; }
    // resolve current tab within the workspace: keep by id, else running, else selected, else first terminal
    const tabs = ws.tabs || [];
    let keep = state.tab && tabs.find((t) => t.id === state.tab.id);
    if (!keep) {
      const term = tabs.filter((t) => t.type !== 'browser');
      keep = term.find((t) => /run|need/i.test(t.status || '')) || term.find((t) => t.selected) || term[0] || null;
    }
    if (keep) { if (!state.tab || state.tab.id !== keep.id) selectTab(keep.id); else { state.tab.ref = keep.ref; } }
    else { stopPolling(); state.tab = null; clearScreen(); elEmpty.style.display = 'flex'; setStatus(''); }
  }
  let treeBusy = false;
  async function loadTree() {
    // busy-guard: over a slow tunnel a 5s interval can outpace the fetch and stack requests.
    // hidden-guard: a backgrounded phone tab shouldn't keep pulling the tree through the tunnel.
    if (!state.machine || treeBusy || document.hidden) return;
    treeBusy = true;
    try {
      let data;
      try { data = await (await jget('/api/cmux/tree?machine=' + encodeURIComponent(state.machine))).json(); }
      catch (_) { setStatus('tree failed', true); return; }
      if (data && data.error) { setStatus(data.error, true); return; }
      applyTree((data && data.workspaces) || []);
    } finally { treeBusy = false; }
  }

  function currentWs() { return state.workspaces.find((w) => w.ref === state.wsRef) || null; }

  function renderHeader() {
    const ws = currentWs();
    elWsLabel.textContent = ws ? (ws.title || ws.ref) : '—';
  }

  // ---- workspace list popover (workspaces only + New workspace [+ machines when >1]) ----
  function openWsMenu() {
    elWsMenu.replaceChildren();
    state.workspaces.forEach((w) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      const running = (w.tabs || []).some((t) => /run|need/i.test(t.status || ''));
      if (running) b.classList.add('run');
      if (w.ref === state.wsRef) b.classList.add('sel');
      const dot = document.createElement('span'); dot.className = 'wsdot';
      const nm = document.createElement('span'); nm.className = 'wsname'; nm.textContent = w.title || w.ref;
      const x = document.createElement('span'); x.className = 'wsclose'; x.textContent = '×';
      x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Close workspace');
      x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeWsMenu(); doCloseWorkspace(w); };
      b.append(dot, nm, x);
      b.onclick = () => { closeWsMenu(); selectWorkspace(w.ref); };
      elWsMenu.appendChild(b);
    });
    const sep = document.createElement('div'); sep.className = 'sep'; elWsMenu.appendChild(sep);
    const nw = document.createElement('button'); nw.type = 'button'; nw.className = 'new'; nw.textContent = '+ New workspace';
    nw.onclick = () => { closeWsMenu(); doNewWorkspace(); };
    elWsMenu.appendChild(nw);
    if (state.machines.length > 1) {
      const sep2 = document.createElement('div'); sep2.className = 'sep'; elWsMenu.appendChild(sep2);
      state.machines.forEach((m) => {
        const mb = document.createElement('button'); mb.type = 'button';
        if (m.id === state.machine) mb.classList.add('sel');
        mb.textContent = '🖥 ' + m.label;
        mb.onclick = () => { closeWsMenu(); switchMachine(m.id); };
        elWsMenu.appendChild(mb);
      });
    }
    elWsMenu.hidden = false;
    const rc = elWsChip.getBoundingClientRect();
    elWsMenu.style.left = Math.round(rc.left) + 'px';
    elWsMenu.style.top = Math.round(rc.bottom + 6) + 'px';
    elWsChip.setAttribute('aria-expanded', 'true');
  }
  function closeWsMenu() { elWsMenu.hidden = true; elWsChip.setAttribute('aria-expanded', 'false'); }
  function toggleWsMenu() { if (elWsMenu.hidden) openWsMenu(); else closeWsMenu(); }

  function switchMachine(id) {
    if (id === state.machine) return;
    if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
    state.machine = id; state.wsRef = null; state.tab = null; stopPolling();
    const cur = state.machines.find((m) => m.id === id); elHost.textContent = (cur && cur.label) || '';
    clearScreen(); elEmpty.style.display = 'flex'; setStatus('');
    loadTree();
  }
  function selectWorkspace(ref) {
    if (ref === state.wsRef) return;
    if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
    state.wsRef = ref; state.tab = null; stopPolling();
    clearScreen(); setStatus('');
    renderHeader(); renderTabs();
    const ws = currentWs();
    const tabs = (ws && ws.tabs) || [];
    const term = tabs.filter((t) => t.type !== 'browser');
    const first = term.find((t) => /run|need/i.test(t.status || '')) || term.find((t) => t.selected) || term[0];
    if (first) selectTab(first.id); else { elEmpty.style.display = 'flex'; }
  }

  // ---- tabs ----
  function renderTabs() {
    const ws = currentWs();
    const tabs = (ws && ws.tabs) || [];
    const kids = [];
    tabs.forEach((t) => {
      const b = document.createElement('button');
      const isBrowser = t.type === 'browser';
      b.className = 'tab' + (state.tab && t.id === state.tab.id ? ' on' : '') + (/run|need/i.test(t.status || '') ? ' run' : '') + (isBrowser ? ' browser' : '');
      b.type = 'button'; b.title = t.title || t.ref || t.id;
      const dot = document.createElement('span'); dot.className = 'dot'; b.appendChild(dot);
      const label = document.createElement('span'); label.className = 'label'; label.textContent = t.title || t.ref || t.id; b.appendChild(label);
      if (isBrowser) { const tag = document.createElement('span'); tag.className = 'btag'; tag.textContent = 'browser'; b.appendChild(tag); }
      const close = document.createElement('span'); close.className = 'close'; close.textContent = '×';
      close.setAttribute('aria-label', 'Close tab'); close.setAttribute('role', 'button');
      close.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doCloseTab(t); };
      b.appendChild(close);
      b.onclick = () => selectTab(t.id);
      kids.push(b);
    });
    elTabs.replaceChildren(...kids);
  }
  function findTab(id) { const ws = currentWs(); return ws && (ws.tabs || []).find((t) => t.id === id) || null; }
  function selectTab(id) {
    const t = findTab(id); if (!t) return;
    const isBrowser = t.type === 'browser';
    const sameTab = state.tab && state.tab.id === id;
    state.tab = { id: t.id, ref: t.ref };
    state.followTail = true;
    renderTabs();
    elEmpty.style.display = 'none';
    if (isBrowser) {
      state.tabType = 'browser';
      enterBrowserMode(t, sameTab);
    } else {
      if (state.tabType === 'browser') exitBrowserMode();
      state.tabType = 'terminal';
      clearScreen();
      const cached = paintFromCache(t.id);   // instant paint from the last known grid
      try { localStorage.setItem('cmux_last_tab', gridCacheKey(t.id)); } catch (_) {}   // cold-boot pre-paint target
      elText.disabled = false; elSend.disabled = false;
      startPolling(cached);
    }
  }

  // ---- live grid: SSE push first, HTTP poll fallback (surface-addressed) ----
  // Push path: /api/cmux/grid-stream — the bridge watches the surface (fast while changing, backed
  // off when idle) and pushes a frame only when the grid hash moves. No request-per-frame round trip,
  // so frame latency ≈ replay cost. `seed` (tab cache) suppresses the initial frame when unchanged.
  // Poll path (fallback if the stream can't establish): self-scheduling conditional GETs — next poll
  // fires after the previous COMPLETES (a slow tunnel round-trip never collides with a timer), and an
  // unchanged grid answers `{same:1}` (~10 bytes).
  function startPolling(seed) {
    stopPolling();
    if (!state.tab) return;
    const sid = state.tab.id;   // address by surface UUID (refs don't resolve from the detached bridge)
    let lastRaw = seed ? seed.raw : null, lastHash = seed ? seed.h : null;
    let stopped = false, timer = null, es = null;
    setStatus('live');
    const live = () => !stopped && state.tab && state.tab.id === sid;
    // shared: apply one grid payload (poll body or SSE frame) -> 'changed' | 'same' | 'error'
    const apply = (txt) => {
      if (txt === lastRaw) return 'same';
      let d; try { d = JSON.parse(txt); } catch (_) { return 'error'; }
      if (d && d.same) return 'same';
      if (d && d.grid) {
        lastRaw = txt; lastHash = d.h || null;
        renderGrid(d.grid);
        gridCachePut(sid, txt, lastHash);
        return 'changed';
      }
      return 'error';
    };
    // --- push path ---
    const startStream = () => {
      let url = '/api/cmux/grid-stream?machine=' + encodeURIComponent(state.machine) + '&surface=' + encodeURIComponent(sid)
        + (lastHash ? '&h=' + encodeURIComponent(lastHash) : '');
      if (TOKEN) url += '&token=' + encodeURIComponent(TOKEN);   // EventSource can't set headers
      try { es = new EventSource(url); } catch (_) { es = null; return startPoll(); }
      let opened = false, errs = 0;
      es.onopen = () => { opened = true; errs = 0; setStatus('live'); };
      es.onmessage = (e) => {
        if (!live()) return;
        errs = 0;
        if (e.data && apply(e.data) !== 'error') setStatus('live');
      };
      es.onerror = () => {
        if (!live()) return;
        errs++;
        // never connected, or repeatedly dying → the stream doesn't survive this path (old server,
        // proxy buffering, …) — close it and fall back to conditional polling
        if (!opened || errs >= 3) { try { es.close(); } catch (_) {} es = null; startPoll(); }
        else setStatus('reconnecting…', true);
      };
    };
    // --- poll path (fallback) ---
    let idle = 0, errs = 0;
    const delay = () => (errs ? 1200 : idle > 3 ? 900 : 250);
    const schedule = () => { if (live()) timer = setTimeout(tick, delay()); };
    const tick = async () => {
      if (!live()) return;
      try {
        const r = await jget('/api/cmux/grid?machine=' + encodeURIComponent(state.machine) + '&surface=' + encodeURIComponent(sid)
          + (lastHash ? '&h=' + encodeURIComponent(lastHash) : ''));
        if (!live()) return;
        if (!r.ok) { setStatus('offline', true); errs++; return; }
        const txt = await r.text();
        if (!live()) return;
        errs = 0;
        const a = apply(txt);
        if (a === 'changed') idle = 0; else if (a === 'same') idle++;
        if (a === 'error') { let d; try { d = JSON.parse(txt); } catch (_) { d = null; } setStatus((d && d.error) || 'error', true); return; }
        setStatus('live');
      } catch (_) { setStatus('reconnecting…', true); errs++; }
      finally { schedule(); }
    };
    const startPoll = () => { if (live()) tick(); };
    startStream();
    state.pollTimer = { stop: () => { stopped = true; if (timer) clearTimeout(timer); if (es) { try { es.close(); } catch (_) {} es = null; } } };
  }
  function stopPolling() { if (state.pollTimer) { state.pollTimer.stop(); state.pollTimer = null; } }

  // ---- browser surface: a refreshing screenshot you can tap / scroll / type into ----
  // Optimistic scroll: while dragging, the image is translated locally so it follows the finger
  // instantly; every REAL frame that arrives resets the shift (the remote page has caught up).
  let bshotShift = 0;
  function shiftBshot(px) { bshotShift = px; elBshot.style.transform = px ? 'translateY(' + px + 'px)' : ''; }
  function bFrame(b64) {
    if (!b64) return;
    if (elBspin) elBspin.hidden = true;
    shiftBshot(0);
    // frames arrive as JPEG (sips-recompressed) or PNG (fallback) — sniff by base64 magic
    elBshot.src = 'data:image/' + (b64.charAt(0) === '/' ? 'jpeg' : 'png') + ';base64,' + b64;
  }
  function setUrl(u) { if (u && document.activeElement !== elBurl) elBurl.value = u; }
  // Tap -> fraction of the displayed image (which IS the content box: max-width/height keeps aspect,
  // no internal letterbox). The bridge turns (fx,fy) into a click at (fx*innerWidth, fy*innerHeight).
  function bshotFrac(px, py) {
    const b = elBshot.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return { fx: Math.min(1, Math.max(0, (px - b.left) / b.width)), fy: Math.min(1, Math.max(0, (py - b.top) / b.height)) };
  }
  const bpost = (sub, body) => jpost('/api/cmux/browser/' + sub, { machine: state.machine, surface: state.tab && state.tab.id, ...body });
  async function bAction(sub, body) {
    if (state.tabType !== 'browser' || !state.tab) return null;
    try {
      const r = await bpost(sub, body || {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok || (d && d.error)) { setStatus((d && d.error) || 'browser error', true); return d; }
      if (d.frame) bFrame(d.frame);
      if (d.url) setUrl(d.url);
      return d;
    } catch (_) { setStatus('browser action failed', true); return null; }
  }
  const bKey = (key) => bAction('key', { key });
  function normalizeUrl(v) { v = (v || '').trim(); if (!v) return ''; if (!/^https?:\/\//i.test(v)) v = 'https://' + v; return v; }

  // LOCAL-ECHO typing: the user types in #btext (instant, local), and the remote field is synced in
  // debounced whole-value batches (/type is replace-mode). Mirroring per-keystroke needed a screenshot
  // per char and felt seconds-slow; local echo makes typing feel native while the mirror catches up.
  let btextSynced = null, btextTimer = null;
  function syncBtext() {
    if (state.tabType !== 'browser') return Promise.resolve();
    const v = elBtext.value;
    if (v === btextSynced) return Promise.resolve();
    btextSynced = v;
    return bAction('type', { text: v });
  }
  function scheduleBtextSync() {
    if (btextTimer) clearTimeout(btextTimer);
    btextTimer = setTimeout(() => { btextTimer = null; syncBtext(); }, 350);
  }
  function resetBtext(seed) {
    if (btextTimer) { clearTimeout(btextTimer); btextTimer = null; }
    elBtext.value = seed || '';
    btextSynced = seed != null ? seed : null;
  }

  function browserStream(surface) {
    closeBrowserStream();
    let url = '/api/cmux/browser/stream?machine=' + encodeURIComponent(state.machine) + '&surface=' + encodeURIComponent(surface);
    if (TOKEN) url += '&token=' + encodeURIComponent(TOKEN);   // EventSource can't set headers
    let es; try { es = new EventSource(url); } catch (_) { return; }
    state.browser.es = es;
    es.onmessage = (e) => { if (e.data) bFrame(e.data); };
    // EventSource auto-reconnects on error; stay quiet so a blip doesn't flash an error.
  }
  function closeBrowserStream() { if (state.browser.es) { try { state.browser.es.close(); } catch (_) {} state.browser.es = null; } }

  // Refresh URL bar + viewport dims. Polled (not one-shot) so a fresh tab settling from about:blank,
  // and any page-initiated navigation (a link you tapped), keep the URL bar honest.
  function refreshBrowserInfo() {
    if (state.tabType !== 'browser' || !state.tab) return;
    jget('/api/cmux/browser/info?machine=' + encodeURIComponent(state.machine) + '&surface=' + encodeURIComponent(state.tab.id))
      .then((r) => r.json()).then((d) => { if (d && d.ok) { state.browser.w = d.w || state.browser.w; state.browser.h = d.h || state.browser.h; setUrl(d.url); } })
      .catch(() => {});
  }
  function enterBrowserMode(t, sameTab) {
    stopPolling(); setStatus('');
    document.body.classList.add('mode-browser');
    elBrowser.hidden = false;
    if (sameTab && state.browser.surface === t.id && state.browser.es) return;   // already streaming this one
    state.browser.surface = t.id;
    elBshot.removeAttribute('src'); if (elBspin) elBspin.hidden = false;
    elBurl.value = '';
    browserStream(t.id);
    refreshBrowserInfo();
    if (state.browser.urlTimer) clearInterval(state.browser.urlTimer);
    state.browser.urlTimer = setInterval(refreshBrowserInfo, 2500);
  }
  function exitBrowserMode() {
    closeBrowserStream();
    if (state.browser.urlTimer) { clearInterval(state.browser.urlTimer); state.browser.urlTimer = null; }
    state.browser.surface = null;
    document.body.classList.remove('mode-browser');
    elBrowser.hidden = true;
    elBshot.removeAttribute('src');
    resetBtext('');
  }

  // ---- lifecycle actions ----
  async function doNewTab() {
    const ws = currentWs();
    if (!ws || !state.machine || (elNewTab && elNewTab.disabled)) return;
    elNewTab.disabled = true; setStatus('new tab…');
    try {
      const r = await jpost('/api/cmux/new-surface', { machine: state.machine, workspace: ws.id });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'new tab failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      renderTabs();
      if (d.id) selectTab(d.id);
      setStatus('tab created');
    } catch (_) { setStatus('new tab failed', true); }
    finally { elNewTab.disabled = false; }
  }
  async function doNewBrowser() {
    const ws = currentWs();
    if (!ws || !state.machine || (elNewBrowser && elNewBrowser.disabled)) return;
    let url = prompt('Open URL in a new browser tab (blank = new-tab page):', 'https://');
    if (url === null) return;                 // cancelled
    url = normalizeUrl(url);
    elNewBrowser.disabled = true; setStatus('new browser…');
    try {
      const r = await jpost('/api/cmux/browser/open', { machine: state.machine, workspace: ws.id, url: url || undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'new browser failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      renderTabs();
      if (d.id) selectTab(d.id); else setStatus('opened (select the browser tab)');
    } catch (_) { setStatus('new browser failed', true); }
    finally { elNewBrowser.disabled = false; }
  }
  async function doNewWorkspace() {
    if (!state.machine) return;
    setStatus('new workspace…');
    try {
      const r = await jpost('/api/cmux/new-workspace', { machine: state.machine });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'new workspace failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      if (d.workspace) { state.wsRef = d.workspace; state.tab = null; renderHeader(); renderTabs(); if (d.id) selectTab(d.id); }
      setStatus('workspace created');
    } catch (_) { setStatus('new workspace failed', true); }
  }
  async function doCloseTab(t) {
    if (!state.machine || !t) return;
    const ws = currentWs(); const tabs = (ws && ws.tabs) || [];
    const idx = tabs.findIndex((x) => x.id === t.id);
    setStatus('closing tab…');
    try {
      const r = await jpost('/api/cmux/close-tab', { machine: state.machine, surface: t.id });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'close failed', true); return; }
      dropCache(t.id);
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      const nws = currentWs(); const ntabs = (nws && nws.tabs) || [];
      if (state.tab && state.tab.id === t.id) {
        stopPolling();
        if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
        state.tab = null;
        const term = ntabs.filter((x) => x.type !== 'browser');
        const fallback = term[Math.max(0, Math.min(idx, term.length - 1))] || term[0];
        renderTabs();
        if (fallback) selectTab(fallback.id);
        else { clearScreen(); elEmpty.style.display = 'flex'; elText.disabled = true; elSend.disabled = true; }
      } else renderTabs();
      setStatus('tab closed');
    } catch (_) { setStatus('close failed', true); }
  }
  async function doCloseWorkspace(w) {
    if (!state.machine || !w) return;
    if (!confirm('Close workspace "' + (w.title || w.ref) + '"?\nThis closes all its tabs.')) return;
    const idx = state.workspaces.findIndex((x) => x.ref === w.ref);
    const wasCurrent = state.wsRef === w.ref;
    setStatus('closing workspace…');
    try {
      const r = await jpost('/api/cmux/close-workspace', { machine: state.machine, workspace: w.id });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'close failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      if (wasCurrent) {
        stopPolling(); state.tab = null; state.wsRef = null;
        const next = state.workspaces[Math.max(0, Math.min(idx, state.workspaces.length - 1))] || state.workspaces[0];
        if (next) selectWorkspace(next.ref);
        else { renderHeader(); renderTabs(); clearScreen(); elEmpty.style.display = 'flex'; elText.disabled = true; elSend.disabled = true; setStatus(''); }
      } else { renderHeader(); renderTabs(); }
      setStatus('workspace closed');
    } catch (_) { setStatus('close failed', true); }
  }

  // ---- input ----
  async function doSend() {
    if (!state.tab) return;
    const text = elText.value;
    if (!text) return;
    elText.value = ''; elText.style.height = ''; elText.focus();
    try {
      const r = await jpost('/api/cmux/send', { machine: state.machine, surface: state.tab.id, text, submit: true });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setStatus(d.error || 'send failed', true); }
    } catch (_) { setStatus('send failed', true); }
  }
  async function sendRaw(text) {   // live mode: forward typed chars immediately (no submit)
    if (!state.tab || !text) return;
    try { await jpost('/api/cmux/send', { machine: state.machine, surface: state.tab.id, text, submit: false }); }
    catch (_) { setStatus('send failed', true); }
  }
  async function doKey(key) {
    if (!state.tab) return;
    try { await jpost('/api/cmux/key', { machine: state.machine, surface: state.tab.id, key }); }
    catch (_) { setStatus('key failed', true); }
  }

  // ---- mode ----
  function setMode(mode) {
    state.mode = mode;
    const live = mode === 'live';
    elModeLive.classList.toggle('on', live); elModeLive.setAttribute('aria-selected', String(live));
    elModeCompose.classList.toggle('on', !live); elModeCompose.setAttribute('aria-selected', String(!live));
    elText.classList.toggle('live', live);
    elText.value = ''; elText.style.height = '';
    elSend.hidden = live;
    elKeys.hidden = !live && !elKbToggle.classList.contains('on');
    // autocorrect: ON for prose in Compose, OFF for raw keys in Live
    elText.setAttribute('autocorrect', live ? 'off' : 'on');
    elText.setAttribute('autocapitalize', live ? 'off' : 'sentences');
    elText.setAttribute('spellcheck', live ? 'false' : 'true');
    elText.placeholder = live ? 'raw keys — each keystroke hits the terminal' : 'Type…  (Send to submit)';
    elHint.textContent = live ? 'Live · autocorrect off · ↑ recalls, Tab completes' : 'Compose · autocorrect on · type, tap Send';
  }

  const autogrow = () => { if (state.mode === 'live') return; elText.style.height = 'auto'; elText.style.height = Math.min(elText.scrollHeight, 120) + 'px'; };

  // ---- wire up ----
  elSend.onclick = doSend;
  if (elNewTab) elNewTab.onclick = doNewTab;
  if (elNewBrowser) elNewBrowser.onclick = doNewBrowser;
  elRefresh.onclick = loadTree;
  elModeCompose.onclick = () => setMode('compose');
  elModeLive.onclick = () => setMode('live');
  elWsChip.onclick = (e) => { e.stopPropagation(); toggleWsMenu(); };
  if (elSettingsBtn) elSettingsBtn.onclick = (e) => { e.stopPropagation(); toggleSettings(); };
  if (elFontUp) elFontUp.onclick = () => nudgeZoom(1.15);
  if (elFontDown) elFontDown.onclick = () => nudgeZoom(1 / 1.15);
  if (elFontReset) elFontReset.onclick = () => resetZoom();
  document.addEventListener('click', (e) => {
    if (!elWsMenu.hidden && !elWsMenu.contains(e.target) && !elWsChip.contains(e.target)) closeWsMenu();
    if (!elSetMenu.hidden && !elSetMenu.contains(e.target) && !elSettingsBtn.contains(e.target)) closeSettings();
  });
  window.addEventListener('resize', () => { closeWsMenu(); closeSettings(); fitFont(); });
  elJump.onclick = () => { state.followTail = true; elScreen.scrollTop = elScreen.scrollHeight; updateJump(); };
  elScreen.addEventListener('scroll', () => {
    const atBottom = elScreen.scrollHeight - elScreen.scrollTop - elScreen.clientHeight < 40;
    state.followTail = atBottom; updateJump(); closeWsMenu();
  }, { passive: true });

  // Live mode: forward each inserted char / enter / backspace straight to the terminal.
  elText.addEventListener('beforeinput', (e) => {
    if (state.mode !== 'live') return;
    const t = e.inputType;
    if (t === 'insertText' || t === 'insertCompositionText' || t === 'insertFromPaste') { if (e.data) sendRaw(e.data); e.preventDefault(); elText.value = ''; return; }
    if (t === 'insertLineBreak' || t === 'insertParagraph') { doKey('enter'); e.preventDefault(); elText.value = ''; return; }
    if (t === 'deleteContentBackward') { doKey('backspace'); e.preventDefault(); elText.value = ''; return; }
  });
  // Keys with no text input event (arrows/Esc/Tab/^C) — from a hardware keyboard (tablet). Both modes.
  elText.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const live = state.mode === 'live';
    const empty = elText.value === '';
    if (e.key === 'Escape') { e.preventDefault(); doKey('escape'); return; }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); doKey('ctrl+c'); return; }
    if (e.key === 'Tab') { e.preventDefault(); doKey(e.shiftKey ? 'shift+tab' : 'tab'); return; }
    const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (arrow && (live || empty)) { e.preventDefault(); doKey(arrow); return; }
    if (e.key !== 'Enter') return;
    if (live) return;   // handled by beforeinput in live mode
    if (e.shiftKey) { e.preventDefault(); const s = elText.selectionStart, en = elText.selectionEnd; elText.value = elText.value.slice(0, s) + '\n' + elText.value.slice(en); elText.selectionStart = elText.selectionEnd = s + 1; autogrow(); return; }
    e.preventDefault();
    if (empty) doKey('enter'); else doSend();
  });
  elText.addEventListener('input', autogrow);

  // Fire every special key on pointerdown so a press registers the INSTANT it lands — no ~click delay,
  // and no touch→mouse double-fire (Pointer Events unify touch + mouse into one path, firing once).
  // Arrows additionally hold-to-repeat; the stop() is idempotent so intervals never stack or leak.
  elKeys.querySelectorAll('button[data-key]').forEach((b) => {
    const key = b.dataset.key;
    const arrow = b.classList.contains('arrow');
    let iv = null;
    const stop = () => { if (iv) { clearInterval(iv); iv = null; } };
    const down = (e) => {
      if (e.button != null && e.button > 0) return;   // ignore non-primary (mouse right/middle)
      e.preventDefault();
      stop();
      doKey(key);
      if (arrow) iv = setInterval(() => doKey(key), 140);
    };
    b.addEventListener('pointerdown', down);
    if (arrow) { b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop); }
    b.onclick = null;   // pointerdown owns activation; keep click from double-firing
  });
  if (elKbToggle) elKbToggle.onclick = () => {
    const show = elKeys.hidden; elKeys.hidden = !show;
    elKbToggle.classList.toggle('on', show); elKbToggle.setAttribute('aria-pressed', String(show));
  };

  // ---- browser mirror wiring ----
  // Tap vs swipe on the screenshot: a small, quick press = a click at that point; a drag = a scroll.
  (() => {
    let g = null;
    elBshot.addEventListener('pointerdown', (e) => {
      if (state.tabType !== 'browser') return;
      try { elBshot.setPointerCapture(e.pointerId); } catch (_) {}
      g = { sx: e.clientX, sy: e.clientY, t: Date.now(), max: 0, base: bshotShift };
    });
    elBshot.addEventListener('pointermove', (e) => {
      if (!g) return;
      g.max = Math.max(g.max, Math.abs(e.clientX - g.sx), Math.abs(e.clientY - g.sy));
      if (g.max >= 8) shiftBshot(g.base + (e.clientY - g.sy));   // image follows the finger instantly
    });
    const end = (e) => {
      const gg = g; g = null;
      if (!gg || state.tabType !== 'browser') return;
      if (gg.max < 8 && Date.now() - gg.t < 500) {           // tap -> click
        const f = bshotFrac(e.clientX, e.clientY); if (!f) return;
        bAction('tap', f).then((d) => {
          if (d && d.editable) { resetBtext(d.value || ''); elBtext.focus(); }   // seed with the field's current text
        });
      } else {                                               // drag -> scroll (display px -> page css px)
        const b = elBshot.getBoundingClientRect();
        const pageDy = Math.round(-(e.clientY - gg.sy) * (state.browser.h / (b.height || 1)));
        if (Math.abs(pageDy) > 4) bAction('scroll', { dy: pageDy });
      }
    };
    elBshot.addEventListener('pointerup', end);
    elBshot.addEventListener('pointercancel', () => { g = null; });
  })();
  // Local-echo typing: keystrokes stay in #btext (instant); the remote field syncs on a 350ms debounce.
  // Enter flushes the sync, presses remote Enter (submit), then clears the box. Backspace/edits are
  // just local edits — the whole-value replace sync handles them for free. Arrows move the LOCAL caret
  // (use the d-pad row for remote arrows); Esc/Tab go remote.
  elBtext.addEventListener('input', () => { if (state.tabType === 'browser') scheduleBtextSync(); });
  elBtext.addEventListener('keydown', (e) => {
    if (e.isComposing || state.tabType !== 'browser') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (btextTimer) { clearTimeout(btextTimer); btextTimer = null; }
      Promise.resolve(syncBtext()).then(() => bKey('enter')).then(() => resetBtext(''));
      return;
    }
    const k = { Escape: 'escape', Tab: 'tab' }[e.key];
    if (k) { e.preventDefault(); bKey(k); }
  });
  // Browser footer keys — pointerdown for instant fire; arrows hold-to-repeat.
  elBfoot.querySelectorAll('button[data-bkey]').forEach((b) => {
    const key = b.dataset.bkey; const arrow = /^(up|down|left|right)$/.test(key);
    let iv = null; const stop = () => { if (iv) { clearInterval(iv); iv = null; } };
    b.addEventListener('pointerdown', (e) => { if (e.button != null && e.button > 0) return; e.preventDefault(); stop(); bKey(key); if (arrow) iv = setInterval(() => bKey(key), 160); });
    if (arrow) { b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop); }
    b.onclick = null;
  });
  // URL bar + nav + zoom.
  if (elBGo) elBGo.onclick = () => { const u = normalizeUrl(elBurl.value); if (u) { bAction('nav', { action: 'goto', url: u }); elBurl.blur(); } };
  if (elBurl) elBurl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); elBGo.onclick(); } });
  if (elBBack) elBBack.onclick = () => bAction('nav', { action: 'back' });
  if (elBFwd) elBFwd.onclick = () => bAction('nav', { action: 'forward' });
  if (elBReload) elBReload.onclick = () => bAction('nav', { action: 'reload' });
  if (elBZoomIn) elBZoomIn.onclick = () => bAction('zoom', { dir: 'in' });
  if (elBZoomOut) elBZoomOut.onclick = () => bAction('zoom', { dir: 'out' });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling(); closeBrowserStream();
      if (state.browser.urlTimer) { clearInterval(state.browser.urlTimer); state.browser.urlTimer = null; }
    } else if (state.tab) {
      loadTree();   // tree poll pauses while hidden — refresh it on return
      if (state.tabType === 'browser') { browserStream(state.tab.id); refreshBrowserInfo(); if (!state.browser.urlTimer) state.browser.urlTimer = setInterval(refreshBrowserInfo, 2500); }
      else startPolling(gridCache.get(gridCacheKey(state.tab.id)));   // DOM intact + cached hash → unchanged tab costs ~10 bytes to resume
    }
  });
  window.addEventListener('pagehide', () => { flushGridCache(); stopPolling(); closeBrowserStream(); if (state.browser.urlTimer) { clearInterval(state.browser.urlTimer); state.browser.urlTimer = null; } });

  (async () => {
    updateFontVal();
    setMode('compose');
    // Pre-network paint: show the last-seen grid of the last-viewed tab IMMEDIATELY (localStorage),
    // before any round trip — over a tunnel the boot chain is RTT-bound and used to sit blank.
    try {
      const lt = localStorage.getItem('cmux_last_tab');
      const raw = lt && localStorage.getItem(GRID_LS_PREFIX + lt);
      if (raw) { const d = JSON.parse(raw); if (d && d.grid) { elEmpty.style.display = 'none'; renderGrid(d.grid); setStatus('connecting…'); } }
    } catch (_) {}
    // One round trip: machines + default machine's tree together.
    let boot = null, r = null;
    try { r = await jget('/api/cmux/bootstrap'); } catch (_) { gate('Could not reach the server.'); return; }
    if (r.status === 401) { gate('An access token is required.', true); return; }
    if (r.ok) boot = await r.json().catch(() => null);
    if (!boot) { gate('Could not reach the server.'); return; }
    state.machines = boot.machines || [];
    state.machine = boot.machine || (state.machines[0] && state.machines[0].id) || null;
    const cur = state.machines.find((m) => m.id === state.machine);
    elHost.textContent = (cur && cur.label) || '';
    if (!state.machine) { gate('No machines configured. Set CMUX_MACHINE_URL on the server.'); return; }
    if (boot.error) setStatus(boot.error, true);
    applyTree(boot.workspaces || []);
    state.treeTimer = setInterval(loadTree, 5000);
  })();
})();
