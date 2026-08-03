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
  const cleanToken = (t) => String(t || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  let TOKEN = null;
  try {
    const h = cleanToken(new URLSearchParams(location.hash.slice(1)).get('token'));
    const q = cleanToken(new URLSearchParams(location.search).get('token'));
    const incoming = h || q;
    if (incoming) {
      localStorage.setItem('cmux_token', incoming);
      const u = new URL(location.href);
      u.searchParams.delete('token');
      u.hash = '';
      history.replaceState(null, '', u.pathname + u.search);
    }
    TOKEN = localStorage.getItem('cmux_token');
  } catch (_) {}
  const authHeaders = (h = {}) => (TOKEN ? { ...h, Authorization: 'Bearer ' + TOKEN } : h);
  const noCacheUrl = (url) => url + (url.includes('?') ? '&' : '?') + '_=' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  // `opts` carries ONE thing: {signal}. Every existing caller passes a url alone and is unaffected —
  // auth, credentials and cache stay byte-identical, and `signal: undefined` is what fetch already
  // sees today. It exists because JavaScript silently ignores extra arguments: gitbar's model aborts
  // its superseded probe through this helper (specs.md §5.3), and without the forward it would abort
  // a token object while the HTTP request — and the git children behind it — ran to completion.
  // `|| undefined` rather than the spec's bare `opts && opts.signal`: RequestInit.signal is a
  // NULLABLE AbortSignal in WebIDL, so `null` is fine but any other falsy value — jget(url, 0) —
  // throws a TypeError out of fetch itself. gitbar's own no-AbortController fallback publishes
  // `{signal: null}` (gitbar.js:90), so falsy signals genuinely reach here. Normalising costs
  // nothing and a real signal is an object, so it is never normalised away.
  const jget = (url, opts) => fetch(noCacheUrl(url), { headers: authHeaders({ 'cache-control': 'no-cache' }), credentials: 'same-origin', cache: 'no-store', signal: (opts && opts.signal) || undefined });
  const jpost = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  function promptToken() { const t = cleanToken(prompt('Access token')); if (t) { try { localStorage.setItem('cmux_token', t); } catch (_) {} location.reload(); } }

  const $ = (id) => document.getElementById(id);
  const elTabs = $('tabs'), elPanes = $('panes'), elEmpty = $('empty'), elStatus = $('status'), elJump = $('jump');
  const elText = $('text'), elSend = $('send'), elRefresh = $('refresh'), elFilesBtn = $('filesBtn');
  const elRadarBtn = $('radarBtn'), elInboxBtn = $('inboxBtn');
  const elWsChip = $('wsChip'), elWsLabel = $('wsLabel'), elHost = $('hostLabel'), elWsMenu = $('wsMenu');
  const elKeys = $('keys'), elKbToggle = $('kbToggle'), elHint = $('hint');
  const elModeCompose = $('modeCompose'), elModeLive = $('modeLive');
  const elFooter = document.querySelector('footer'), elModeSeg = $('modeSeg'), elGitBtn = $('gitBtn');
  // Built in JS, not in index.html — see the note in createView about the cache-first shell. Every
  // lookup of a removed element is guarded for the same reason.
  let elLiveToggle = null, elPlusMenu = null;
  const elSettingsBtn = $('settingsBtn'), elSetMenu = $('setMenu');
  const elSplitMenu = $('splitMenu'), elSplitToggle = $('splitToggle');
  const elDropZone = $('dropZone'), elDragGhost = $('dragGhost'), elFileDrop = $('fileDrop');
  const elAttachBtn = $('attachBtn'), elAttachInput = $('attachInput'), elPasteBtn = $('pasteBtn');
  const elFontUp = $('fontUp'), elFontDown = $('fontDown'), elFontVal = $('fontVal'), elFontReset = $('fontReset');
  // browser-mirror elements
  const elBrowser = $('browser'), elBshot = $('bshot'), elBspin = $('bspin');
  const elBurl = $('burl'), elBGo = $('bGo'), elBBack = $('bBack'), elBFwd = $('bFwd'), elBReload = $('bReload');
  const elBZoomIn = $('bZoomIn'), elBZoomOut = $('bZoomOut'), elBtext = $('btext'), elBfoot = $('bfoot');

  const state = {
    machine: null, machines: [],
    workspaces: [],           // [{ ref, id, title, selected, tabs:[…], panes:[{id,ref,tabs:[id]}] }]
    wsRef: null,              // current workspace ref
    tab: null,                // { id, ref } — the FOCUSED surface: what typing, keys and × act on
    menuPane: null,           // pane the ⊞ menu was opened for — every action in it targets this pane
    menuBtn: null,            // the ⊞ button it hangs off, so the right one gets aria-expanded back
    treeTimer: null,
    mode: 'compose',          // 'compose' | 'live'
    zoom: 1,                  // font multiplier on top of the width auto-fit (1 = fit exactly)
    tabType: 'terminal',      // 'terminal' | 'browser' | 'files' | 'viewer' — which surface + footer is active
    browser: { es: null, surface: null, w: 800, h: 600, urlTimer: null },  // browser-surface mirror state
    // ---- multi-pane mirror ----
    layout: null,             // last /api/cmux/layout payload (fractions + derived dividers)
    views: new Map(),         // paneId -> view (one mirrored pane: box, screen, own row cache + stream)
    focusPane: null,          // paneId whose surface the footer drives
    splitPref: 'auto',        // 'auto' (split when the viewport is wide enough) | 'off' (one pane)
    streams: { panes: null, layout: null },
    // ---- per-pane composer (p7 Track A) ----
    composerPane: null,       // paneId the single composer is currently mounted in — the SEND TARGET
    composerFocused: false,   // a layout frame arriving now would yank the keyboard away mid-word
    pendingLayout: null,      // that frame, coalesced to the latest — layouts are state, not deltas
    live: false,              // the mounted composer's live toggle, mirrored from per-surface storage
    lastComposerSurface: null, // survives parking, so an overlay can still fill the right composer
  };
  try { const z = parseFloat(localStorage.getItem('cmux_fontzoom')); if (z > 0) state.zoom = Math.max(0.6, Math.min(3, z)); } catch (_) {}
  try { const sp = localStorage.getItem('cmux_split'); if (sp === 'off' || sp === 'auto') state.splitPref = sp; } catch (_) {}

  // Split view needs room for two readable terminals side by side; below that the mirror shows one
  // pane at a time (the pre-multi-pane behaviour) and the tab strip switches between them.
  const SPLIT_MIN_WIDTH = 700;
  // Ceiling on simultaneously mirrored panes: each one costs a terminal.replay per stream round, and
  // the bridge refuses more than six surfaces on one stream. Extra panes stay reachable from the tab
  // strip — they are just not painted at the same time.
  const MAX_PANES = 6;
  const canSplit = () => state.splitPref !== 'off' && window.innerWidth >= SPLIT_MIN_WIDTH;
  const layoutPanes = () => (state.layout && state.layout.panes) || [];
  const focusedView = () => (state.focusPane && state.views.get(state.focusPane)) || null;

  // p5 radar. Declared up here (not at its section) so renderTabs can test it without a TDZ risk.
  // It stays null unless radar.js loaded AND created cleanly — that null is the entire kill switch.
  let radarUI = null;
  // p9 inbox, same contract and same reason: renderTabs/syncFilesBtn read it, and a null here means
  // the feature is simply absent.
  let inboxUI = null;

  function gate(msg, showToken) {
    const g = $('gate'); g.replaceChildren(); g.style.flexDirection = 'column';
    const p = document.createElement('div'); p.textContent = msg; g.appendChild(p);
    if (showToken) { const a = document.createElement('a'); a.href = '#'; a.textContent = 'Enter access token →'; a.style.marginTop = '16px'; a.onclick = (e) => { e.preventDefault(); promptToken(); }; g.appendChild(a); }
    g.style.display = 'flex';
  }
  // `ms` makes the message transient. Connection state is sticky (it describes a condition that is
  // still true), but an action's confirmation — "copied", "downloading …" — has to clear itself:
  // nothing else repaints the status in Files mode, so a sticky "copied" would sit there all session.
  let statusTimer = null;
  function setStatus(txt, err, ms) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (!txt) { elStatus.hidden = true; return; }
    elStatus.hidden = false; elStatus.textContent = txt; elStatus.classList.toggle('err', !!err);
    if (ms) statusTimer = setTimeout(() => { elStatus.hidden = true; statusTimer = null; }, ms);
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
  // A history row: plain text, default style, no positioned runs — that is all cmux can give for rows
  // older than the replay window (see loadHistory). Tagged `.hist` so it reads as older chrome, and so
  // the menu-tap detector can tell it apart from a live grid row.
  function buildPlainRow(text, def0) {
    const line = document.createElement('div'); line.className = 'trow hist';
    const el = document.createElement('span');
    styleSpan(el, def0, def0);
    el.textContent = text || ' ';
    line.appendChild(el);
    return line;
  }
  function rowSig(spans) {
    let s = '';
    for (const sp of spans) s += sp.column + '' + sp.style_id + '' + sp.text + '';
    return s;
  }
  // Every mirrored pane owns its screen element, row-signature cache, column count and scroll state,
  // so `v` (a view) is what used to be a handful of module globals. One pane repainting never touches
  // another's DOM — that is what lets several terminals stream at once without cross-talk.
  function renderGrid(v, g) {
    if (!v || !g) return;
    const el = v.screenEl;
    const byId = {}; (g.styles || []).forEach((s) => { byId[s.id] = s; });
    const def0 = byId[0];
    if (def0 && def0.background) el.style.background = def0.background;
    const byRow = {}; (g.spans || []).forEach((sp) => { (byRow[sp.row] = byRow[sp.row] || []).push(sp); });
    let rows = g.rows || 0;
    if (!rows) (g.spans || []).forEach((sp) => { if (sp.row + 1 > rows) rows = sp.row + 1; });

    // scale font so the source terminal's columns fill THIS pane's width (before measuring line height)
    if (g.columns && g.columns > 1) { v.cols = g.columns; fitFont(v); }

    // fill blank rows so a short source grid still occupies the pane (phones). Not needed once history
    // sits above it: the grid is already pinned to the bottom of a long scroll, and padding would only
    // add dead space under the prompt.
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 13;
    const lh = parseFloat(cs.lineHeight) || fs * 1.32;
    const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
    const hist = (v.hist && v.hist.length) ? v.hist : null;
    const off = hist ? hist.length : 0;
    const fillRows = off ? rows : Math.max(rows, Math.ceil(Math.max(0, el.clientHeight - padY) / lh));

    // patch row-by-row: only rebuild rows whose signature changed → preserves selection + scroll
    const kids = el.childNodes;
    // History rows come FIRST and are keyed by their own text, so a live grid frame never rebuilds them.
    // Rebuilding ~1700 nodes four times a second would make the pane unreadable and eat the phone.
    for (let r = 0; r < off; r++) {
      const sig = 'H' + hist[r];
      if (v.rowSig[r] === sig && kids[r]) continue;
      const node = buildPlainRow(hist[r], def0);
      if (kids[r]) el.replaceChild(node, kids[r]); else el.appendChild(node);
      v.rowSig[r] = sig;
    }
    for (let r = 0; r < fillRows; r++) {
      const spans = (byRow[r] || []).sort((a, b) => a.column - b.column);
      const sig = spans.length ? rowSig(spans) : '';
      const i = off + r;
      if (v.rowSig[i] === sig && kids[i]) continue;
      const node = buildRow(spans, byId, def0);
      if (kids[i]) el.replaceChild(node, kids[i]); else el.appendChild(node);
      v.rowSig[i] = sig;
    }
    while (el.childNodes.length > off + fillRows) { el.removeChild(el.lastChild); v.rowSig.pop(); }
    v.histLen = off;
    // The replay window slides forward as output arrives, so rows scroll OUT of the styled grid and the
    // history block no longer reaches it — a gap would open at the seam. The grid's top row changing
    // identity is exactly that event; refetch (throttled) rather than let the pane lie about its past.
    const topSig = v.rowSig[off] || '';
    if (off && v.histTopSig && topSig && topSig !== v.histTopSig) refreshHistory(v);
    v.histTopSig = topSig;

    // Follow the tail, which is what a terminal does.
    //
    // This used to pin new panes to the TOP, because a cmux grid carries the desktop terminal's
    // trailing BLANK rows and scrolling to scrollHeight parks you in that empty space. But the pin
    // forced scrollTop = 0 on every repaint, and the scroll event fired by that very set reads
    // scrollTop === 0 — so it never cleared itself, and the pane stayed stuck at the top until the
    // reader scrolled by hand. The operator: "I seem to always need to click jump to bottom."
    //
    // Both concerns are satisfied by scrolling to the last row that has CONTENT rather than to the
    // raw bottom: the prompt sits at the bottom edge, no dead space below it.
    if (v.followTail !== false) scrollToTail(v, el, lh, padY);
    if (v === focusedView()) updateJump();
  }
  // Put the last row that has content at the bottom edge. A cmux grid is the whole desktop viewport,
  // so its tail is usually blank padding — scrolling to scrollHeight shows that emptiness and hides
  // the prompt, which is what the old top-pin was trying to avoid.
  function scrollToTail(v, el, lh, padY) {
    let last = -1;
    for (let i = v.rowSig.length - 1; i >= 0; i--) if (v.rowSig[i]) { last = i; break; }
    if (last < 0) { el.scrollTop = 0; return; }
    // Rows WRAP on narrow panes (#screen is pre-wrap, and the 7px font floor / user zoom can make
    // a row wider than the pane), so (index * lineHeight) undercounts pixels and the "tail" lands
    // mid-content — the reader is yanked up off the bottom on every repaint. Measure the row's
    // real box instead; the arithmetic stays only as a fallback for a not-yet-painted node.
    const node = el.childNodes[last];
    const wantBottom = node && node.getBoundingClientRect
      ? node.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop
      : (last + 1) * lh + (padY || 0);
    const target = Math.max(0, Math.min(el.scrollHeight, wantBottom - el.clientHeight));
    if (Math.abs(el.scrollTop - target) < 1) return;
    // Our own scroll fires a scroll EVENT, and the listener would read "not at the bottom" — the
    // target sits above the trailing blank rows — and switch following back off after one frame.
    // Same self-defeating shape as the old top-pin. Suppress the echo.
    v.autoScrolling = true;
    el.scrollTop = target;
    requestAnimationFrame(() => { v.autoScrolling = false; });
  }

  // "At the tail" means the last row WITH CONTENT is on screen — not that the scrollbar has reached
  // the bottom of the blank padding cmux sends after it. Scrolling to the real bottom is something
  // a reader almost never does, so keying `followTail` on it alone made following stick off.
  function isNearTail(v, el) {
    let last = -1;
    for (let i = v.rowSig.length - 1; i >= 0; i--) if (v.rowSig[i]) { last = i; break; }
    if (last < 0) return true;
    const rows = el.childNodes;
    const node = rows[last];
    if (!node || !node.getBoundingClientRect) return true;
    return node.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 40;
  }

  function clearScreen(v) {
    if (!v) return;
    v.screenEl.replaceChildren(); v.rowSig = []; v.screenEl.style.background = '';
    // History belongs to the surface that was in this pane, not to the pane.
    v.hist = null; v.histLen = 0; v.histTopSig = null; v.histAt = 0;
  }

  // ---- deep scrollback: 2000 rows per pane ------------------------------------
  // cmux caps `terminal.replay` at 240 scrollback rows and takes no parameter to raise it (measured on
  // 0.64.19 against a 3000-line buffer). So a pane that attaches shows one screen plus 240 rows, which
  // is where "a pane loading just one small window's worth" comes from — and on a full-screen TUI
  // (`active_screen: "alternate"`) cmux reports ZERO scrollback by design, so it really is one screen.
  //
  // The rows above that window come from the bridge's /history route (read-screen text, aligned to the
  // styled grid by content) and are painted as unstyled rows on top of it — see buildPlainRow. They are
  // fetched ONCE per surface, never on the streaming frames: 1700 rows of text on every repaint would be
  // ~200KB four times a second over the tunnel, which is the exact cost the hash-dedupe exists to avoid.
  const HISTORY_ROWS = 2000;        // what a pane is expected to remember, per the operator
  const HISTORY_MIN_GAP_MS = 4000;  // floor between refetches for one pane (each is a cmux read-screen)
  function refreshHistory(v) {
    if (!v || !v.surfaceId) return;
    if (Date.now() - (v.histAt || 0) < HISTORY_MIN_GAP_MS) return;
    loadHistory(v, v.surfaceId);
  }
  async function loadHistory(v, sid) {
    if (!v || !sid || !state.machine || v.histBusy) return;
    v.histBusy = true;
    v.histAt = Date.now();
    try {
      const r = await jget('/api/cmux/history?machine=' + encodeURIComponent(state.machine)
        + '&surface=' + encodeURIComponent(sid) + '&rows=' + HISTORY_ROWS);
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !Array.isArray(d.rows)) return;
      // The pane may have switched surfaces while this was in flight; the answer describes the OLD one.
      if (v.surfaceId !== sid) return;
      if (!d.rows.length) { if (!v.hist) v.hist = null; return; }
      // Prepending rows pushes everything down. Following the tail absorbs that (scrollToTail runs on
      // the same frame); a reader who has scrolled up would be yanked, so leave them where they are and
      // let the next attach or tail-follow pick the history up.
      if (v.followTail === false) return;
      v.hist = d.rows;
      if (v.lastGrid) renderGrid(v, v.lastGrid);
    } catch (_) { /* history is an enrichment — a pane without it is the old behaviour, not a failure */ }
    finally { v.histBusy = false; }
  }

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
  function paintFromCache(v, sid) {   // -> the cache entry if painted, else null
    const c = cacheEntry(gridCacheKey(sid));
    if (!c) return null;
    try { const d = JSON.parse(c.raw); if (d && d.grid) { renderGrid(v, d.grid); return c; } } catch (_) {}
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
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width; s.remove();
    _charRatio = w ? (w / 100) / 100 : 0.6;   // width per char, per px of font-size
    return _charRatio;
  }
  function fitFont(v) {
    if (!v) return;
    const cols = v.cols;
    if (!cols || cols < 2) return;
    const el = v.screenEl;
    const cs = getComputedStyle(el);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    const avail = el.clientWidth - padX;
    if (avail <= 0) return;
    // Baseline = font at which the source columns exactly fill the width. Clamp the BASELINE to a
    // readable floor FIRST, then apply the user's zoom. If we instead multiplied then floored (the old
    // order), a wide source terminal on a narrow phone gives a ~3px baseline and the 7px floor swallows
    // the whole zoom range — A+/A− bump the % label but the text stays pinned at 7px. #screen is
    // white-space: pre-wrap, so a baseline wider than the viewport wraps rather than overflowing.
    const base = Math.max(7, Math.min(avail / (cols * charRatio()), 48));
    const fs = Math.max(7, Math.min(base * state.zoom, 72));
    el.style.fontSize = fs.toFixed(2) + 'px';
  }
  const fitAllFonts = () => { for (const v of state.views.values()) fitFont(v); };

  // ---- font zoom (settings) ----
  function updateFontVal() { if (elFontVal) elFontVal.textContent = Math.round(state.zoom * 100) + '%'; }
  function applyZoom() {
    try { localStorage.setItem('cmux_fontzoom', String(state.zoom)); } catch (_) {}
    updateFontVal();
    fitAllFonts();
    for (const v of state.views.values()) if (v.followTail) v.screenEl.scrollTop = v.screenEl.scrollHeight;
    updateJump();
  }
  function nudgeZoom(mult) {
    const next = Math.max(0.6, Math.min(3, +(state.zoom * mult).toFixed(3)));
    if (next === state.zoom) return;
    state.zoom = next; applyZoom();
  }
  function resetZoom() { if (state.zoom === 1) return; state.zoom = 1; applyZoom(); }

  // ---- split popover (⊞) ----
  function popoverUnder(btn, menu) {
    menu.hidden = false;
    const rc = btn.getBoundingClientRect();
    menu.style.left = 'auto';
    menu.style.right = Math.max(8, Math.round(window.innerWidth - rc.right)) + 'px';
    menu.style.top = Math.round(rc.bottom + 6) + 'px';
    btn.setAttribute('aria-expanded', 'true');
  }
  // The pane menu is opened FROM a pane's ⊞ button and every action in it applies to THAT pane —
  // cmux keeps its split controls on the pane, and a mirror with per-pane headers has no reason for a
  // second, global one. state.menuPane is the pane it was opened for.
  function openPaneMenu(btn, paneId) {
    closeWsMenu(); closeSettings();
    state.menuPane = paneId || state.focusPane || null;
    state.menuBtn = btn;
    const t = $('splitMenuTitle');
    if (t) t.textContent = 'Split ' + (paneTitle(paneSelectedSurface(state.menuPane)) || 'this pane');
    popoverUnder(btn, elSplitMenu);
  }
  function closeSplitMenu() {
    if (!elSplitMenu) return;
    elSplitMenu.hidden = true;
    if (state.menuBtn) state.menuBtn.setAttribute('aria-expanded', 'false');
    state.menuBtn = null;
  }
  function paneSelectedSurface(paneId) {
    const v = paneId && state.views.get(paneId);
    if (v && v.surfaceId) return v.surfaceId;
    const p = layoutPanes().find((x) => x.id === paneId);
    return (p && p.selectedSurface) || null;
  }

  // ---- settings popover (gear) ----
  function updateSplitToggle() { if (elSplitToggle) elSplitToggle.textContent = state.splitPref === 'off' ? 'Off' : 'Auto'; }
  function openSettings() {
    closeWsMenu(); closeSplitMenu(); updateFontVal(); updateSplitToggle();
    elSetMenu.hidden = false;
    const rc = elSettingsBtn.getBoundingClientRect();
    elSetMenu.style.left = 'auto';
    elSetMenu.style.right = Math.max(8, Math.round(window.innerWidth - rc.right)) + 'px';
    elSetMenu.style.top = Math.round(rc.bottom + 6) + 'px';
    elSettingsBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSettings() { elSetMenu.hidden = true; elSettingsBtn.setAttribute('aria-expanded', 'false'); }
  function toggleSettings() { if (elSetMenu.hidden) openSettings(); else closeSettings(); }
  // The jump chip belongs to the pane the footer is driving — a background pane scrolled up is its
  // own business, and one chip per pane would be noise.
  function updateJump() {
    const v = focusedView();
    if (!v) { elJump.classList.remove('show'); return; }
    const el = v.screenEl;
    // Keyed on the last row WITH CONTENT, not on the scrollbar reaching the end of the blank
    // padding — otherwise the chip shouts "jump to bottom" while you are already reading the tail.
    const atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight < 40) || isNearTail(v, el);
    elJump.classList.toggle('show', !atBottom);
  }

  // ---- tree: workspaces + tabs ----
  function applyTree(workspaces) {
    state.workspaces = workspaces || [];

    // resolve current workspace: keep it if still present, else cmux's selected, else first
    let ws = state.workspaces.find((w) => w.ref === state.wsRef)
          || state.workspaces.find((w) => w.selected)
          || state.workspaces[0] || null;
    const wsChanged = state.wsRef !== (ws ? ws.ref : null);
    state.wsRef = ws ? ws.ref : null;
    renderHeader();
    renderTabs();

    if (!ws) { teardownPanes(); elEmpty.style.display = 'flex'; return; }
    if (wsChanged) syncLayout(true);
    // resolve the focused tab within the workspace: keep by id, else running, else selected, else first
    const tabs = ws.tabs || [];
    let keep = state.tab && tabs.find((t) => t.id === state.tab.id);
    if (!keep) {
      const term = tabs.filter((t) => t.type !== 'browser');
      keep = term.find((t) => /run|need/i.test(t.status || '')) || term.find((t) => t.inPane || t.selected) || term[0] || null;
    }
    if (keep) {
      // A tree refresh must not steal the screen from a full-bleed pane the user deliberately
      // opened. selectTab() calls exitRadarMode()/exitFilesMode(), so without this guard any tab
      // whose status changes upstream (a session starts running, a tab is added) silently closes
      // Radar or Files mid-read — on a live board that is every few seconds. Track the resolved
      // tab so leaving lands on the right surface, but do not switch to it now.
      const owned = state.tabType === 'radar' || state.tabType === 'inbox' || state.tabType === 'files' || state.tabType === 'viewer';
      if (!state.tab || state.tab.id !== keep.id) {
        if (owned) state.tab = { id: keep.id, ref: keep.ref };
        else selectTab(keep.id);
      } else { state.tab.ref = keep.ref; if (!owned) renderPanes(); }
    } else {
      state.tab = null; teardownPanes(); elEmpty.style.display = 'flex'; setStatus('');
    }
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
      // Rename lives HERE because the header label is the dropdown's trigger — tapping it has to open
      // the list, so it can never also be an edit target. cmux names an unnamed workspace after
      // whatever tab is in front of it, which is why three of them can read "Claude Code".
      const pen = document.createElement('span'); pen.className = 'wsedit'; pen.textContent = '✎';
      pen.setAttribute('role', 'button'); pen.setAttribute('aria-label', 'Rename workspace');
      pen.title = 'Rename workspace';
      pen.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeWsMenu(); doRenameWorkspace(w); };
      const x = document.createElement('span'); x.className = 'wsclose'; x.textContent = '×';
      x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Close workspace');
      x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeWsMenu(); doCloseWorkspace(w); };
      b.append(dot, nm, pen, x);
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
    state.machine = id; state.wsRef = null; state.tab = null; state.focusPane = null; state.layout = null;
    teardownPanes(); stopLayoutStream();
    const cur = state.machines.find((m) => m.id === id); elHost.textContent = (cur && cur.label) || '';
    elEmpty.style.display = 'flex'; setStatus('');
    loadTree();
  }
  function selectWorkspace(ref) {
    if (ref === state.wsRef) return;
    if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
    state.wsRef = ref; state.tab = null; state.focusPane = null; state.layout = null;
    teardownPanes(); stopLayoutStream(); setStatus('');
    renderHeader(); renderTabs();
    syncLayout(true);
    const ws = currentWs();
    const tabs = (ws && ws.tabs) || [];
    const term = tabs.filter((t) => t.type !== 'browser');
    const first = term.find((t) => /run|need/i.test(t.status || '')) || term.find((t) => t.inPane || t.selected) || term[0];
    if (first) selectTab(first.id); else { elEmpty.style.display = 'flex'; }
  }

  // ---- tabs ----
  // A chip is `on` when it is the FOCUSED surface (what the footer drives) and `vis` when some other
  // pane is currently mirroring it — without that, a split view looks like every tab but one is idle.
  function renderTabs() {
    const ws = currentWs();
    const tabs = (ws && ws.tabs) || [];
    const shown = new Set();
    for (const v of state.views.values()) if (v.surfaceId) shown.add(v.surfaceId);
    const kids = [];
    tabs.forEach((t) => {
      const b = document.createElement('button');
      const isBrowser = t.type === 'browser';
      const isFocused = state.tab && t.id === state.tab.id;
      b.className = 'tab' + (isFocused ? ' on' : (shown.has(t.id) ? ' vis' : '')) + (/run|need/i.test(t.status || '') ? ' run' : '') + (isBrowser ? ' browser' : '');
      b.type = 'button'; b.title = t.title || t.ref || t.id;
      const dot = document.createElement('span'); dot.className = 'dot'; b.appendChild(dot);
      b.dataset.id = t.id;   // addressable from tests and from Radar's Jump
      const label = document.createElement('span'); label.className = 'label'; label.textContent = t.title || t.ref || t.id; b.appendChild(label);
      if (isBrowser) { const tag = document.createElement('span'); tag.className = 'btag'; tag.textContent = 'browser'; b.appendChild(tag); }
      const close = document.createElement('span'); close.className = 'close'; close.textContent = '×';
      close.setAttribute('aria-label', 'Close tab'); close.setAttribute('role', 'button');
      close.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doCloseTab(t); };
      b.appendChild(close);
      b.onclick = () => selectTab(t.id);
      kids.push(b);
    });
    // The strip only shows in the one-pane view, and there is no pane header to hang controls off,
    // so the "new tab" affordances live at the end of it. (In split view each pane header carries
    // its own ⊞ menu instead, and the Files toggle sits in the toolbar for both.)
    if (ws) {
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'tab add'; b.type = 'button'; b.title = title; b.textContent = label;
        b.onclick = fn;
        return b;
      };
      kids.push(mk('+', 'New terminal tab', () => doNewTab()));
      kids.push(mk('+🌐', 'New browser tab', () => doNewBrowser()));
    }
    elTabs.replaceChildren(...kids);
    syncFilesBtn();
  }
  // The Files toggle moved from the strip (which is now one-pane-only) to the toolbar, so it has to
  // show its on/off state there instead.
  // Radar's toolbar chip carries its own on/off state, exactly like Files.
  function syncRadarBtn() {
    if (!elRadarBtn) return;
    const inRadar = state.tabType === 'radar';
    elRadarBtn.setAttribute('aria-pressed', inRadar ? 'true' : 'false');
    elRadarBtn.title = inRadar ? 'Hide radar' : 'Radar';
  }
  // The inbox chip carries its own on/off state too — same toolbar, same contract.
  function syncInboxBtn() {
    if (!elInboxBtn) return;
    const inInbox = state.tabType === 'inbox';
    elInboxBtn.setAttribute('aria-pressed', inInbox ? 'true' : 'false');
    elInboxBtn.title = inInbox ? 'Hide inbox' : 'Inbox';
  }
  function syncFilesBtn() {
    syncRadarBtn();
    syncInboxBtn();
    if (!elFilesBtn) return;
    const inFiles = state.tabType === 'files' || state.tabType === 'viewer';
    elFilesBtn.setAttribute('aria-pressed', inFiles ? 'true' : 'false');
    elFilesBtn.title = inFiles ? 'Hide file explorer' : 'Browse files';
  }
  function findTab(id) { const ws = currentWs(); return ws && (ws.tabs || []).find((t) => t.id === id) || null; }
  function selectTab(id) {
    const t = findTab(id); if (!t) return;
    // Selecting any real surface means leaving Files. The files/viewer panes are absolutely
    // positioned at z-index 3 over #wrap, so a stale body class leaves them covering a terminal
    // that is mirroring perfectly well underneath — indistinguishable from "the tab didn't switch".
    exitFilesMode();
    exitRadarMode();
    exitInboxMode();
    const isBrowser = t.type === 'browser';
    const sameTab = state.tab && state.tab.id === id;
    state.tab = { id: t.id, ref: t.ref };
    if (t.pane) state.focusPane = t.pane;
    elEmpty.style.display = 'none';
    if (isBrowser) {
      state.tabType = 'browser';
      renderTabs();
      enterBrowserMode(t, sameTab);
    } else {
      if (state.tabType === 'browser') exitBrowserMode();
      state.tabType = 'terminal';
      try { localStorage.setItem('cmux_last_tab', gridCacheKey(t.id)); } catch (_) {}   // cold-boot pre-paint target
      elText.disabled = false; elSend.disabled = false;
      renderPanes();
      renderTabs();
    }
    // Make the Mac follow: select this surface inside its pane, and focus that pane. The mirror is
    // bidirectional — a tab picked on the phone is the tab you find in front of you on the desktop.
    pushFocus(t);
  }

  // ---- panes: one mirrored terminal per cmux pane ----------------------------
  // Layout comes from the bridge as fractions of a bounding box, so a pane box is just percentages —
  // that reproduces ANY split tree (including nested ones) without the client knowing the tree at all.
  function viewSurfaceFor(p) {
    if (state.focusPane === p.id && state.tab) return state.tab.id;    // the tab you picked wins
    return p.selectedSurface || null;
  }
  function viewBySurface(sid) {
    for (const v of state.views.values()) if (v.surfaceId === sid) return v;
    return null;
  }
  // Which panes to paint: every one when there is room, otherwise just the focused pane blown up to
  // full size — the phone keeps the one-terminal-at-a-time behaviour the tab strip was built for.
  //
  // A SINGLE pane still takes the split view when the viewport is wide enough. It used to fall through
  // to the solo branch (`panes.length > 1`), which meant a freshly created workspace — one pane, always —
  // came up in the phone layout on a desktop: pill strip on top, no pane header, no ⊞ menu, and the only
  // way out was to split it. The layout is a property of the VIEWPORT, not of how many panes happen to
  // exist right now.
  function visiblePanes() {
    const panes = layoutPanes();
    if (!panes.length) return [];
    if (canSplit()) {
      if (panes.length <= MAX_PANES) return panes;
      // keep the focused pane visible even if it sits past the cap, and say so rather than silently
      // dropping panes off the mirror
      const head = panes.slice(0, MAX_PANES);
      const f = panes.find((p) => p.id === state.focusPane);
      if (f && !head.includes(f)) head[MAX_PANES - 1] = f;
      setStatus('mirroring ' + MAX_PANES + ' of ' + panes.length + ' panes');
      return head;
    }
    const f = panes.find((p) => p.id === state.focusPane)
          || panes.find((p) => state.tab && p.selectedSurface === state.tab.id)
          || panes.find((p) => p.focused) || panes[0];
    return f ? [{ ...f, x: 0, y: 0, w: 1, h: 1, solo: true }] : [];
  }
  function createView(p) {
    const box = document.createElement('div');
    box.className = 'pane';
    const head = document.createElement('div');
    head.className = 'phead';
    const screen = document.createElement('div');
    screen.className = 'pscreen';
    // The footer is built HERE, in JS, with no markup dependency on index.html. index.html is served
    // cache-first and app.js network-first, so for at least one launch after a deploy fresh code runs
    // against a stale shell — and code that reaches for elements the shell does not have yet throws
    // at wire-up, which is a dead mirror rather than a missing feature.
    const foot = document.createElement('div');
    foot.className = 'pfoot';
    box.append(head, screen, foot);
    elPanes.appendChild(box);
    const v = { paneId: p.id, paneRef: p.ref, surfaceId: null, el: box, headEl: head, screenEl: screen, footEl: foot,
      rowSig: [], cols: 0, followTail: true, lastRaw: null, lastHash: null,
      // deep scrollback (loadHistory): the plain rows above the 240 the replay window can carry
      hist: null, histLen: 0, histTopSig: null, histAt: 0, histBusy: false };
    screen.addEventListener('scroll', () => {
      // Only a HUMAN scroll decides whether to keep following. scrollToTail sets scrollTop itself,
      // and its target sits above the grid's trailing blank rows, so treating that echo as a reader
      // action would turn following off one frame after turning it on.
      if (v.autoScrolling) { if (v === focusedView()) updateJump(); return; }
      const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
      v.followTail = atBottom || isNearTail(v, screen);
      if (v === focusedView()) updateJump();
      closeWsMenu();
    }, { passive: true });
    wirePaneTaps(v);
    wirePaneDrag(v);
    state.views.set(p.id, v);
    return v;
  }
  function destroyView(id) {
    const v = state.views.get(id);
    if (!v) return;
    v.el.remove();
    state.views.delete(id);
  }
  function teardownPanes() {
    // The composer is a CHILD of a pane now, so removing panes would remove it from the document —
    // and the Files, Radar and source-control overlays all tear panes down. Park it back on the app
    // shell first; mountComposer re-parents it when panes exist again. Without this, opening the git
    // panel deletes the box its own generated command is supposed to land in.
    parkComposer();
    for (const id of [...state.views.keys()]) destroyView(id);
    elPanes.querySelectorAll('.phandle').forEach((h) => h.remove());
    stopPaneStream();
  }
  function paneTitle(sid) {
    const t = sid && findTab(sid);
    return t ? (t.title || t.ref || sid) : '';
  }
  function updateView(v, p) {
    v.paneRef = p.ref;
    v.el.style.left = (p.x * 100).toFixed(3) + '%';
    v.el.style.top = (p.y * 100).toFixed(3) + '%';
    v.el.style.width = (p.w * 100).toFixed(3) + '%';
    v.el.style.height = (p.h * 100).toFixed(3) + '%';
    v.el.classList.toggle('solo', !!p.solo);
    const want = viewSurfaceFor(p);
    if (want && want !== v.surfaceId) {
      // pane now shows a different surface (switched here or on the Mac): repaint from cache first so
      // the swap is instant, then let the stream delta-patch it
      v.surfaceId = want;
      clearScreen(v);
      v.followTail = true;              // a surface arriving in a pane follows its tail, like a terminal
      const cached = paintFromCache(v, want);
      v.lastRaw = cached ? cached.raw : null;
      v.lastHash = cached ? cached.h : null;
      loadHistory(v, want);             // every pane remembers 2000 rows, not one screen plus cmux's 240
    }
    const tab = v.surfaceId && findTab(v.surfaceId);
    const label = paneTitle(v.surfaceId) || p.ref;
    v.headEl.replaceChildren();
    // the grip is only advertising — the whole header band is draggable (wirePaneDrag), because a
    // 6px target is not a touch target
    const grip = document.createElement('span');
    grip.className = 'pgrip'; grip.textContent = '⠿'; grip.setAttribute('aria-hidden', 'true');
    const dot = document.createElement('span');
    dot.className = 'pdot' + (tab && /run|need/i.test(tab.status || '') ? ' run' : '');
    const name = document.createElement('span');
    name.className = 'pname'; name.textContent = label;
    v.headEl.append(grip, dot, name);
    // sibling tabs of THIS pane, so a pane with several tabs can be switched without leaving the split
    const ws = currentWs();
    const paneTabs = ((ws && ws.tabs) || []).filter((t) => t.pane === p.id);
    if (paneTabs.length > 1) {
      const strip = document.createElement('span');
      strip.className = 'pchips';
      for (const t of paneTabs) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'pchip' + (t.id === v.surfaceId ? ' on' : '');
        c.dataset.surface = t.id;             // so a chip can be DRAGGED out, not just tapped
        c.title = t.title || t.ref;
        c.textContent = (t.title || t.ref || '').slice(0, 14) || '·';
        c.onclick = (e) => { e.stopPropagation(); selectTab(t.id); };
        strip.appendChild(c);
      }
      v.headEl.appendChild(strip);
    }
    // per-pane actions (cmux puts them on the pane, so the mirror does too): this pane's ⊞ menu and
    // a direct kill. They are buttons INSIDE the drag grip, so their clicks must not start a drag —
    // wirePaneDrag ignores a pointerdown that lands on .pact.
    const acts = document.createElement('span');
    acts.className = 'pacts';
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button'; menuBtn.className = 'pact'; menuBtn.textContent = '⊞';
    menuBtn.title = 'Split / new tab / close'; menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      if (!elSplitMenu.hidden && state.menuPane === p.id) return closeSplitMenu();
      openPaneMenu(menuBtn, p.id);
    };
    const killBtn = document.createElement('button');
    killBtn.type = 'button'; killBtn.className = 'pact kill'; killBtn.textContent = '×';
    killBtn.title = 'Close this pane'; killBtn.setAttribute('aria-label', 'Close this pane');
    killBtn.onclick = (e) => { e.stopPropagation(); doClosePane(p.id); };
    acts.append(menuBtn, killBtn);
    v.headEl.appendChild(acts);
    fitFont(v);
  }
  function updateFocusStyles() {
    for (const [id, v] of state.views) v.el.classList.toggle('focus', id === state.focusPane);
  }
  // Drag handles are rebuilt from the layout every time it changes — a divider is a derived thing, so
  // there is nothing to keep in sync by hand.
  function renderHandles(panes) {
    elPanes.querySelectorAll('.phandle').forEach((h) => h.remove());
    const l = state.layout;
    if (!l || l.estimated || panes.length < 2 || !canSplit()) return;
    for (const hd of (l.handles || [])) {
      const el = document.createElement('div');
      el.className = 'phandle ' + hd.axis;
      if (hd.axis === 'x') {
        el.style.left = (hd.pos * 100).toFixed(3) + '%';
        el.style.top = (hd.start * 100).toFixed(3) + '%';
        el.style.height = ((hd.end - hd.start) * 100).toFixed(3) + '%';
      } else {
        el.style.top = (hd.pos * 100).toFixed(3) + '%';
        el.style.left = (hd.start * 100).toFixed(3) + '%';
        el.style.width = ((hd.end - hd.start) * 100).toFixed(3) + '%';
      }
      el.setAttribute('role', 'separator');
      el.setAttribute('aria-orientation', hd.axis === 'x' ? 'vertical' : 'horizontal');
      wireHandleDrag(el, hd);
      elPanes.appendChild(el);
    }
  }
  // `body.solo` = the one-pane view: a viewport too narrow to split (phones), or Split view: Off.
  // The tab strip is shown ONLY there — in split view every pane header is its own switcher and the
  // strip would be duplicate chrome. It is keyed on the VIEWPORT alone: keying it on the pane count as
  // well put a wide desktop into the phone layout for every single-pane workspace, which is what every
  // new workspace is.
  function syncSoloClass() {
    document.body.classList.toggle('solo', !canSplit());
  }
  function renderPanes() {
    syncSoloClass();
    // the browser mirror and the file explorer are full-bleed overlays — they own the screen while up
    if (state.tabType !== 'terminal') return;
    const panes = visiblePanes();
    if (!panes.length) { teardownPanes(); elEmpty.style.display = 'flex'; return; }
    elEmpty.style.display = 'none';
    const wanted = new Set(panes.map((p) => p.id));
    for (const id of [...state.views.keys()]) if (!wanted.has(id)) destroyView(id);
    if (!state.focusPane || !wanted.has(state.focusPane)) {
      const f = panes.find((p) => state.tab && p.selectedSurface === state.tab.id)
             || panes.find((p) => p.focused) || panes[0];
      state.focusPane = f ? f.id : null;
    }
    for (const p of panes) updateView(state.views.get(p.id) || createView(p), p);
    renderHandles(panes);
    updateFocusStyles();
    syncPaneStreams();
    updateJump();
    // THE COMPOSER FOLLOWS THE FOCUSED PANE. The operator: "the active pane should get the text input, I
    // shouldn't have to hunt for the thin bar at the bottom and click that." Tapping a pane, picking
    // a tab, or the Mac moving focus all point the box at that pane — the footer bars stay as the
    // indicator of which pane owns it, not as the only way to move it.
    // Drafts are keyed by SURFACE, so nothing is lost when it moves.
    const target = state.views.has(state.focusPane) ? state.focusPane : (panes[0] && panes[0].id);
    if (target) mountComposer(target);
  }

  // Focus a pane from the mirror: the footer switches to its surface AND the Mac follows.
  function focusPane(paneId) {
    const p = layoutPanes().find((x) => x.id === paneId);
    if (!p || state.focusPane === paneId) return;
    // Resolve the target surface BEFORE moving focus: viewSurfaceFor() lets the focused pane follow
    // state.tab, so asking it after the switch would just hand back the tab we are moving away from.
    const v = state.views.get(paneId);
    const sid = (v && v.surfaceId) || p.selectedSurface;
    state.focusPane = paneId;
    mountComposer(paneId);          // the box goes where the attention went
    const t = sid && findTab(sid);
    if (t) { state.tab = { id: t.id, ref: t.ref }; pushFocus(t); }
    else if (state.wsRef) pushPaneFocus(paneId);
    updateFocusStyles();
    renderTabs();
    updateJump();
  }
  let focusInFlight = null;
  function pushPaneFocus(paneId) {
    const ws = currentWs();
    if (!ws || !state.machine) return;
    jpost('/api/cmux/focus-pane', { machine: state.machine, pane: paneId, workspace: ws.id }).catch(() => {});
  }
  // Selecting a tab in the mirror selects it on the Mac too. Skipped when cmux already agrees, so the
  // 5s tree poll (which re-affirms the current tab) never turns into a stream of focus commands.
  function pushFocus(t) {
    if (!state.machine || !t) return;
    const p = layoutPanes().find((x) => x.id === t.pane);
    const already = p && p.selectedSurface === t.id && (p.focused || state.views.size <= 1);
    if (already || focusInFlight === t.id) return;
    focusInFlight = t.id;
    jpost('/api/cmux/focus-surface', { machine: state.machine, surface: t.id })
      .catch(() => {})
      .finally(() => { if (focusInFlight === t.id) focusInFlight = null; setTimeout(syncLayout, 250); });
  }

  // ---- layout sync: the desktop's splits, mirrored ---------------------------
  // /api/cmux/layout-stream pushes a frame whenever the geometry moves, so a split created — or a
  // divider dragged — ON THE MAC lands here without polling. The one-shot /layout is used for the
  // immediate refresh after an action of our own (a drag commit, a new split) rather than waiting for
  // the stream's next tick.
  let layoutBusy = false;
  async function syncLayout(force) {
    const ws = currentWs();
    if (!ws || !state.machine || layoutBusy) return;
    if (!force && document.hidden) return;
    layoutBusy = true;
    try {
      const qs = '/api/cmux/layout?machine=' + encodeURIComponent(state.machine)
        + '&workspace=' + encodeURIComponent(ws.id)
        + (state.layout && state.layout.h && !force ? '&h=' + encodeURIComponent(state.layout.h) : '');
      const r = await jget(qs);
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (!d || d.same || d.error) return;
      applyLayout(d);
    } catch (_) { /* the stream (or the next call) retries */ }
    finally { layoutBusy = false; }
  }
  function applyLayout(l) {
    if (!l || !Array.isArray(l.panes)) return;
    const ws = currentWs();
    if (!ws || (l.workspace && l.workspace !== ws.id && l.workspace !== ws.ref)) return;  // late frame from the previous workspace
    state.layout = l;
    if (!state.streams.layout || state.streams.layout.wsRef !== state.wsRef) startLayoutStream();
    if (dragging) return;      // never yank the boxes out from under a finger mid-drag
    // Same for a composer in use: re-rendering destroys the focused pane's DOM and iOS dismisses the
    // keyboard mid-word. The frame is HELD, not dropped — and only the latest is held, because a
    // layout frame is absolute state, so replaying a queue would paint geometry that is already
    // stale. It applies when the composer is put down.
    if (state.composerFocused) { state.pendingLayout = l; return; }
    renderPanes();
    renderTabs();
  }
  function startLayoutStream() {
    stopLayoutStream();
    const ws = currentWs();
    if (!ws || !state.machine) return;
    let url = '/api/cmux/layout-stream?machine=' + encodeURIComponent(state.machine)
      + '&workspace=' + encodeURIComponent(ws.id);
    if (TOKEN) url += '&token=' + encodeURIComponent(TOKEN);   // EventSource can't set headers
    let es;
    try { es = new EventSource(url); } catch (_) { return; }
    const wsRef = state.wsRef;
    let errs = 0, opened = false;
    es.onopen = () => { opened = true; errs = 0; };
    es.onmessage = (e) => {
      if (state.wsRef !== wsRef) return;
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      applyLayout(d);
    };
    es.onerror = () => {
      errs++;
      // never established, or dying repeatedly (old server without the endpoint, buffering proxy) →
      // stop retrying and lean on the tree poll's syncLayout instead
      if (!opened || errs >= 3) stopLayoutStream();
    };
    state.streams.layout = { es, wsRef };
  }
  function stopLayoutStream() {
    const s = state.streams.layout;
    if (!s) return;
    try { s.es.close(); } catch (_) {}
    state.streams.layout = null;
  }

  // ---- live grids: ONE multiplexed stream for every visible pane --------------
  // /api/cmux/panes-stream carries `{surface, grid, h}` frames for all mirrored panes over a single
  // connection: the bridge walks the surfaces one at a time (concurrent terminal.replay calls starve
  // each other) and only sends a pane whose hash moved. Falls back to conditional polling — also
  // strictly one request in flight — if the stream can't establish.
  function applyFrame(sid, txt, parsed) {
    const v = viewBySurface(sid);
    if (!v) return 'same';
    if (txt && txt === v.lastRaw) return 'same';
    let d = parsed;
    if (!d) { try { d = JSON.parse(txt); } catch (_) { return 'error'; } }
    if (d && d.same) return 'same';
    if (d && d.grid) {
      v.lastRaw = txt || JSON.stringify(d);
      v.lastHash = d.h || null;
      // Kept for the live-menu detector and for the two-phase read-back, which needs to know that a
      // frame is strictly NEWER than the arrow keys it just sent. The hash doubles as the sequence
      // marker: identical payloads are dropped above, so a changed hash is a changed frame.
      v.lastGrid = d.grid;
      v.lastSeq = d.h || d.seq || (v.lastSeq === undefined ? 0 : v.lastSeq + 1);
      renderGrid(v, d.grid);
      gridCachePut(sid, v.lastRaw, v.lastHash);
      if (typeof refreshLiveChips === 'function' && v.paneId === state.composerPane) refreshLiveChips(v.paneId);
      return 'changed';
    }
    return 'error';
  }
  function streamKey() {
    return [...state.views.values()].map((v) => v.surfaceId).filter(Boolean).sort().join(',');
  }
  function syncPaneStreams() {
    const key = streamKey();
    if (!key) { stopPaneStream(); return; }
    if (state.streams.panes && state.streams.panes.key === key) return;   // same set → keep the socket
    stopPaneStream();
    startPaneStream(key);
  }
  function startPaneStream(key) {
    const surfaces = key.split(',');
    const hashes = surfaces.map((s) => { const v = viewBySurface(s); return (v && v.lastHash) || ''; });
    const ctl = { key, es: null, timer: null, stopped: false };
    state.streams.panes = ctl;
    const live = () => !ctl.stopped && state.streams.panes === ctl;
    setStatus('live');

    // --- poll fallback: round-robin conditional GETs, one in flight ---
    let idle = 0, errs = 0, i = 0;
    const delay = () => (errs ? 1200 : idle > surfaces.length * 3 ? 900 : 220);
    const schedule = () => { if (live()) ctl.timer = setTimeout(tick, delay()); };
    const tick = async () => {
      if (!live()) return;
      const sid = surfaces[i++ % surfaces.length];
      const v = viewBySurface(sid);
      if (!v) return schedule();
      try {
        const r = await jget('/api/cmux/grid?machine=' + encodeURIComponent(state.machine) + '&surface=' + encodeURIComponent(sid)
          + (v.lastHash ? '&h=' + encodeURIComponent(v.lastHash) : ''));
        if (!live()) return;
        if (!r.ok) { setStatus('offline', true); errs++; return; }
        const txt = await r.text();
        if (!live()) return;
        errs = 0;
        const a = applyFrame(sid, txt);
        if (a === 'changed') idle = 0; else if (a === 'same') idle++;
        if (a === 'error') { let d; try { d = JSON.parse(txt); } catch (_) { d = null; } setStatus((d && d.error) || 'error', true); return; }
        setStatus('live');
      } catch (_) { setStatus('reconnecting…', true); errs++; }
      finally { schedule(); }
    };
    const startPoll = () => { if (live()) tick(); };

    // --- push path ---
    let url = '/api/cmux/panes-stream?machine=' + encodeURIComponent(state.machine)
      + '&surfaces=' + encodeURIComponent(surfaces.join(','))
      + '&h=' + encodeURIComponent(hashes.join(','));
    if (TOKEN) url += '&token=' + encodeURIComponent(TOKEN);
    try { ctl.es = new EventSource(url); } catch (_) { ctl.es = null; return startPoll(); }
    let opened = false, errCount = 0;
    ctl.es.onopen = () => { opened = true; errCount = 0; setStatus('live'); };
    ctl.es.onmessage = (e) => {
      if (!live() || !e.data) return;
      errCount = 0;
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (!d || !d.surface) return;
      if (applyFrame(d.surface, e.data, d) !== 'error') setStatus('live');
    };
    ctl.es.onerror = () => {
      if (!live()) return;
      errCount++;
      if (!opened || errCount >= 3) { try { ctl.es.close(); } catch (_) {} ctl.es = null; startPoll(); }
      else setStatus('reconnecting…', true);
    };
  }
  function stopPaneStream() {
    const ctl = state.streams.panes;
    if (!ctl) return;
    ctl.stopped = true;
    if (ctl.timer) clearTimeout(ctl.timer);
    if (ctl.es) { try { ctl.es.close(); } catch (_) {} }
    state.streams.panes = null;
  }

  // ---- dividers: drag a split, and the Mac's split moves ---------------------
  // The commit is on RELEASE, not per pointermove: every resize is several cmux round trips, and a
  // finger emits them faster than cmux can service them. The bar tracks the finger locally (and the
  // two adjacent panes stretch with it) so the drag still feels direct.
  let dragging = null;
  function paneIdOf(ref) {
    const p = layoutPanes().find((x) => x.ref === ref || x.id === ref);
    return p ? p.id : null;
  }
  function wireHandleDrag(el, hd) {
    const onDown = (e) => {
      if (e.button != null && e.button > 0) return;
      const rect = elPanes.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      e.preventDefault();
      dragging = { hd, rect, pos: hd.pos };
      el.classList.add('drag');
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!dragging) return;
        const f = hd.axis === 'x' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        dragging.pos = Math.min(0.95, Math.max(0.05, f));
        if (hd.axis === 'x') el.style.left = (dragging.pos * 100).toFixed(3) + '%';
        else el.style.top = (dragging.pos * 100).toFixed(3) + '%';
        previewDrag(hd, dragging.pos);
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('drag');
        const d = dragging; dragging = null;
        if (!d) return;
        if (Math.abs(d.pos - hd.pos) < 0.005) return renderPanes();   // a tap, not a drag
        commitDrag(hd, d.pos);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    el.addEventListener('pointerdown', onDown);
  }
  // Optimistic geometry while the finger is down: the panes touching this divider follow it, so the
  // split doesn't visibly snap back and forth between the drag and cmux's answer.
  function previewDrag(hd, pos) {
    for (const ref of hd.a) {
      const v = state.views.get(paneIdOf(ref)); const p = layoutPanes().find((x) => x.ref === ref);
      if (!v || !p) continue;
      if (hd.axis === 'x') v.el.style.width = (Math.max(0.02, pos - p.x) * 100).toFixed(3) + '%';
      else v.el.style.height = (Math.max(0.02, pos - p.y) * 100).toFixed(3) + '%';
    }
    for (const ref of hd.b) {
      const v = state.views.get(paneIdOf(ref)); const p = layoutPanes().find((x) => x.ref === ref);
      if (!v || !p) continue;
      if (hd.axis === 'x') {
        v.el.style.left = (pos * 100).toFixed(3) + '%';
        v.el.style.width = (Math.max(0.02, (p.x + p.w) - pos) * 100).toFixed(3) + '%';
      } else {
        v.el.style.top = (pos * 100).toFixed(3) + '%';
        v.el.style.height = (Math.max(0.02, (p.y + p.h) - pos) * 100).toFixed(3) + '%';
      }
    }
  }
  async function commitDrag(hd, pos) {
    const ws = currentWs();
    const paneA = paneIdOf(hd.a[0]), paneB = paneIdOf(hd.b[0]);
    if (!ws || !paneA || !paneB) return renderPanes();
    setStatus('resizing…');
    try {
      const r = await jpost('/api/cmux/resize-pane', { machine: state.machine, workspace: ws.id,
        paneA, paneB, axis: hd.axis, target: pos });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.error) || 'resize failed', true); return renderPanes(); }
      if (d.layout) applyLayout(d.layout); else syncLayout(true);
      setStatus('live');
    } catch (_) { setStatus('resize failed', true); renderPanes(); }
  }

  // ---- drag a pane to rearrange it -------------------------------------------
  // The arrangement IS the drag: pick a pane up by its title bar and drop it where you want it. Drop
  // on a pane's edge and it becomes a pane on that side; drop on the middle and it joins that pane as
  // a tab. Dragging a tab chip does the same thing for one tab, which is how a tab gets its own pane.
  //
  // Everything is expressed as ONE call (/api/cmux/drop-surface) on the dragged surface, because cmux
  // has no move-pane — see the bridge for the two-step it runs. Hit-testing is done against the panes'
  // real DOM rects rather than the layout fractions, so the zone drawn is exactly the box the finger
  // is over even mid-resize.
  const EDGE_BAND = 0.28;                // outer 28% of a pane = "beside it", the rest = "into it"
  let paneDrag = null;                   // { surface, label, sourcePane, target: {paneId, edge}|null }

  function paneSurfaceCount(paneId) {
    const ws = currentWs();
    return ((ws && ws.tabs) || []).filter((t) => t.pane === paneId).length;
  }
  function wirePaneDrag(v) {
    v.headEl.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (paneDrag || dragging) return;
      if (e.target && e.target.closest && e.target.closest('.pact')) return;   // ⊞ / × are buttons
      const chip = e.target && e.target.closest ? e.target.closest('.pchip') : null;
      const surface = (chip && chip.dataset.surface) || v.surfaceId;
      if (!surface || state.views.size < 2) return;      // nothing to rearrange in a solo mirror
      // The listeners go on WINDOW, not on the header. A header band is ~22px tall, and a mouse
      // leaves it long before the arm threshold — with the listeners on the element itself the very
      // first pointermove lands on the terminal instead and the drag never starts. (A touch drag
      // gets implicit pointer capture and does not show this, which is how it passed a headless
      // smoke while being unusable with a real mouse.)
      const el = v.headEl;
      const start = { x: e.clientX, y: e.clientY };
      let armed = false;
      const move = (ev) => {
        if (!armed) {
          if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 8) return;
          armed = true;
          beginPaneDrag(v, surface);
          try { el.setPointerCapture(ev.pointerId); } catch (_) {}
        }
        ev.preventDefault();
        updatePaneDrag(ev.clientX, ev.clientY);
      };
      const done = (commit) => (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        if (!armed) return;                               // a tap — leave it to the chip's own onclick
        ev.preventDefault();
        endPaneDrag(commit);
      };
      const up = done(true), cancel = done(false);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
  }
  function beginPaneDrag(v, surface) {
    paneDrag = { surface, sourcePane: v.paneId, target: null, label: paneTitle(surface) || surface };
    v.el.classList.add('lifted');
    elDragGhost.textContent = paneDrag.label;
    elDragGhost.hidden = false;
    closeSplitMenu(); closeWsMenu(); closeSettings();
    setStatus('drop it on a pane');
  }
  function updatePaneDrag(cx, cy) {
    if (!paneDrag) return;
    elDragGhost.style.left = cx + 'px';
    elDragGhost.style.top = cy + 'px';
    const base = elPanes.getBoundingClientRect();
    let hit = null;
    for (const [id, v] of state.views) {
      const r = v.el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      hit = { id, r };
      break;
    }
    if (!hit) { paneDrag.target = null; elDropZone.hidden = true; return; }
    const fx = (cx - hit.r.left) / hit.r.width, fy = (cy - hit.r.top) / hit.r.height;
    const near = [['left', fx], ['right', 1 - fx], ['up', fy], ['down', 1 - fy]]
      .sort((a, b) => a[1] - b[1])[0];
    const edge = near[1] < EDGE_BAND ? near[0] : 'center';
    // dropping a pane onto itself is a no-op; a CHIP onto its own pane's edge is not (that is the
    // "give this tab its own pane" move), so only the last-surface case is refused
    const ownPane = hit.id === paneDrag.sourcePane;
    if (ownPane && (edge === 'center' || paneSurfaceCount(hit.id) <= 1)) {
      paneDrag.target = null; elDropZone.hidden = true; return;
    }
    paneDrag.target = { paneId: hit.id, edge };
    const box = { l: hit.r.left - base.left, t: hit.r.top - base.top, w: hit.r.width, h: hit.r.height };
    if (edge === 'left') box.w /= 2;
    else if (edge === 'right') { box.l += hit.r.width / 2; box.w /= 2; }
    else if (edge === 'up') box.h /= 2;
    else if (edge === 'down') { box.t += hit.r.height / 2; box.h /= 2; }
    elDropZone.style.left = box.l + 'px';
    elDropZone.style.top = box.t + 'px';
    elDropZone.style.width = box.w + 'px';
    elDropZone.style.height = box.h + 'px';
    elDropZone.querySelector('.dzlabel').textContent = edge === 'center' ? 'join as a tab' : 'move here';
    elDropZone.hidden = false;
  }
  function endPaneDrag(commit) {
    const d = paneDrag;
    paneDrag = null;
    elDropZone.hidden = true;
    elDragGhost.hidden = true;
    for (const v of state.views.values()) v.el.classList.remove('lifted');
    if (!d) return;
    if (!commit || !d.target) { setStatus('live'); return; }
    doDrop(d.surface, d.target.paneId, d.target.edge);
  }
  async function doDrop(surface, pane, edge) {
    const ws = currentWs();
    if (!ws || !state.machine) return;
    setStatus('moving…');
    try {
      const r = await jpost('/api/cmux/drop-surface',
        { machine: state.machine, workspace: ws.id, surface, pane, edge });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.detail) || (d && d.error) || 'move failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      if (d.layout) applyLayout(d.layout); else await syncLayout(true);
      renderTabs();
      setStatus('moved');
    } catch (_) { setStatus('move failed', true); }
  }

  // ---- dropping files onto a terminal ----------------------------------------
  // On the Mac, dragging an image into a terminal hands the agent a PATH. From a phone there is no
  // path to hand over, so the file is uploaded to the Mac first and the path it landed at is typed
  // into the composer — same end result, and it works for the file picker (photo library, Files) and
  // for a pasted screenshot too.
  //
  // Drop targets the pane under the pointer, so the path goes to the terminal you dropped on.
  function quotePath(p) { return /[\s"'\\$`]/.test(p) ? "'" + p.replace(/'/g, "'\\''") + "'" : p; }
  function insertPaths(paths) {
    if (!paths.length) return;
    const add = paths.map(quotePath).join(' ');
    const cur = elText.value;
    elText.value = cur && !/\s$/.test(cur) ? cur + ' ' + add : cur + add;
    elText.dispatchEvent(new Event('input'));
    elText.focus();
  }
  // A pasted screenshot has no filename — macOS ⌘⇧⌃4 puts a bare image on the clipboard, and every
  // browser invents its own placeholder ("image.png", "" , sometimes nothing at all). Naming them by
  // the moment they were pasted keeps a day's folder readable instead of image-1, image-2, image-3.
  const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/tiff': 'tiff', 'application/pdf': 'pdf' };
  function pastedName(f) {
    const n = (f && f.name) || '';
    if (n && !/^(image|photo|file)\.[a-z0-9]+$/i.test(n)) return n;      // a real name: keep it
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = EXT_BY_TYPE[(f && f.type) || ''] || (n.split('.')[1] || 'bin');
    return `pasted-${stamp}.${ext}`;
  }
  // Firefox and some Safari builds expose a pasted image only through `items`, never through `files`.
  function filesFrom(dt) {
    if (!dt) return [];
    const out = [...(dt.files || [])];
    if (!out.length && dt.items) {
      for (const it of dt.items) {
        if (it.kind !== 'file') continue;
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }
  async function uploadFiles(files, paneId) {
    const list = [...files].filter(Boolean);
    if (!list.length || !state.machine) return;
    if (paneId && paneId !== state.focusPane) focusPane(paneId);
    const done = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const name = pastedName(f);
      setStatus('uploading ' + (list.length > 1 ? (i + 1) + '/' + list.length + ' ' : '') + name + '…');
      try {
        const r = await fetch('/api/cmux/upload?machine=' + encodeURIComponent(state.machine), {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/octet-stream',
            // a header can only carry latin-1, and a photo can be named anything at all
            'x-file-name': encodeURIComponent(name) },
          body: f,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) {
          setStatus(d.error === 'too_large' ? 'file too large' : (d.error || 'upload failed'), true);
          return;
        }
        done.push(d.path);
      } catch (_) { setStatus('upload failed', true); return; }
    }
    insertPaths(done);
    setStatus(done.length > 1 ? done.length + ' files on the Mac' : 'on the Mac: ' + done[0].split('/').pop());
  }
  function paneUnder(x, y) {
    for (const [id, v] of state.views) {
      const r = v.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  }
  function wireFileDrop() {
    const hasFiles = (e) => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++; elFileDrop.hidden = false;
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) elFileDrop.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; elFileDrop.hidden = true;
      uploadFiles(filesFrom(e.dataTransfer), paneUnder(e.clientX, e.clientY));
    });
    // A pasted screenshot is the same gesture without a drag: ⌘V anywhere in the app (the composer
    // included — a paste carrying files is never text, so nothing is stolen from typing).
    window.addEventListener('paste', (e) => {
      const files = filesFrom(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      uploadFiles(files, state.focusPane);
    });
    if (elAttachBtn && elAttachInput) {
      elAttachBtn.onclick = () => elAttachInput.click();
      elAttachInput.onchange = () => { uploadFiles(elAttachInput.files, state.focusPane); elAttachInput.value = ''; };
    }
    // iOS has no ⌘V and its paste menu does not fire a paste event at a plain page, so the clipboard
    // has to be READ on a tap instead. Needs a user gesture and permission, and does not exist on
    // every browser — hence the button hides itself where the API is missing.
    if (elPasteBtn) {
      if (!(navigator.clipboard && navigator.clipboard.read)) elPasteBtn.hidden = true;
      else elPasteBtn.onclick = pasteImageFromClipboard;
    }
  }

  // Reads an IMAGE or PDF off the clipboard and uploads it to the Mac. Not a text-paste button —
  // text paste already works through the OS's own long-press menu. It exists because iOS has no ⌘V
  // and its paste menu fires no paste event at a plain page, so the clipboard must be READ on a
  // gesture. Lifted out of the old button's handler so the ＋ sheet can call it too.
  async function pasteImageFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const it of items) {
        const type = (it.types || []).find((t) => t.startsWith('image/') || t === 'application/pdf');
        if (!type) continue;
        const blob = await it.getType(type);
        files.push(new File([blob], 'image.' + (EXT_BY_TYPE[type] || 'bin'), { type }));
      }
      if (!files.length) return setStatus('clipboard has no image', true);
      uploadFiles(files, state.composerPane || state.focusPane);
    } catch (_) { setStatus('clipboard not readable', true); }
  }

  // ---- taps inside a pane ----------------------------------------------------
  // A tap on a pane that isn't the focused one just moves focus there (and never fires keys at it —
  // hitting Enter on an agent you only meant to look at is exactly the accident to design out).
  // On the focused pane the existing Claude-menu tap handling applies.
  function wirePaneTaps(v) {
    let g = null;
    const el = v.screenEl;
    el.addEventListener('pointerdown', (e) => {
      if (state.tabType !== 'terminal') { g = null; return; }
      g = { sx: e.clientX, sy: e.clientY, t: Date.now(), max: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      if (!g) return;
      g.max = Math.max(g.max, Math.abs(e.clientX - g.sx), Math.abs(e.clientY - g.sy));
    }, { passive: true });
    const end = (e) => {
      const gg = g; g = null;
      if (!gg || state.tabType !== 'terminal') return;
      if (gg.max >= 8 || Date.now() - gg.t >= 500) return;    // a scroll or a long-press (text select)
      if (state.focusPane !== v.paneId) { focusPane(v.paneId); return; }
      if (!state.tab) return;
      const rowEl = (e.target && e.target.closest) ? e.target.closest('.trow') : null;
      if (rowEl) tryMenuClick(v, rowEl);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => { g = null; });
    v.headEl.addEventListener('click', () => focusPane(v.paneId));
  }

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
    // The browser mirror is a full-bleed overlay: tear the terminal panes down rather than leave N
    // grid streams running behind a screenshot nobody can see.
    teardownPanes(); setStatus('');
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
  let newTabBusy = false, newBrowserBusy = false;
  async function doNewTab(pane) {
    const ws = currentWs();
    if (!ws || !state.machine || newTabBusy) return;
    newTabBusy = true; setStatus('new tab…');
    try {
      // land it in the pane it was asked for (the ⊞ menu's pane), else the one you are looking at —
      // never wherever cmux's focus happens to be
      const r = await jpost('/api/cmux/new-surface', { machine: state.machine, workspace: ws.id,
        pane: pane || state.focusPane || undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'new tab failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      renderTabs();
      if (d.id) selectTab(d.id);
      setStatus('tab created');
    } catch (_) { setStatus('new tab failed', true); }
    finally { newTabBusy = false; }
  }
  async function doNewBrowser() {
    const ws = currentWs();
    if (!ws || !state.machine || newBrowserBusy) return;
    let url = prompt('Open URL in a new browser tab (blank = new-tab page):', 'https://');
    if (url === null) return;                 // cancelled
    url = normalizeUrl(url);
    newBrowserBusy = true; setStatus('new browser…');
    try {
      const r = await jpost('/api/cmux/browser/open', { machine: state.machine, workspace: ws.id, url: url || undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus(d.error || 'new browser failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      renderTabs();
      if (d.id) selectTab(d.id); else setStatus('opened (select the browser tab)');
    } catch (_) { setStatus('new browser failed', true); }
    finally { newBrowserBusy = false; }
  }
  // ---- splits ----------------------------------------------------------------
  // Splitting creates a REAL cmux pane, so the Mac gets the same split the phone just made.
  // Splitting is always relative to a PANE — the one whose ⊞ was tapped. cmux splits the focused
  // pane, so the bridge focuses this one first (see cmuxNewPane).
  async function doSplit(direction, pane) {
    const ws = currentWs();
    if (!ws || !state.machine) return;
    setStatus('splitting…');
    try {
      const r = await jpost('/api/cmux/new-pane', { machine: state.machine, workspace: ws.id, direction,
        pane: pane || state.menuPane || state.focusPane || undefined });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.error) || 'split failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      if (d.layout) applyLayout(d.layout); else await syncLayout(true);
      renderTabs();
      setStatus('split');
    } catch (_) { setStatus('split failed', true); }
  }
  // Kill a whole pane — tabs and all. This is the × on the pane header, and it is the only way to
  // close a pane now that the global tab strip (with its per-tab ×) is the one-pane view's chrome.
  async function doClosePane(paneId) {
    const ws = currentWs();
    if (!ws || !state.machine || !paneId) return;
    const tabs = ((ws && ws.tabs) || []).filter((t) => t.pane === paneId);
    if (!tabs.length) return;
    const running = tabs.filter((t) => /run|need/i.test(t.status || ''));
    // only interrupt for the cases where a mis-tap actually costs something: more than one tab, or
    // something still running in there
    if (tabs.length > 1 || running.length) {
      const what = tabs.length > 1 ? tabs.length + ' tabs' : 'a running tab';
      if (!confirm('Close this pane? It holds ' + what + '.')) return;
    } else if (((ws && ws.panes) || []).length <= 1) {
      // The pane header is now shown for a single-pane workspace too (split view no longer needs two
      // panes), so this × is newly reachable there — and closing the only pane takes the workspace with
      // it. Say that, instead of quietly closing the workspace someone just made.
      if (!confirm('Close this pane? It is the only one in this workspace.')) return;
    }
    setStatus('closing pane…');
    try {
      const r = await jpost('/api/cmux/close-pane', { machine: state.machine, workspace: ws.id, pane: paneId });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.detail) || (d && d.error) || 'close failed', true); return; }
      for (const t of tabs) dropCache(t.id);
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      destroyView(paneId);
      if (state.focusPane === paneId) state.focusPane = null;
      if (state.tab && tabs.some((t) => t.id === state.tab.id)) {
        if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
        state.tab = null;
      }
      if (d.layout) applyLayout(d.layout); else await syncLayout(true);
      renderPanes();
      // renderPanes picks a new focus pane; make the footer follow it, or typing still points at a
      // surface that no longer exists
      if (!state.tab) {
        const sid = paneSelectedSurface(state.focusPane);
        const t = sid && findTab(sid);
        if (t) selectTab(t.id);
      }
      renderTabs();
      setStatus('pane closed');
    } catch (_) { setStatus('close failed', true); }
  }
  async function doEqualize() {
    const ws = currentWs();
    if (!ws || !state.machine) return;
    setStatus('evening up…');
    try {
      const r = await jpost('/api/cmux/equalize', { machine: state.machine, workspace: ws.id });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.error) || 'equalize failed', true); return; }
      if (d.layout) applyLayout(d.layout); else await syncLayout(true);
      setStatus('live');
    } catch (_) { setStatus('equalize failed', true); }
  }
  // NOTE: there is deliberately no "move this tab out" action here any more. It called cmux
  // `split-off`, which refuses with `invalid_state: splitting off would leave the source pane empty`
  // whenever the pane holds a single tab — i.e. for every pane in a normal one-tab-per-pane
  // workspace, so the buttons could only ever error. Dragging a pane (or a tab chip) onto another
  // pane's edge is the same move and works in every case: see doDrop / drop-surface.

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
      // closing a tab can also close its PANE (it was the last one there) — the layout has to be
      // re-read, not inferred, or the mirror keeps a box for a pane that no longer exists
      await syncLayout(true);
      if (state.tab && state.tab.id === t.id) {
        if (state.tabType === 'browser') { exitBrowserMode(); state.tabType = 'terminal'; }
        state.tab = null;
        const term = ntabs.filter((x) => x.type !== 'browser');
        const fallback = term[Math.max(0, Math.min(idx, term.length - 1))] || term[0];
        renderTabs();
        if (fallback) selectTab(fallback.id);
        else { teardownPanes(); elEmpty.style.display = 'flex'; elText.disabled = true; elSend.disabled = true; }
      } else { renderPanes(); renderTabs(); }
      setStatus('tab closed');
    } catch (_) { setStatus('close failed', true); }
  }
  // Rename a workspace. An emptied box CLEARS the custom name and hands the label back to cmux's
  // tab-derived default, which is the only way to undo a rename — so it is not treated as a cancel.
  async function doRenameWorkspace(w) {
    if (!state.machine || !w) return;
    const cur = w.title || '';
    const next = prompt('Workspace name (empty = back to the tab’s name):', cur);
    if (next === null) return;                       // cancelled — Esc / Cancel, not an empty name
    const title = String(next).trim();
    if (title === cur.trim()) return;
    setStatus('renaming…');
    try {
      const r = await jpost('/api/cmux/rename-workspace', { machine: state.machine, workspace: w.id, title });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setStatus((d && d.detail) || (d && d.error) || 'rename failed', true); return; }
      if (Array.isArray(d.workspaces)) state.workspaces = d.workspaces;
      renderHeader(); renderTabs(); renderPanes();
      setStatus(title ? 'renamed' : 'name cleared');
    } catch (_) { setStatus('rename failed', true); }
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
        teardownPanes(); state.tab = null; state.wsRef = null; state.layout = null; state.focusPane = null;
        const next = state.workspaces[Math.max(0, Math.min(idx, state.workspaces.length - 1))] || state.workspaces[0];
        if (next) selectWorkspace(next.ref);
        else { renderHeader(); renderTabs(); elEmpty.style.display = 'flex'; elText.disabled = true; elSend.disabled = true; setStatus(''); }
      } else { renderHeader(); renderTabs(); }
      setStatus('workspace closed');
    } catch (_) { setStatus('close failed', true); }
  }

  // ---- input ----
  async function doSend() {
    const surface = composerSurface();
    if (!surface) return;
    const text = elText.value;
    if (!text) return;
    elText.value = ''; elText.style.height = ''; elText.focus();
    lsSurfaceSet(DRAFT_PREFIX, surface, null);
    try {
      const r = await jpost('/api/cmux/send', { machine: state.machine, surface, text, submit: true });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setStatus(d.error || 'send failed', true); }
    } catch (_) { setStatus('send failed', true); }
  }
  async function sendRaw(text) {   // live field: forward typed chars immediately (no submit)
    const surface = composerSurface();
    if (!surface || !text) return;
    try { await jpost('/api/cmux/send', { machine: state.machine, surface, text, submit: false }); }
    catch (_) { setStatus('send failed', true); }
  }
  async function doKey(key) {
    // Keys go to the pane holding the composer, exactly like text. A key bar that acted on a
    // different pane from the box above it would be the same wrong-pane bug wearing a costume.
    const surface = composerSurface();
    if (!surface) return;
    try { await jpost('/api/cmux/key', { machine: state.machine, surface, key }); }
    catch (_) { setStatus('key failed', true); }
  }
  // Press a short sequence of keys in order (each is one cmux round trip). Used to "click" a menu
  // option: walk the highlight to the tapped row with arrows, then Enter. Menus are tiny → a few hops.
  async function pressKeys(keys) { for (const k of keys) { await doKey(k); } }

  // ---- tap-to-click a Claude-Code selection menu ------------------------------
  // cmux emits a render-GRID (metadata), not a raw byte stream, and Claude's Ink TUI enables no xterm
  // mouse tracking — so a real mouse click can't be delivered to the terminal. Instead we treat a tap
  // on an option row as a click by moving the highlight there with arrow keys (the grid rows map 1:1 to
  // .trow nodes, so item order = arrow steps) and pressing Enter. Gated tightly: it fires ONLY when the
  // screen shows a numbered list AND one row carries a cursor marker (❯…), so ordinary numbered output
  // in Claude's prose never triggers stray keypresses.
  const MENU_MARKERS = '❯▶►▸➤»‣';                                  // cursor pointers only (not check/radio glyphs)
  const MENU_ITEM_RE = new RegExp('^\\s*[' + MENU_MARKERS + ']?\\s*\\d+[.)]\\s+\\S');
  const firstGlyph = (s) => { const t = (s || '').replace(/^\s+/, ''); return t ? t[0] : ''; };
  const isMarked = (s) => MENU_MARKERS.indexOf(firstGlyph(s)) >= 0;
  // If `rowEl` is an option row of a live selection menu, move the highlight to it + confirm.
  // Returns true if it handled the tap (so the caller doesn't also focus the composer).
  function tryMenuClick(v, rowEl) {
    if (!state.tab || state.tabType !== 'terminal' || !v) return false;
    // Only the LIVE grid rows are candidates. A scrolled-off menu sitting in the history block carries
    // its old ❯ marker forever, and letting it win `markedItem` would compute the arrow delta from a
    // highlight that no longer exists — keys fired at the wrong item, in a menu, with no undo.
    const rows = Array.prototype.slice.call(v.screenEl.childNodes).slice(v.histLen || 0);
    const tapIdx = rows.indexOf(rowEl);
    if (tapIdx < 0) return false;
    const items = []; let markedItem = -1;                          // option rows (grid indices) + which is selected
    rows.forEach((el, i) => {
      const txt = el.textContent || '';
      if (MENU_ITEM_RE.test(txt)) { if (markedItem < 0 && isMarked(txt)) markedItem = items.length; items.push(i); }
    });
    if (markedItem < 0) return false;                               // no live cursor marker → not an interactive menu
    const tapItem = items.indexOf(tapIdx);
    if (tapItem < 0) return false;                                  // tapped a non-option row → fall through to focus
    const delta = tapItem - markedItem;
    const keys = [];
    for (let n = 0; n < Math.abs(delta); n++) keys.push(delta > 0 ? 'down' : 'up');
    keys.push('enter');                                            // delta 0 (tapped the highlighted row) → just confirm
    setStatus('select…');
    pressKeys(keys);
    return true;
  }

  // ---- the composer belongs to a pane (p7 Track A) ---------------------------
  //
  // It used to be a page-level singleton pointed at `state.tab`, so with several panes mirrored the
  // box on screen and the terminal that received the text could be different things. The operator: "I've
  // been sending the text into the wrong pane frequently now." That is not a UX wrinkle — a prompt
  // meant for one agent executed by another has no undo.
  //
  // There is still ONE composer element (the <footer>), because duplicating its input handling per
  // pane would duplicate every subtle bit of it. What changed is ownership: it is MOUNTED INSIDE a
  // pane, its target is that pane's surface and nothing else, and every other pane shows its own
  // footer bar. Tapping a bar moves the composer there.
  //
  // Compose/Live modes are gone. They were an explicit page-level switch over something that is not
  // two states: every key-bar button was already instant in both, so only the text field ever
  // differed — and splitting them made the useful combination (hold a draft AND fire ^C)
  // unreachable. Now the key bar is always available and the field carries a small live toggle.

  const DRAFT_PREFIX = 'cmux_draft_';
  const LIVE_PREFIX = 'cmux_live_';
  const DRAFT_MAX = 24;                   // surfaces churn; unbounded keys grow forever (Codex #14)

  function lsSurfaceSet(prefix, sid, val) {
    if (!sid) return;
    const idxKey = prefix + 'idx';
    try {
      const idx = JSON.parse(localStorage.getItem(idxKey) || '[]').filter((x) => x !== sid);
      if (val === null) { localStorage.removeItem(prefix + sid); localStorage.setItem(idxKey, JSON.stringify(idx)); return; }
      idx.push(sid);
      while (idx.length > DRAFT_MAX) localStorage.removeItem(prefix + idx.shift());
      localStorage.setItem(prefix + sid, val);
      localStorage.setItem(idxKey, JSON.stringify(idx));
    } catch (_) { /* quota / private mode: drafts are a convenience, never a correctness dependency */ }
  }
  const lsSurfaceGet = (prefix, sid) => { try { return sid ? localStorage.getItem(prefix + sid) : null; } catch (_) { return null; } };

  const draftOf = (sid) => lsSurfaceGet(DRAFT_PREFIX, sid) || '';
  const liveOf = (sid) => lsSurfaceGet(LIVE_PREFIX, sid) === '1';

  // The surface the composer is pointed at. Everything typed, every key pressed, and every generated
  // git command goes here — never `state.tab`, which is a NAVIGATION concept and was the bug.
  function composerSurface() {
    const v = state.composerPane && state.views.get(state.composerPane);
    return (v && v.surfaceId) || null;
  }
  function saveDraft() {
    const sid = composerSurface();
    if (!sid) return;
    const val = elText.value;
    lsSurfaceSet(DRAFT_PREFIX, sid, val ? val : null);
  }

  // Live is a property of the FIELD, not of the app. Autocorrect follows it silently — raw
  // keystrokes must not be autocorrected — but it is never announced: there is no control for it,
  // so a label saying "autocorrect on" told the user nothing they could act on.
  function applyLive(live) {
    state.live = !!live;
    elText.classList.toggle('live', state.live);
    elSend.hidden = state.live;                       // nothing is pending to submit while live
    elText.setAttribute('autocorrect', state.live ? 'off' : 'on');
    elText.setAttribute('autocapitalize', state.live ? 'off' : 'sentences');
    elText.setAttribute('spellcheck', state.live ? 'false' : 'true');
    elText.placeholder = state.live ? 'live — every key hits the terminal' : 'Type…';
    if (elLiveToggle) {
      elLiveToggle.classList.toggle('on', state.live);
      elLiveToggle.setAttribute('aria-pressed', String(state.live));
      elLiveToggle.title = state.live ? 'Live: keys go straight to the terminal' : 'Batch: type, then Send';
    }
    // Returning to compose re-measures whatever the field holds now: a draft kept across the
    // round-trip grows back, a field emptied by live keystrokes drops to one row. Entering live
    // keeps the height as-is so a kept draft stays fully visible.
    if (!state.live) autogrow();
  }
  function toggleLive() {
    const sid = composerSurface();
    // Toggling never transmits and never discards: the field keeps whatever is in it in both
    // directions. Clearing on toggle would silently eat a draft; sending would be worse.
    const next = !state.live;
    if (sid) lsSurfaceSet(LIVE_PREFIX, sid, next ? '1' : null);
    applyLive(next);
    elText.focus();
  }

  // Where the composer lives when no pane holds it (an overlay is up, or panes are being rebuilt).
  const composerHome = document.body;
  function parkComposer() {
    if (!elFooter) return;
    saveDraft();
    if (elFooter.parentNode !== composerHome) composerHome.appendChild(elFooter);
    elFooter.hidden = true;
  }

  // The surface the composer last belonged to, kept across parking. `fillComposer` needs a target
  // even while an overlay is up — the source-control panel writes into the composer and only then
  // closes itself.
  function stickySurface() {
    const v = state.composerPane && state.views.get(state.composerPane);
    return (v && v.surfaceId) || state.lastComposerSurface || null;
  }

  // Move the composer into a pane. This is the whole ownership change in one function.
  // IDEMPOTENT ON PURPOSE. renderPanes() runs on every tree poll and every layout frame, and
  // `appendChild` MOVES a node — moving the ancestor of a focused input drops the focus, and
  // re-reading the draft resets the caret. That combination made the box unusable: focus lost every
  // few seconds while typing. So an already-correct mount does nothing at all.
  function mountComposer(paneId) {
    const v = state.views.get(paneId);
    if (!v) return;
    const already = state.composerPane === paneId && elFooter.parentNode === v.footEl;
    if (already) { elFooter.hidden = false; return; }

    if (state.composerPane && state.composerPane !== paneId) saveDraft();
    const sameSurface = state.lastComposerSurface === v.surfaceId;
    state.composerPane = paneId;
    state.lastComposerSurface = v.surfaceId;
    v.footEl.appendChild(elFooter);
    elFooter.hidden = false;
    // Only reload the field when the SURFACE changed. A pane re-render that lands on the same
    // surface must not overwrite what is being typed right now.
    if (!sameSurface || !elText.value) {
      elText.value = draftOf(v.surfaceId);
      elText.style.height = '';
      applyLive(liveOf(v.surfaceId));
    }
    autogrow();
    renderPaneFooters();
  }

  // A layout frame that arrived while the composer was focused is applied when it is put down —
  // holding it is what stops the Mac's own split changes from yanking the keyboard away mid-word.
  function flushPendingLayout() {
    const l = state.pendingLayout;
    state.pendingLayout = null;
    if (l) applyLayout(l);
  }

  // Tapping a pane's footer bar hands it the composer AND blows that pane up. Both halves matter:
  // the first makes the target unambiguous, the second guarantees the box has room above the iOS
  // keyboard — in a three-way split a pane footer is a few pixels tall.
  // Taking the composer moves it and focuses it. It does NOT blow the pane up to full screen.
  //
  // The original design auto-soloed on focus, reasoning that a pane footer in a three-way split is
  // too short to type in above the iOS keyboard. In use that is simply wrong: it destroys the split
  // you are working in every time you tap another pane's bar. And the premise does not hold anyway
  // — below the split threshold the mirror already collapses to one pane (see visiblePanes), so a
  // narrow screen never shows a cramped footer in the first place. Solo remains reachable, it just
  // is not something a text box does to you.
  function takeComposer(paneId) {
    focusPane(paneId);
    mountComposer(paneId);
    elText.focus();
  }

  // Every pane that does NOT hold the composer shows a bar naming its surface and previewing its
  // saved draft, so "which box am I typing into" is answerable at a glance.
  function renderPaneFooters() {
    for (const [paneId, v] of state.views) {
      if (!v.footEl) continue;
      if (paneId === state.composerPane && v.footEl.contains(elFooter)) continue;
      v.footEl.replaceChildren();
      const bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'pcomposebar';
      const d = draftOf(v.surfaceId);
      bar.textContent = d ? d.slice(0, 60) : ('Type to ' + (paneTitle(v.surfaceId) || 'this pane') + '…');
      if (d) bar.classList.add('hasdraft');
      bar.onclick = (e) => { e.stopPropagation(); takeComposer(paneId); };
      v.footEl.appendChild(bar);
    }
  }

  const autogrow = () => { if (state.live) return; elText.style.height = 'auto'; elText.style.height = Math.min(elText.scrollHeight, 120) + 'px'; };

  // ---- source control tab (p7 Track C) ---------------------------------------
  // Mounted the way radar is: defensively. If git.js is missing, stale, or throws on create(), the
  // chip is removed and nothing below ever runs. A source-control add-on must degrade to "no source
  // control", never to "no mirror".
  let gitUI = null;

  // The ONE way a generated git command reaches the Mac: it is written into the composer of the
  // pane the panel targeted, and NOT sent. Two things are enforced here that the panel cannot:
  //  * a live field would TRANSMIT the fill, which is the exact opposite of the guarantee, on the
  //    most destructive commands in the feature — so the toggle is turned off first;
  //  * an existing draft is never clobbered; the command is appended on its own line.
  function fillComposer(text) {
    // The panel is an overlay, so the panes — and with them the mounted composer — are torn down
    // while it is open. The target is the surface the composer last belonged to, and the fill is
    // written to the DRAFT for that surface, which is what the composer restores when it remounts.
    const surface = stickySurface();
    if (!surface) return { ok: false, reason: 'no pane to fill' };
    const v = state.composerPane && state.views.get(state.composerPane);
    const kind = v ? paneKindOf(v) : 'unknown';
    if (v && (kind === 'altscreen' || kind === 'pager')) {
      return { ok: false, reason: 'that pane is not accepting commands (' + kind + ')' };
    }
    // A live field TRANSMITS what is written to it — which on these commands is the exact opposite
    // of the guarantee. Programmatic fills are never sent, so the toggle goes off first.
    if (state.live) { lsSurfaceSet(LIVE_PREFIX, surface, null); applyLive(false); }
    const cur = draftOf(surface);
    const next = cur ? (cur.replace(/\s*$/, '') + '\n' + text) : text;   // append, never clobber
    lsSurfaceSet(DRAFT_PREFIX, surface, next);
    if (elText) { elText.value = next; autogrow(); }
    setStatus(kind === 'agent' ? 'ready to SEND TO the agent in that pane' : 'ready to run in that pane', false, 6000);
    return { ok: true, kind };
  }

  // paneKind lives in menuparse.js (same grid analysis). Absent parser ⇒ unknown ⇒ nothing offered.
  function paneKindOf(v) {
    if (!MENU || !MENU.paneKind || !v || !v.lastGrid) return 'unknown';
    const tab = v.surfaceId && findTab(v.surfaceId);
    try { return MENU.paneKind({ grid: v.lastGrid, status: (tab && tab.status) || '' }).kind; }
    catch (_) { return 'unknown'; }
  }

  function toggleGit() {
    if (!gitUI) return;
    if (state.tabType === 'git') {
      if (state.tab && findTab(state.tab.id)) return selectTab(state.tab.id);
      exitGitMode(); renderTabs(); return;
    }
    try {
      exitFilesMode();
      if (state.browser && state.browser.surface) exitBrowserMode();
      exitRadarMode();
      exitInboxMode();
      teardownPanes();
      setStatus('');
      state.tabType = 'git';
      gitUI.open({ machine: state.machine, onClose: () => { if (state.tab) selectTab(state.tab.id); } });
    } catch (e) { state.tabType = 'terminal'; if (window.console) console.error('git panel open failed', e); }
    renderTabs();
  }
  function exitGitMode() {
    if (!gitUI) return;
    try { gitUI.close(); } catch (_) {}
    if (state.tabType === 'git') state.tabType = 'terminal';
  }

  // ---- chip bar: one bar, two sources (p7 Track B) ---------------------------
  //
  // Source A mirrors a LIVE menu on the Mac — Claude's `/` list, its `@` picker — parsed out of the
  // grid the pane is already streaming, and "clicked" by walking the highlight with arrow keys.
  // Source B offers candidates enumerated from disk while composing, before anything has been sent.
  //
  // Both feed the same bar, so they need arbitration: every render carries a generation number, and
  // a response from an older generation is DISCARDED rather than painted. Without that a slow disk
  // response lands on top of a newer live menu and a tap runs the wrong handler entirely.
  const MENU = (typeof window !== 'undefined' && window.cmuxMenuParse) || null;
  let chipGen = 0;                 // bumped on every input/frame that could change the bar
  let chipBusy = false;            // a selection walk is in flight — the bar is locked
  let elChips = null;

  function ensureChipBar() {
    if (elChips) return elChips;
    const row = elText && elText.parentNode;
    if (!row || !row.parentNode) return null;
    elChips = document.createElement('div');
    elChips.className = 'chipbar';
    elChips.id = 'chipBar';
    elChips.hidden = true;
    row.parentNode.insertBefore(elChips, row);
    return elChips;
  }

  function clearChips() {
    diskChips = null;
    const bar = ensureChipBar();
    if (!bar) return;
    bar.replaceChildren();
    bar.hidden = true;
  }

  function paintChips(items, source, onPick) {
    const bar = ensureChipBar();
    if (!bar) return;
    bar.replaceChildren();
    if (!items.length) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.dataset.source = source;
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mchip' + (it.marked ? ' marked' : '');
      b.dataset.source = source;                 // a chip is only ever actioned by ITS OWN source
      b.dataset.index = String(i);
      b.textContent = it.label;
      if (it.kind) b.title = it.kind + ' · ' + it.label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (chipBusy) return;
        onPick(i, it);
      });
      bar.appendChild(b);
    });
  }

  // ---- source A: the live menu ------------------------------------------------
  // Selection is a TWO-PHASE COMMIT. The old one-shot walk computed a delta from a snapshot and
  // fired N round trips blind: Claude re-filters its menu as text arrives, so the highlight moves
  // and Enter lands on the wrong item. The shipped numbered-list path had the same hole, and its
  // main real-world use is tool-approval prompts — the wrong item there is approving what you meant
  // to deny. So: walk, wait for a frame NEWER than the last arrow, verify the marked row still
  // reads what was tapped, and only then send Enter.
  const READBACK_TIMEOUT_MS = 4000;

  function currentGridFor(paneId) {
    const v = state.views.get(paneId);
    return v && v.lastGrid ? v.lastGrid : null;
  }

  async function commitMenuPick(paneId, targetIndex, expectedText) {
    const v = state.views.get(paneId);
    if (!v || chipBusy) return;
    chipBusy = true;
    setStatus('select…');
    try {
      const menu = MENU.parseMenu(currentGridFor(paneId));
      if (!menu) return setStatus('menu moved — nothing sent', true, 2500);
      const steps = MENU.stepsTo(menu, targetIndex);
      if (!steps) return setStatus('nothing sent', true, 2500);

      const seqBefore = v.lastSeq;
      for (const k of steps) await doKey(k);

      // Phase 2 — a frame that is strictly NEWER than the walk. A frame already in flight when the
      // walk started proves nothing about where the highlight ended up. Delta 0 is not exempt: the
      // chips may have been built from a frame that is already stale.
      const fresh = await waitForFrame(paneId, seqBefore, READBACK_TIMEOUT_MS);
      if (!fresh) return setStatus('no confirmation — nothing sent', true, 3000);

      const after = MENU.parseMenu(fresh);
      const nowText = after && after.items[after.markedIndex] && after.items[after.markedIndex].text;
      if (!after || nowText !== expectedText) return setStatus('selection moved — nothing sent', true, 3000);

      await doKey('enter');
      setStatus('');
    } finally {
      chipBusy = false;
      clearChips();
    }
  }

  function waitForFrame(paneId, afterSeq, timeoutMs) {
    return new Promise((resolve) => {
      const v = state.views.get(paneId);
      if (!v) return resolve(null);
      const started = Date.now();
      const tick = () => {
        const cur = state.views.get(paneId);
        if (!cur) return resolve(null);
        if (cur.lastSeq != null && cur.lastSeq !== afterSeq && cur.lastGrid) return resolve(cur.lastGrid);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  // Called whenever a pane repaints. Cheap: a parse over data already in memory.
  function refreshLiveChips(paneId) {
    if (!MENU || chipBusy) return false;
    if (paneId !== state.composerPane) return false;
    const grid = currentGridFor(paneId);
    const menu = grid && MENU.parseMenu(grid);
    if (!menu) return false;
    const gen = ++chipGen;
    paintChips(
      menu.items.map((it, i) => ({ label: it.text, marked: i === menu.markedIndex, kind: 'menu' })),
      'live',
      (i, it) => { if (gen === chipGen) commitMenuPick(paneId, i, it.label); },
    );
    return true;
  }

  // ---- source B: disk candidates ------------------------------------------------
  let diskTimer = null;
  let diskChips = null;          // {token, candidates, gen} — what Tab and → act on

  // Shell semantics: Tab completes as far as EVERY candidate agrees, then stops and shows you the
  // choice. Typing one more character and pressing Tab again walks you in. Jumping straight to the
  // first candidate would be a guess wearing the costume of a completion.
  function commonPrefix(list) {
    if (!list.length) return '';
    let p = list[0];
    for (const s of list.slice(1)) {
      let i = 0;
      while (i < p.length && i < s.length && p[i] === s[i]) i++;
      p = p.slice(0, i);
      if (!p) break;
    }
    return p;
  }

  // Returns true if the key was consumed. Only DISK chips are driven from the keyboard — when a live
  // menu is showing, Tab and the arrows belong to the TUI on the other end, which is already
  // handling them.
  // Highlight the nth chip (-1 = none). Selection is EXPLICIT: nothing is selected until an arrow
  // key says so, which is what lets Enter keep meaning "send" the rest of the time.
  function selectChip(n) {
    if (!diskChips) return;
    diskChips.sel = n;
    if (!elChips) return;
    const nodes = elChips.childNodes;
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle('sel', i === n);
    if (n >= 0 && nodes[n] && nodes[n].scrollIntoView) nodes[n].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function chipKey(e) {
    if (!diskChips || chipBusy) return false;
    if (!elChips || elChips.hidden || elChips.dataset.source !== 'disk') return false;
    const cands = diskChips.candidates.map((c) => c.text);
    const sel = diskChips.sel == null ? -1 : diskChips.sel;
    const atEnd = elText.selectionStart === elText.value.length && elText.selectionStart === elText.selectionEnd;

    // ← → walk the chips. → only takes over at the END of the line, where the arrow has no other
    // job; mid-line it must still move the caret through what you are editing.
    if (e.key === 'ArrowRight' && atEnd) { selectChip(sel + 1 >= cands.length ? 0 : sel + 1); return true; }
    if (e.key === 'ArrowLeft' && sel >= 0) { selectChip(sel - 1 < 0 ? cands.length - 1 : sel - 1); return true; }

    if (e.key === 'Tab') {
      if (sel >= 0) { applyCompletion(diskChips.token, cands[sel]); return true; }
      // Shell semantics with nothing selected: complete as far as EVERY candidate agrees, then stop
      // and show the choice. Jumping to the first candidate would be a guess wearing the costume of
      // a completion.
      const pre = commonPrefix(cands);
      const pick = pre.length > diskChips.token.body.length ? pre : (cands.length === 1 ? cands[0] : null);
      if (!pick) { selectChip(0); return true; }    // ambiguous: offer the first rather than nothing
      applyCompletion(diskChips.token, pick);
      return true;
    }
    // Enter accepts ONLY a chip you deliberately selected. Otherwise it stays Send — a completion
    // bar must never swallow the key that submits your message.
    if (e.key === 'Enter' && sel >= 0) { applyCompletion(diskChips.token, cands[sel]); return true; }
    if (e.key === 'Escape') { clearChips(); diskChips = null; return true; }
    return false;
  }
  function scheduleDiskChips() {
    if (diskTimer) clearTimeout(diskTimer);
    // Debounced: one request per pause in typing, never one per keystroke.
    diskTimer = setTimeout(fetchDiskChips, 180);
  }
  async function fetchDiskChips() {
    if (chipBusy) return;
    const surface = composerSurface();
    if (!surface || !state.machine) return;
    // A live menu always wins — it is what the terminal is actually showing.
    if (refreshLiveChips(state.composerPane)) return;
    const text = elText.value, caret = elText.selectionStart;
    if (!text || !/[@/]/.test(text)) return clearChips();
    const gen = ++chipGen;
    try {
      const r = await jget('/api/cmux/completions?machine=' + encodeURIComponent(state.machine)
        + '&surface=' + encodeURIComponent(surface)
        + '&text=' + encodeURIComponent(text.slice(0, 4096))
        + '&caret=' + encodeURIComponent(String(caret)));
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (gen !== chipGen) return;               // a newer render happened while this was in flight
      if (!d || !d.token || !d.candidates || !d.candidates.length) return clearChips();
      diskChips = { token: d.token, candidates: d.candidates, gen, sel: -1 };
      paintChips(
        d.candidates.map((c) => ({ label: c.text, kind: c.kind })),
        'disk',
        (i, it) => { if (gen === chipGen) applyCompletion(d.token, it.label); },
      );
    } catch (_) { /* completions are a convenience; never surface a failure as an error */ }
  }

  // Replace the partial token with the full candidate. Nothing is sent — the point of source B is
  // that it works before anything reaches the Mac.
  function applyCompletion(token, full) {
    const v = elText.value;
    const insert = token.sigil + full;
    elText.value = v.slice(0, token.start) + insert + v.slice(token.end);
    const caret = token.start + insert.length;
    elText.setSelectionRange(caret, caret);
    elText.focus();
    autogrow();
    saveDraft();
    clearChips();
    scheduleDiskChips();
  }

  // ---- composer chrome (p7 §5.5) ---------------------------------------------
  // The mode segmented control and the instruction line are removed, and the clipboard button folds
  // into one ＋ menu with attach. Everything is done defensively against a stale shell: if an
  // element is not there, that branch is skipped rather than throwing.
  (function buildComposerChrome() {
    if (elModeSeg) elModeSeg.hidden = true;              // hidden, not deleted — one cache epoch
    if (elHint) elHint.hidden = true;
    const row = elText && elText.parentNode;
    if (!row) return;

    // Live toggle: small, beside the field, and the field itself shows the state (a lit outline) so
    // "this box is alive" is visible rather than read.
    elLiveToggle = document.createElement('button');
    elLiveToggle.type = 'button';
    elLiveToggle.id = 'liveToggle';
    elLiveToggle.className = 'kbtoggle livetoggle';
    elLiveToggle.textContent = '⚡';
    elLiveToggle.setAttribute('aria-label', 'Live keys');
    elLiveToggle.setAttribute('aria-pressed', 'false');
    elLiveToggle.addEventListener('pointerdown', (e) => { e.preventDefault(); toggleLive(); });
    row.insertBefore(elLiveToggle, elText);


    // 📎 + 📋 merge into one ＋ that opens a sheet. Capability hiding is PER ACTION: the clipboard
    // API is missing on some browsers, and hiding the control itself there would remove file
    // attachment too — a regression on something that works today.
    if (elAttachBtn) {
      elAttachBtn.textContent = '＋';
      elAttachBtn.setAttribute('aria-label', 'Attach or paste');
      elAttachBtn.title = 'Attach a file · paste an image';
      const menu = document.createElement('div');
      menu.className = 'plusmenu';
      menu.id = 'plusMenu';
      menu.hidden = true;
      const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); menu.hidden = true; fn(); }; return b; };
      menu.appendChild(mk('Attach a file', () => elAttachInput && elAttachInput.click()));
      if (navigator.clipboard && navigator.clipboard.read) menu.appendChild(mk('Paste an image', pasteImageFromClipboard));
      document.body.appendChild(menu);
      elPlusMenu = menu;
      elAttachBtn.onclick = (e) => {
        e.stopPropagation();
        if (!menu.hidden) { menu.hidden = true; return; }
        const rc = elAttachBtn.getBoundingClientRect();
        menu.hidden = false;
        menu.style.left = Math.max(8, Math.round(rc.left)) + 'px';
        menu.style.top = Math.round(rc.top - menu.offsetHeight - 8) + 'px';
      };
      document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !elAttachBtn.contains(e.target)) menu.hidden = true; });
    }
    if (elPasteBtn) elPasteBtn.hidden = true;    // its action lives in the ＋ sheet now

    // Send fires on pointerdown for the same reason the key bar does: a plain click can be lost when
    // the layout moves underneath between blur and click.
    elSend.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      doSend();
    });
    elSend.onclick = null;
  })();

  // A focused composer freezes layout re-renders (§5.2 rule 3) and keeps its draft.
  elText.addEventListener('focus', () => { state.composerFocused = true; });
  elText.addEventListener('blur', () => {
    state.composerFocused = false;
    saveDraft();
    renderPaneFooters();
    flushPendingLayout();     // apply whatever the Mac did while we were typing
  });
  elText.addEventListener('input', saveDraft);
  elText.addEventListener('input', scheduleDiskChips);
  elText.addEventListener('click', scheduleDiskChips);   // moving the caret changes the token

  // ---- wire up ----
  if (elFilesBtn) elFilesBtn.onclick = (e) => { e.stopPropagation(); toggleFiles(); };
  if (elRadarBtn) elRadarBtn.onclick = (e) => { e.stopPropagation(); toggleRadar(); };
  elRefresh.onclick = loadTree;
  wireFileDrop();
  if (elModeCompose) elModeCompose.onclick = null;   // modes are gone (§5.3); markup kept one cache epoch
  if (elModeLive) elModeLive.onclick = null;
  elWsChip.onclick = (e) => { e.stopPropagation(); toggleWsMenu(); };
  if (elSettingsBtn) elSettingsBtn.onclick = (e) => { e.stopPropagation(); toggleSettings(); };
  if (elFontUp) elFontUp.onclick = () => nudgeZoom(1.15);
  if (elFontDown) elFontDown.onclick = () => nudgeZoom(1 / 1.15);
  if (elFontReset) elFontReset.onclick = () => resetZoom();
  if (elSplitMenu) {
    // every item acts on state.menuPane — the pane whose ⊞ opened this menu
    elSplitMenu.querySelectorAll('button[data-split]').forEach((b) => {
      b.onclick = () => { const p = state.menuPane; closeSplitMenu(); doSplit(b.dataset.split, p); };
    });
    const eq = $('equalize');
    if (eq) eq.onclick = () => { closeSplitMenu(); doEqualize(); };
    const nt = $('paneNewTab');
    if (nt) nt.onclick = () => { const p = state.menuPane; closeSplitMenu(); doNewTab(p); };
    const nb = $('paneNewBrowser');
    if (nb) nb.onclick = () => { closeSplitMenu(); doNewBrowser(); };
    const pc = $('paneClose');
    if (pc) pc.onclick = () => { const p = state.menuPane; closeSplitMenu(); doClosePane(p); };
  }
  // Split view off = mirror one pane at a time even on a wide screen (for when you want the whole
  // window given to the agent you're actually reading).
  if (elSplitToggle) elSplitToggle.onclick = () => {
    state.splitPref = state.splitPref === 'off' ? 'auto' : 'off';
    try { localStorage.setItem('cmux_split', state.splitPref); } catch (_) {}
    updateSplitToggle();
    renderPanes(); renderTabs();
  };
  document.addEventListener('click', (e) => {
    if (!elWsMenu.hidden && !elWsMenu.contains(e.target) && !elWsChip.contains(e.target)) closeWsMenu();
    if (!elSetMenu.hidden && !elSetMenu.contains(e.target) && !elSettingsBtn.contains(e.target)) closeSettings();
    if (elSplitMenu && !elSplitMenu.hidden && !elSplitMenu.contains(e.target)
        && !(state.menuBtn && state.menuBtn.contains(e.target))) closeSplitMenu();
  });
  // A viewport change can cross the split threshold in either direction, so re-render the panes (not
  // just their fonts): at <700px the mirror collapses to the focused pane, above it the split returns.
  let wasSplit = canSplit();
  window.addEventListener('resize', () => {
    closeWsMenu(); closeSettings();
    if (canSplit() !== wasSplit) { wasSplit = canSplit(); renderPanes(); }
    else fitAllFonts();
  });
  elJump.onclick = () => {
    const v = focusedView(); if (!v) return;
    v.followTail = true; v.screenEl.scrollTop = v.screenEl.scrollHeight; updateJump();
  };
  // Per-pane scrolling and tap-to-click are wired in wirePaneTaps/createView — each pane owns its own
  // listeners because each pane owns its own screen element.

  // Live mode: forward each inserted char / enter / backspace straight to the terminal.
  // The field is a transmit buffer while live, so it is emptied after every event — and the height
  // a compose draft grew to must fall WITH the text. autogrow() skips live mode, so nothing else
  // ever shrinks the box: miss it here and an empty one-line field stays draft-tall until the next
  // compose keystroke (the giant empty "Type…" box on phones).
  const liveClear = () => { elText.value = ''; elText.style.height = ''; };
  elText.addEventListener('beforeinput', (e) => {
    if (!state.live) return;
    const t = e.inputType;
    if (t === 'insertText' || t === 'insertCompositionText' || t === 'insertFromPaste') { if (e.data) sendRaw(e.data); e.preventDefault(); liveClear(); return; }
    if (t === 'insertLineBreak' || t === 'insertParagraph') { doKey('enter'); e.preventDefault(); liveClear(); return; }
    if (t === 'deleteContentBackward') { doKey('backspace'); e.preventDefault(); liveClear(); return; }
  });
  // Keys with no text input event (arrows/Esc/Tab/^C) — from a hardware keyboard (tablet). Both modes.
  elText.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // Completion first: while disk chips are up, Tab and → belong to the completion, not to the
    // terminal. Everything else falls straight through, and so does Tab when there is nothing
    // unambiguous to add.
    if (chipKey(e)) { e.preventDefault(); return; }
    const live = state.live;
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
      stopPaneStream(); stopLayoutStream(); closeBrowserStream();
      if (state.browser.urlTimer) { clearInterval(state.browser.urlTimer); state.browser.urlTimer = null; }
    } else if (state.tab) {
      loadTree();   // tree poll pauses while hidden — refresh it on return
      if (state.tabType === 'browser') { browserStream(state.tab.id); refreshBrowserInfo(); if (!state.browser.urlTimer) state.browser.urlTimer = setInterval(refreshBrowserInfo, 2500); }
      else {
        // DOM intact + each view's cached hash → resuming an unchanged pane costs ~10 bytes
        syncLayout(true); startLayoutStream(); syncPaneStreams();
      }
    }
  });
  window.addEventListener('pagehide', () => {
    flushGridCache(); stopPaneStream(); stopLayoutStream(); closeBrowserStream();
    if (state.browser.urlTimer) { clearInterval(state.browser.urlTimer); state.browser.urlTimer = null; }
  });

  // Dock the header + keep the composer above the keyboard, WITHOUT the bounce. body is position:fixed
  // (index.html), so iOS can't pan the layout to reveal the focused input — the earlier bounce was our
  // own scrollTo(0,0) fighting that pan every frame. Here we ONLY size the fixed shell to the visual
  // viewport (rAF-coalesced): when the keyboard opens, vv.height shrinks → body shrinks → the footer
  // (composer) rises above the keyboard and #screen loses the height, while header/tabs stay pinned to
  // the top. No window scroll is touched, so nothing bounces. No-op where visualViewport is missing.
  (() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Establish the fixed shell here in JS too (not just CSS) — index.html is cache-first in the SW, so
    // its position:fixed rule can be a reload behind while this (network-first app.js) is already fresh.
    const bs = document.body.style;
    bs.position = 'fixed'; bs.left = '0'; bs.right = '0';
    let raf = 0;
    const fit = () => {
      raf = 0;
      bs.height = vv.height + 'px';
      bs.top = (vv.offsetTop || 0) + 'px';   // track any offset iOS applies; NOT window.scrollTo
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(fit); };
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    fit();
  })();

  // ---- Radar tab (p5, S-007) -------------------------------------------------
  // The whole integration is this block, and every line of it is defensive on purpose: radar is an
  // add-on to a mirror people depend on, so if radar.js is missing, stale, or throws on create(),
  // `radarUI` stays null, no chip renders, and nothing below this comment ever runs again. The
  // terminal UI cannot tell the difference.
  try {
    if (window.cmuxRadar && typeof window.cmuxRadar.create === 'function') {
      radarUI = window.cmuxRadar.create({
        mount: $('wrap'),
        jget, jpost, promptToken,
        onJump: radarJump,
      });
    }
  } catch (e) { radarUI = null; if (window.console) console.error('radar failed to mount', e); }
  // No radar.js (404, stale cache, threw on create) => remove the chip entirely, matching the
  // pre-merge contract where the chip was only ever built when radarUI existed.
  if (!radarUI && elRadarBtn && elRadarBtn.parentNode) elRadarBtn.remove();

  // Same defensive mount for the source-control panel.
  try {
    if (window.cmuxGit && typeof window.cmuxGit.create === 'function') {
      gitUI = window.cmuxGit.create({
        mount: $('wrap'), jget, jpost, fillComposer,
        machine: () => state.machine,
        // The same status-line seam the bar gets (§7: the bar itself or the existing status line,
        // never a toast). The panel closes the instant it fills, so its own body cannot carry a
        // note the operator would still be able to read — this one outlives the panel.
        note: (msg) => setStatus(msg, true, 6000),
      });
    }
  } catch (e) { gitUI = null; if (window.console) console.error('git panel failed to mount', e); }
  if (!gitUI && elGitBtn && elGitBtn.parentNode) elGitBtn.remove();
  if (gitUI && elGitBtn) elGitBtn.onclick = (e) => { e.stopPropagation(); toggleGit(); };

  // ---- p8: the source-control bar in the file explorer (specs.md §4, §6) ------
  // Same defensive mount again, for the same reason as radar and the panel: if gitbar.js is missing,
  // stale, or throws on create, `gitBarModel` stays null, nothing below ever runs, and Files browses
  // exactly as it does today. A source-control add-on degrades to no source control, never to no
  // mirror.
  let gitBarModel = null, gitBarView = null;

  // §6.3. After a fill the operator must land on a LIVE terminal, and `exitFilesMode()` cannot
  // deliver one: it disconnects the observer, drops the body classes and sets tabType — it never
  // calls selectTab, so nothing resumes polling after setFilesMode's teardownPanes(). toggleFiles
  // warns about exactly this above its own exit branch, and that branch IS the correct path, so this
  // calls it rather than keeping a second copy that can drift out of agreement with it.
  function leaveFiles() {
    if (state.tabType !== 'files' && state.tabType !== 'viewer') return;
    toggleFiles();
  }

  // The bar's door into the p7 panel (§6.6). Two things are the point here:
  //  * the panel binds to the identity the model resolved on its fresh probe — this function is
  //    handed {repo, name, src} and passes them through untouched; it never consults state;
  //  * `onClose` is passed EXPLICITLY on every open. The shipped panel replaces its stored callback
  //    only when one is supplied (git.js:293), so omitting it here would inherit the ⎇ toolbar
  //    door's callback and close a bar-opened panel into the terminal. This door came from Files and
  //    returns to Files, at the directory it was opened from — captured now, because Files is torn
  //    down while the panel is up.
  //  * `onScopeLost` is passed here and NOWHERE ELSE. §7 says every failure hides the bar, and a
  //    mid-session read-gate refusal is the one failure the panel discovers rather than the bar: the
  //    panel leaves, and without this the bar it was opened from would survive the scope loss and go
  //    on offering controls the server will refuse forever. The ⎇ toolbar door must not carry it —
  //    that door has no bar behind it, and §6.6's two-door disjointness is what keeps "the ⎇ journey
  //    never touches p8 code" assertable from the source.
  function openPanel(o) {
    if (!gitUI || !o || !o.repo) return;
    const back = state.files && state.files.path;
    try {
      exitFilesMode();
      if (state.browser && state.browser.surface) exitBrowserMode();
      exitRadarMode();
      teardownPanes();
      setStatus('');
      state.tabType = 'git';
      gitUI.open({
        repo: o.repo, name: o.name, src: o.src,
        machine: state.machine,
        onClose: () => { if (back) enterDir(back); else openFiles(); },
        // hide() is NOT enough here, and the difference is the whole defect: onScopeLost fires
        // BEFORE onClose, onClose re-enters the directory, and enterDir ends in at() — which on a
        // display-cache hit repaints the bar with no request at all. A hidden bar would be back one
        // synchronous line later, still offering controls the read gate now refuses. scopeLost()
        // evicts the refused identity as well, so the re-entry is a miss (§5.2, §7).
        onScopeLost: () => { if (gitBarModel) gitBarModel.scopeLost(); },
      });
    } catch (e) {
      // Restoring `tabType` alone would strand the operator on a blank screen: exitFilesMode() has
      // already dropped the body classes, so #files is display:none and the panes are torn down.
      // The only honest recovery is the one close() performs — put them back in the listing.
      if (window.console) console.error('git panel open from bar failed', e);
      if (back) enterDir(back); else openFiles();
      return;
    }
    renderTabs();
  }

  try {
    if (window.cmuxGitBar && typeof window.cmuxGitBar.createGitBarModel === 'function') {
      gitBarModel = window.cmuxGitBar.createGitBarModel({
        jget, jpost,
        machine: () => state.machine,
        nowMs: Date.now,
        fillComposer, leaveFiles, openPanel,
        // §7: reasons render through the existing #status line (already lifted to z-index 4 over the
        // Files pane) and ride the published state as the bar's own note line. Never a toast.
        note: (msg) => setStatus(msg, true, 6000),
      });
      gitBarView = window.cmuxGitBar.createGitBar({
        model: gitBarModel, doc: document, mount: $('gitbar'),
      });
    }
  } catch (e) {
    gitBarModel = null; gitBarView = null;
    if (window.console) console.error('source-control bar failed to mount', e);
  }

  // ---- Inbox tab (p9, S-008) -------------------------------------------------
  // The same defensive mount, for the same reason. jget/jpost are private to this IIFE, so the
  // factory injection below is the ONLY way the inbox can reach the API — there is no other seam.
  // If /inbox.js 404s (no route, stale cache) or throws in create(), inboxUI stays null, the chip is
  // removed, and the terminal mirror is untouched.
  try {
    if (window.cmuxInbox && typeof window.cmuxInbox.create === 'function') {
      inboxUI = window.cmuxInbox.create({
        mount: $('wrap'),
        jget, jpost, promptToken,
        onJump: radarJump,
      });
    }
  } catch (e) { inboxUI = null; if (window.console) console.error('inbox failed to mount', e); }
  if (!inboxUI && elInboxBtn && elInboxBtn.parentNode) elInboxBtn.remove();
  if (inboxUI && elInboxBtn) elInboxBtn.onclick = (e) => { e.stopPropagation(); toggleInbox(); };

  function toggleInbox() {
    if (!inboxUI) return;
    if (state.tabType === 'inbox') {
      // Leaving goes back through selectTab so the terminal resumes polling — opening the inbox
      // stopped it, and merely hiding the pane would leave a frozen mirror underneath.
      if (state.tab && findTab(state.tab.id)) return selectTab(state.tab.id);
      exitInboxMode(); renderTabs(); return;
    }
    try {
      exitFilesMode();
      if (state.browser && state.browser.surface) exitBrowserMode();
      exitRadarMode();
      exitGitMode();
      teardownPanes();
      setStatus('');
      state.tabType = 'inbox';
      inboxUI.open();
    } catch (e) { state.tabType = 'terminal'; if (window.console) console.error('inbox open failed', e); }
    renderTabs();
  }

  function exitInboxMode() {
    if (!inboxUI) return;
    try { inboxUI.close(); } catch (_) {}
    if (state.tabType === 'inbox') state.tabType = 'terminal';
  }

  function toggleRadar() {
    if (!radarUI) return;
    if (state.tabType === 'radar') {
      // Leaving goes back through selectTab so the terminal resumes polling — opening radar stopped
      // it, and merely hiding the pane would leave a frozen mirror underneath.
      if (state.tab && findTab(state.tab.id)) return selectTab(state.tab.id);
      exitRadarMode(); renderTabs(); return;
    }
    try {
      exitFilesMode();
      if (state.browser && state.browser.surface) exitBrowserMode();
      exitInboxMode();
      // This called the poll-stopper that the multi-pane merge deleted; teardownPanes() is its
      // replacement. Opening radar must stop the mirror, or a frozen terminal sits underneath.
      teardownPanes();
      setStatus('');
      state.tabType = 'radar';
      radarUI.open();
    } catch (e) { state.tabType = 'terminal'; if (window.console) console.error('radar open failed', e); }
    renderTabs();
  }

  function exitRadarMode() {
    if (!radarUI) return;
    try { radarUI.close(); } catch (_) {}
    if (state.tabType === 'radar') state.tabType = 'terminal';
  }

  // Jump from an attention item to the tab it names. Returns {ok:false, reason} rather than
  // throwing, so radar can render the reason as an inline chip on the row that failed.
  //
  // Cross-machine: this server already fronts every registered machine's bridge, so the correct
  // "peer" for a machine we know is simply switching to it in place — no second origin, no second
  // token. A machine this server does NOT front can only be reached at its own URL, and the v1
  // state contract carries no such field, so that case reports why instead of guessing a hostname.
  function radarJump(req) {
    try {
      if (!req || !req.machine) return { ok: false, reason: 'no machine on that item' };
      const known = state.machines.some((m) => m.id === req.machine);
      if (!known) {
        if (req.peerUrl) { window.open(req.peerUrl, '_blank', 'noopener'); return { ok: true }; }
        return { ok: false, reason: req.machine + ' is not connected to this server' };
      }
      const land = () => {
        const ws = state.workspaces.find((w) => (w.tabs || []).some((t) => t.id === req.tabUuid || (req.tabRef && t.ref === req.tabRef)));
        if (!ws) return false;
        const t = (ws.tabs || []).find((x) => x.id === req.tabUuid) || (ws.tabs || []).find((x) => req.tabRef && x.ref === req.tabRef);
        if (!t) return false;
        state.wsRef = ws.ref;
        renderHeader();
        exitRadarMode();
        selectTab(t.id);
        return true;
      };
      if (req.machine !== state.machine) {
        // switchMachine kicks off its own loadTree; retry briefly until that tree lands rather than
        // racing it with a second fetch the busy-guard would drop on the floor.
        switchMachine(req.machine);
        let tries = 0;
        const retry = () => {
          if (land()) return;
          if (++tries > 12) { setStatus('tab not found on ' + req.machine, true, 4000); return; }
          setTimeout(retry, 250);
        };
        setTimeout(retry, 250);
        return { ok: true };
      }
      if (land()) return { ok: true };
      return { ok: false, reason: 'that tab is no longer in the tree' };
    } catch (e) { return { ok: false, reason: (e && e.message) || 'jump failed' }; }
  }

  // ---- Files tab (p4) --------------------------------------------------------
  // Browse the machine's filesystem and read files here on the phone. Read-only: the bridge
  // exposes no write path. Roots and the realpath jail live server-side in fsbrowse.js — this
  // side only renders what it is given and never constructs a path the user did not tap.
  const elFiles = $('files'), elCrumb = $('fcrumb'), elFlist = $('flist'), elFfoot = $('ffoot');
  const elFviewer = $('fviewer'), elFvbody = $('fvbody'), elFvtitle = $('fvtitle');
  const FS_PAGE = 200;
  const fsMem = new Map();          // path -> {entries, total}  — session cache, all loaded pages
  const FS_LS_KEY = 'p4files:';     // localStorage holds page 0 only, for pre-network paint
  const FS_LS_MAX = 40;

  state.files = { path: null, entries: [], total: 0, offset: 0, loading: false, done: false };

  const FS_ERR_MSG = {
    bad_path: 'Bad path',
    not_a_dir: 'Not a directory',
    not_a_file: 'Not a regular file',
    bad_ticket: 'Download link expired — tap Download again',
    bridge_unreachable: 'Machine unreachable',
    outside_root: 'Outside allowed roots',
    tcc_denied: 'Permission denied — grant Full Disk Access to node in System Settings → Privacy',
    not_found: 'Not found',
    too_deep: 'Path too deep',
    read_failed: 'Could not read',
  };

  const fmtSize = (n) => n == null ? '' :
    n < 1024 ? n + ' B' :
    n < 1048576 ? (n / 1024).toFixed(0) + ' KB' :
    n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';

  const fmtAge = (ms) => {
    if (!ms) return '';
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  };

  // Dotfile visibility. Defaults to SHOWN — this browser is for reading your own machine, and
  // hiding things you asked to see is the wrong default here. Persisted so it survives relaunch.
  // Where the user was last browsing. Persisted, not just held in memory: iOS kills the
  // standalone app whenever it is backgrounded, so every open is a cold boot and an in-memory
  // value would be lost exactly when it matters most.
  const FS_LAST_KEY = 'p4files:lastPath';
  const lastPath = () => { try { return localStorage.getItem(FS_LAST_KEY) || ''; } catch (_) { return ''; } };
  const setLastPath = (p) => { try { p ? localStorage.setItem(FS_LAST_KEY, p) : localStorage.removeItem(FS_LAST_KEY); } catch (_) {} };

  const FS_DOT_KEY = 'p4files:showHidden';
  const showHidden = () => { try { return localStorage.getItem(FS_DOT_KEY) !== '0'; } catch (_) { return true; } };
  const setShowHidden = (v) => { try { localStorage.setItem(FS_DOT_KEY, v ? '1' : '0'); } catch (_) {} };

  // Both caches are keyed by path AND dotfile mode — the two modes hold different entry lists and
  // different totals, so sharing one key would paint the other mode's rows on toggle.
  const ckey = (p) => p + (showHidden() ? '' : ' nodot');

  function lsGet(p) { try { return JSON.parse(localStorage.getItem(FS_LS_KEY + ckey(p)) || 'null'); } catch (_) { return null; } }
  function lsSet(p, v) {
    try {
      localStorage.setItem(FS_LS_KEY + ckey(p), JSON.stringify(v));
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(FS_LS_KEY));
      while (keys.length > FS_LS_MAX) localStorage.removeItem(keys.shift());
    } catch (_) { /* quota — this cache is an optimisation, not a requirement */ }
  }

  // Files and the viewer are full-bleed panes over #wrap, driven by body classes like the
  // existing browser mode. Entering either stops terminal polling — nothing is being mirrored.
  function setFilesMode(which) {
    state.tabType = which;
    document.body.classList.toggle('mode-files', which === 'files');
    document.body.classList.toggle('mode-fview', which === 'viewer');
    if (which === 'files' || which === 'viewer') {
      exitRadarMode();
      exitInboxMode();
      // teardownPanes() is the multi-pane replacement for the old poll-stopper — same job, stop
      // mirroring. The old function no longer exists, so calling it here would throw.
      teardownPanes();
      // The status pill describes the terminal mirror, and nothing is being mirrored in here.
      // It is also visible over these panes now, so leaving it would park a stale 'live' on screen.
      setStatus('');
      if (state.browser && state.browser.surface) exitBrowserMode();
    }
    renderTabs();
  }

  // The 📁 control both opens and dismisses. Leaving goes back through selectTab so the terminal
  // resumes polling — setFilesMode stopped it on the way in, and simply un-hiding the pane would
  // leave a frozen mirror.
  function toggleFiles() {
    if (state.tabType === 'files' || state.tabType === 'viewer') {
      if (state.tab && findTab(state.tab.id)) return selectTab(state.tab.id);
      exitFilesMode();
      renderTabs();
      return;
    }
    // Resume where you left off. The roots screen is a starting point, not a home you should be
    // sent back to every time you glance at a terminal.
    const last = lastPath();
    if (last) return enterDir(last, true);
    openFiles();
  }

  // Symmetric with exitBrowserMode: one place that tears the Files panes down, so callers never
  // have to know which body class is currently set.
  function exitFilesMode() {
    if (fsObserver) { fsObserver.disconnect(); fsObserver = null; }
    document.body.classList.remove('mode-files', 'mode-fview');
    if (state.tabType === 'files' || state.tabType === 'viewer') state.tabType = 'terminal';
  }

  async function openFiles() {
    setFilesMode('files');
    // The roots screen has no current directory, so there is nothing the bar could be standing in.
    // hide() is an invalidating transition (§5.3): it also aborts and bumps the generation, so a
    // probe still in flight from the directory we just left cannot resurrect a bar here.
    if (gitBarModel) gitBarModel.hide();
    elCrumb.replaceChildren();
    elFlist.replaceChildren();
    elFfoot.textContent = 'Loading…';
    state.files.path = null;
    // Reaching roots is a deliberate act (the ⌂ crumb), so it becomes the remembered position.
    setLastPath('');
    let data;
    try { data = await (await jget('/api/cmux/fs/roots?machine=' + encodeURIComponent(state.machine))).json(); }
    catch (_) { elFfoot.textContent = 'roots failed'; return; }
    if (data.error) { elFfoot.textContent = FS_ERR_MSG[data.error] || data.error; return; }
    elFfoot.textContent = '';
    const groups = [['workspace', 'Workspaces'], ['fixed', 'Roots'], ['place', 'Places']];
    for (const [kind, heading] of groups) {
      const rows = (data.roots || []).filter((r) => r.kind === kind);
      if (!rows.length) continue;
      const h = document.createElement('div');
      h.className = 'fhead'; h.textContent = heading;
      elFlist.appendChild(h);
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'frow dir';
        const n = document.createElement('span'); n.className = 'fname'; n.textContent = '📁 ' + r.label;
        const m = document.createElement('span'); m.className = 'fmeta'; m.textContent = r.path;
        row.append(n, m);
        row.onclick = () => enterDir(r.path);
        elFlist.appendChild(row);
      }
    }
    if (!elFlist.childNodes.length) elFfoot.textContent = 'No roots configured';
  }

  function renderCrumb(p) {
    elCrumb.replaceChildren();
    const home = document.createElement('span');
    home.textContent = '⌂';
    home.onclick = () => openFiles();
    elCrumb.appendChild(home);
    let acc = '';
    for (const seg of p.split('/').filter(Boolean)) {
      acc += '/' + seg;
      const at = acc;
      const s = document.createElement('span');
      s.textContent = seg;
      s.onclick = () => enterDir(at);
      elCrumb.appendChild(s);
    }
  }

  function appendRows(entries) {
    const base = state.files.path === '/' ? '' : state.files.path;
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'frow' + (e.type === 'dir' ? ' dir' : '');
      const icon = e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : e.type === 'special' ? '⚙︎' : '📄';
      const n = document.createElement('span');
      n.className = 'fname'; n.textContent = icon + ' ' + e.name;
      const m = document.createElement('span');
      m.className = 'fmeta';
      m.textContent = [fmtSize(e.size), fmtAge(e.mtime)].filter(Boolean).join(' · ');
      row.append(n, m);
      const child = base + '/' + e.name;
      // A symlink's target type is not resolved during listing (that would cost a stat per row),
      // so try it as a directory and fall back to the viewer if the server says otherwise.
      row.onclick = () => (e.type === 'dir' ? enterDir(child)
        : e.type === 'link' ? enterDirOrFile(child)
        : openFile(child));
      elFlist.appendChild(row);
    }
  }

  async function loadPage(reset) {
    const f = state.files;
    if (f.loading || (!reset && f.done)) return;
    f.loading = true;
    elFfoot.textContent = 'Loading…';
    const qs = new URLSearchParams({
      machine: state.machine, path: f.path,
      offset: String(reset ? 0 : f.offset), limit: String(FS_PAGE),
      hidden: showHidden() ? '1' : '0',
    });
    let d;
    try { d = await (await jget('/api/cmux/fs/list?' + qs)).json(); }
    catch (_) { elFfoot.textContent = 'list failed'; f.loading = false; return; }
    f.loading = false;
    if (d.error) {
      // A remembered path that no longer resolves should not strand the user on an error screen.
      if (f.restoring && ['not_found', 'outside_root', 'not_a_dir', 'bad_path'].includes(d.error)) {
        setLastPath('');
        return openFiles();
      }
      elFfoot.textContent = FS_ERR_MSG[d.error] || d.error;
      return;
    }
    f.restoring = false;
    if (reset) { f.entries = []; f.offset = 0; f.done = false; elFlist.replaceChildren(); elFsent = null; }
    f.entries = f.entries.concat(d.entries);
    f.total = d.total;
    f.offset = d.offset + d.entries.length;
    f.done = f.offset >= f.total;
    appendRows(d.entries);
    elFfoot.textContent = f.done ? `${f.total} items` : `${f.offset} / ${f.total} — scroll for more`;
    fsMem.set(ckey(f.path), { entries: f.entries, total: f.total });
    if (d.offset === 0) lsSet(f.path, { entries: d.entries, total: d.total });
    if (!f.done) armSentinel();
  }

  // The sentinel must live INSIDE #flist: IntersectionObserver only reports a target that is a
  // descendant of its root, and #ffoot is a sibling of the scroll container, not a child. Watching
  // #ffoot silently never fires, which killed lazy loading past the first page.
  let fsObserver = null;
  let elFsent = null;
  function armSentinel() {
    if (fsObserver) fsObserver.disconnect();
    if (!elFsent) { elFsent = document.createElement('div'); elFsent.id = 'fsent'; }
    elFlist.appendChild(elFsent);          // always the last child, after the rows just added
    fsObserver = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting)) { fsObserver.disconnect(); loadPage(false); }
    }, { root: elFlist, rootMargin: '400px' });
    fsObserver.observe(elFsent);
  }

  // `restoring` marks a re-entry from a remembered path rather than a tap. Such a path can have
  // gone stale — the directory deleted, or FS_ROOTS narrowed since — so it falls back to the
  // roots screen instead of stranding the user on an error.
  function enterDir(p, restoring) {
    setFilesMode('files');
    state.files = { path: p, entries: [], total: 0, offset: 0, loading: false, done: false,
                    restoring: !!restoring };
    setLastPath(p);
    renderCrumb(p);
    elFlist.replaceChildren();
    // Pre-network paint from cache, the same trick the terminal grid uses on a cold load.
    const warm = fsMem.get(ckey(p)) || lsGet(p);
    if (warm && warm.entries) {
      appendRows(warm.entries);
      elFfoot.textContent = `${warm.entries.length} / ${warm.total}`;
    }
    history.pushState({ p4dir: p }, '', '#files=' + encodeURIComponent(p));
    loadPage(true);
    // LAST, and never awaited: the listing is already painted by the time git is asked anything, so
    // a slow, queued or refused probe cannot delay a single row. at() also aborts the probe of the
    // directory we just left, which is what keeps a stale answer from overwriting this one (§5.3).
    if (gitBarModel) gitBarModel.at(p);
  }

  // A symlink row: ask the server to list it; if it is really a file, open it in the viewer.
  async function enterDirOrFile(p) {
    const qs = new URLSearchParams({ machine: state.machine, path: p, offset: '0', limit: '1' });
    let d;
    try { d = await (await jget('/api/cmux/fs/list?' + qs)).json(); } catch (_) { return openFile(p); }
    if (d.error === 'not_a_dir') return openFile(p);
    return enterDir(p);
  }

  window.addEventListener('popstate', (e) => {
    const st = e.state || {};
    if (st.p4dir) return enterDir(st.p4dir);
    if (state.tabType === 'viewer') {
      // leaving the viewer returns to the directory that was open behind it
      if (state.files.path) {
        setFilesMode('files');
        // openFile hid the bar on the way in, and this path repaints the listing without going
        // through enterDir — so without this the bar would stay gone for the rest of the visit.
        // Within the display-cache TTL this costs no request (§5.2).
        if (gitBarModel) gitBarModel.at(state.files.path);
        renderTabs(); return;
      }
      return openFiles();
    }
    if (state.tabType === 'files') return openFiles();
  });

  // Pull-to-refresh: drop both caches for the current directory and refetch page 0.
  (() => {
    let y0 = null;
    elFlist.addEventListener('touchstart', (e) => {
      y0 = elFlist.scrollTop === 0 ? e.touches[0].clientY : null;
    }, { passive: true });
    elFlist.addEventListener('touchend', (e) => {
      if (y0 == null || !state.files.path) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy > 80) {
        fsMem.delete(ckey(state.files.path));
        try { localStorage.removeItem(FS_LS_KEY + ckey(state.files.path)); } catch (_) {}
        loadPage(true);
      }
    }, { passive: true });
  })();

  // ---- viewer -----------------------------------------------------------------
  // Vendored renderers load ONCE, and only when a file is first opened, so a terminal-only
  // session never pays for ~200KB it will not use.
  let vendorReady = null;
  function loadVendor() {
    if (vendorReady) return vendorReady;
    const one = (tag, attrs) => new Promise((res, rej) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = res; el.onerror = rej;
      document.head.appendChild(el);
    });
    vendorReady = Promise.all([
      one('link', { rel: 'stylesheet', href: '/vendor/highlight.min.css' }),
      one('script', { src: '/vendor/marked.min.js' }),
      one('script', { src: '/vendor/purify.min.js' }),
      one('script', { src: '/vendor/highlight.min.js' }),
    ]);
    return vendorReady;
  }

  let fvState = { kind: '', text: '', lang: '', dataUri: '', size: 0, raw: false, path: '' };

  function renderViewer() {
    elFvbody.replaceChildren();
    const isMd = /\.(md|markdown)$/i.test(fvState.path);
    $('fvtoggle').hidden = !isMd;
    $('fvtoggle').textContent = fvState.raw ? 'Rendered' : 'Raw';
    // Copy has a clipboard only for text; on an image or a binary it would report "copied" having
    // written an empty string. Download is the affordance those kinds actually have — and it is the
    // ORIGINAL file, not the downscaled JPEG the image view is showing.
    $('fvcopy').hidden = fvState.kind !== 'text';
    $('fvdl').hidden = !fvState.path || fvState.kind === 'special';

    if (fvState.kind === 'image') {
      const img = document.createElement('img');
      img.src = fvState.dataUri;
      img.alt = fvState.path.split('/').pop();
      elFvbody.appendChild(img);
      return;
    }
    if (fvState.kind === 'binary' || fvState.kind === 'special') {
      elFvbody.textContent = (fvState.kind === 'special' ? 'special file' : 'binary')
        + (fvState.size ? ' · ' + fmtSize(fvState.size) : '');
      return;
    }
    if (isMd && !fvState.raw && window.marked && window.DOMPurify) {
      // ORDER IS LOAD-BEARING: marked passes raw HTML through by design, and SERVER_TOKEN lives
      // in localStorage in THIS origin — a README with <img onerror=…> would exfiltrate it.
      // Sanitize between parse and insertion, every time.
      const html = window.marked.parse(fvState.text, { gfm: true, breaks: false });
      const div = document.createElement('div');
      div.innerHTML = window.DOMPurify.sanitize(html);
      elFvbody.appendChild(div);
      return;
    }
    // Code, and raw markdown: inserted as TEXT into <pre><code>, then coloured in place.
    // The file's contents never go through innerHTML.
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = fvState.text;
    if (fvState.lang) code.className = 'language-' + fvState.lang;
    pre.appendChild(code);
    elFvbody.appendChild(pre);
    if (window.hljs && !fvState.raw) {
      try { window.hljs.highlightElement(code); } catch (_) { /* highlighting is cosmetic */ }
    }
  }

  async function openFile(p) {
    setFilesMode('viewer');
    // The viewer covers the listing, so the bar is off screen — and a probe pending from the
    // directory behind it must not publish into a screen with no current directory (§5.3).
    if (gitBarModel) gitBarModel.hide();
    const base = p.split('/').pop();
    elFvtitle.textContent = base;
    elFvbody.textContent = 'Loading…';
    history.pushState({ p4file: p }, '', '#file=' + encodeURIComponent(p));
    const qs = new URLSearchParams({ machine: state.machine, path: p });
    let d;
    try { d = await (await jget('/api/cmux/fs/read?' + qs)).json(); }
    catch (_) { elFvbody.textContent = 'read failed'; return; }
    if (d.error) { elFvbody.textContent = FS_ERR_MSG[d.error] || d.error; return; }
    await loadVendor().catch(() => { /* degrade to plain text rather than showing nothing */ });
    fvState = { kind: d.kind, text: d.text || '', lang: d.lang || '', dataUri: d.dataUri || '',
                size: d.size || 0, raw: false, path: p };
    elFvtitle.textContent = base + (d.truncated ? ' · truncated' : '');
    renderViewer();
  }

  // Dotfile checkbox: reflects the persisted choice on load, and re-fetches page 0 on change
  // (the filter is applied server-side, so the current pages are simply the wrong list).
  $('fdotcb').checked = showHidden();
  $('fdotcb').onchange = (e) => {
    setShowHidden(e.target.checked);
    if (state.files.path) loadPage(true);
  };

  $('fvtoggle').onclick = () => { fvState.raw = !fvState.raw; renderViewer(); };
  $('fvcopy').onclick = () => {
    const t = fvState.text || '';
    if (!navigator.clipboard) return setStatus('clipboard unavailable', true);
    navigator.clipboard.writeText(t).then(() => setStatus('copied', false, 1800),
      () => setStatus('copy failed', true, 3000));
  };

  // Download the file the viewer is showing — the WHOLE original, so this is the way a zip, a
  // video, or an untranscoded HEIC gets off the machine, not just the text on screen.
  //
  // Two steps, not one: mint a ticket over an authenticated fetch, then navigate to a URL carrying
  // only that ticket. A navigation cannot set an Authorization header, and the alternative — the
  // token in the query string — would leak it into history and logs. Blob-ing the file through
  // fetch() was the other option and is the wrong one here: it would hold a multi-gigabyte
  // download entirely in the phone's memory and hide the native download UI.
  $('fvdl').onclick = async () => {
    const p = fvState.path;
    if (!p) return;
    const name = p.split('/').pop() || 'download';
    setStatus('preparing ' + name + '…');
    let d;
    try {
      const qs = new URLSearchParams({ machine: state.machine, path: p });
      d = await (await jget('/api/cmux/fs/download-ticket?' + qs)).json();
    } catch (_) { return setStatus('download failed', true, 4000); }
    if (!d || !d.ticket) return setStatus(FS_ERR_MSG[d && d.error] || 'download failed', true, 4000);
    const a = document.createElement('a');
    a.href = '/api/cmux/fs/download?ticket=' + encodeURIComponent(d.ticket);
    a.download = name;               // the server sends Content-Disposition too; this covers both
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('downloading ' + name, false, 3000);
  };
  $('fvback').onclick = () => history.back();

  (async () => {
    updateFontVal();
    applyLive(false);
    // Pre-network paint: show the last-seen grid of the last-viewed tab IMMEDIATELY (localStorage),
    // before any round trip — over a tunnel the boot chain is RTT-bound and used to sit blank.
    // The pane this belongs to isn't known yet (that needs the layout), so it paints into a throwaway
    // full-size view which renderPanes discards as soon as the real panes exist.
    try {
      const lt = localStorage.getItem('cmux_last_tab');
      const raw = lt && localStorage.getItem(GRID_LS_PREFIX + lt);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.grid) {
          elEmpty.style.display = 'none';
          const v = createView({ id: '__boot', ref: '__boot' });
          updateView(v, { id: '__boot', ref: '__boot', x: 0, y: 0, w: 1, h: 1, solo: true });
          renderGrid(v, d.grid);
          setStatus('connecting…');
        }
      }
    } catch (_) {}
    // One round trip: machines + default machine's tree together.
    let boot = null, r = null;
    try { r = await jget('/api/cmux/bootstrap'); } catch (_) { gate('Could not reach the server.'); return; }
    if (r.status === 401) { gate(TOKEN ? 'Access token was rejected. Enter the current token.' : 'An access token is required.', true); return; }
    if (r.ok) boot = await r.json().catch(() => null);
    if (!boot) { gate('Could not reach the server.'); return; }
    state.machines = boot.machines || [];
    state.machine = boot.machine || (state.machines[0] && state.machines[0].id) || null;
    const cur = state.machines.find((m) => m.id === state.machine);
    elHost.textContent = (cur && cur.label) || '';
    if (!state.machine) { gate('No machines configured. Set CMUX_MACHINE_URL on the server.'); return; }
    if (boot.error) setStatus(boot.error, true);
    applyTree(boot.workspaces || []);
    syncLayout(true);                 // geometry is a second call — the tree paints first, then splits
    state.treeTimer = setInterval(loadTree, 5000);
  })();
})();
