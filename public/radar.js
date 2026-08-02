// cmux-remote — Radar tab (p5, story S-007). Renders mockup-v2 from live /api/radar/state.
//
// WHY THIS IS ITS OWN FILE, self-contained down to its own <style>:
// radar is an ADD-ON to a terminal mirror people depend on, and the binding rule is that a radar
// failure may only ever break radar. server.js gets that structurally by never requiring radar/
// unless RADAR_ENABLED is set; the browser gets it the same way. app.js touches radar through
// exactly one global (window.cmuxRadar) behind try/catch, and everything radar owns — markup,
// styles, timer, state — is created in here. If this file 404s, fails to parse, or throws on
// create(), app.js sees no global, renders no chip, and the terminal UI is byte-for-byte what it
// was. No shared stylesheet, no shared DOM, no shared state.
//
// COLOUR LAW (spec §7, binding, and the reason the mockup was approved after an earlier one was
// rejected for clutter): GREEN is action and live, and nothing else — the Jump button, `● live
// now`, the sweep. RED is urgent, and nothing else — the NOW label, the hero frame, a deadline, a
// ladder violation. Everything else is neutral, INCLUDING done-segments: a finished stage reads by
// SHAPE (filled vs empty vs hatched), never by colour. So the eye has exactly two things it can be
// pulled by, and both of them mean something.
//
// The five ladder states must stay distinguishable without colour: done = filled, current = bright
// outline, todo = dim outline, unknown = HATCHED (see §2 — unknown must never look like progress or
// like completion), violation = the one red cell.
(function () {
  'use strict';

  var QUEUE_MAX = 4;                       // mockup-v2 limit is canonical
  var POLL_MS = 60000;                     // spec §7: one fetch of our OWN server every 60s
  var STALE_MULT = 2;                      // snapshot-age badge fires past 2x the scan cadence
  var CHIP_MS = 9000;                      // how long an inline failure chip stays up
  var LS_FOLDS = 'p5radar:folds';
  var FOLD_PREF_V = 2;                     // see the migration in create(): `moving` changed default

  // Why a blocked row has no Jump, in words. The vocabulary is mod-sessions' `surfaceReason`; the
  // fallback is the old flat text, which is what a snapshot from an older collector still carries.
  // "no tab — surface unknown" told you nothing; "4 tabs in that workspace" tells you the join is
  // IMPOSSIBLE rather than broken, which is a different thing to do about it.
  var NOJUMP_TEXT = {
    'no-cwd': 'no cwd — cannot place this session',
    'shared-cwd': 'two sessions share this directory',
    'no-workspace-for-cwd': 'no cmux workspace covers this directory',
    'ambiguous-workspace': 'two workspaces share that name',
    'no-terminal-tab': 'that workspace has no terminal tab',
    'no-tab-uuid': 'that tab has no stable id',
    'tree-unavailable': 'cmux tree unreachable',
    'recorded-tab-gone': 'that tab has been closed',
  };
  var LADDER = [
    ['spec', 'spec'], ['pushed', 'pushed'], ['mergedDevelop', 'merged'],
    ['deployedDev', 'on dev'], ['prod', 'on prod'], ['flags', 'flag on'],
  ];

  // ---- little helpers ---------------------------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

  function age(iso, now) {
    if (!iso) return 'never';
    var t = Date.parse(iso);
    // derive uses the UNIX EPOCH as its "every input was missing" sentinel (lastActivityAt of an
    // epic that exists only in Jira, with no branch, no commit and no session). Rendering that as an
    // age produced "20665d" on the real board — a fabricated fact dressed up as a measurement.
    if (isFinite(t) && t < 86400000) return '—';
    var ms = now - t;
    if (!isFinite(ms)) return 'unknown';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return s + 's';
    var m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }
  // Minutes remaining, floored at 0 — a deadline that has passed reads "now", never "-3 min".
  function minsLeft(iso, now) {
    if (!iso) return null;
    var ms = Date.parse(iso) - now;
    if (!isFinite(ms)) return null;
    return Math.max(0, Math.round(ms / 60000));
  }
  function hhmm(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function days(iso, now) {
    if (!iso) return null;
    var d = Math.floor((now - Date.parse(iso)) / 86400000);
    return isFinite(d) ? Math.max(0, d) : null;
  }

  // A stable identity per attention item. Optimistic updates, inline error chips and popovers are
  // all anchored on it, so it has to survive a re-render and a re-fetch — array index would not.
  function itemKey(it) {
    switch (it.type) {
      case 'blocked':
      case 'blocked-stale': return 'blocked:' + (it.sessionKey ? it.sessionKey.machine + ':' + it.sessionKey.sessionId : '?');
      case 'rule-violation': return 'rv:' + it.repo + ':' + it.env;
      case 'decision': return 'dec:' + it.id;
      case 'mergeable': return 'mrg:' + it.epic;
      case 'orphan': return 'orp:' + it.repo + ':' + it.branch;
      case 'spec-orphan': return 'spo:' + it.specFolder;
      // One of each per snapshot by construction, so the type alone is the identity.
      case 'orphan-group': return 'orpg';
      case 'spec-orphan-group': return 'spog';
      default: return 'x:' + JSON.stringify(it).slice(0, 60);
    }
  }
  var isGroup = function (it) { return it && (it.type === 'orphan-group' || it.type === 'spec-orphan-group'); };

  // ---- styles -----------------------------------------------------------------------------------
  // Every selector is under #radar. The one exception is the two body-class rules, which is how
  // this pane is shown at all — the same mechanism the Files pane uses (body.mode-files).
  var CSS = [
    '#radar{position:absolute;inset:0;z-index:3;display:none;overflow-y:auto;-webkit-overflow-scrolling:touch;',
    '  background:#0b0e13;color:#e2e9f1;font-family:var(--rmono);font-size:13px;line-height:1.5;',
    '  --rbg:#0b0e13;--rpanel:#10151d;--rline:#1a232e;--rink:#e2e9f1;--rmuted:#77879a;--rdim:#46525f;',
    '  --raccent:#2ee6a0;--ralert:#ff5d64;',
    '  --rmono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;',
    '  --rsans:system-ui,-apple-system,"Segoe UI",sans-serif}',
    'body.mode-radar #radar{display:block}',
    'body.mode-radar footer{display:none}',
    'body.mode-radar #status{top:auto;bottom:12px;left:12px;z-index:4;border:1px solid var(--rline)}',
    '#radar *{box-sizing:border-box}',
    '#radar .rsurface{padding:20px 16px 48px;display:flex;flex-direction:column;gap:22px;max-width:880px;margin:0 auto}',

    // head — one quiet line. GREEN here is the sweep + the wordmark: radar is live.
    '#radar .head{display:flex;align-items:center;gap:12px;color:var(--rdim);font-size:12px}',
    '#radar .scope{width:22px;height:22px;border-radius:50%;border:1px solid var(--raccent);position:relative;flex:none;opacity:.9}',
    '#radar .scope::after{content:"";position:absolute;inset:0;border-radius:50%;',
    '  background:conic-gradient(from 0deg,#2ee6a05c,transparent 75deg);animation:rsweep 5s linear infinite}',
    '@media (prefers-reduced-motion: reduce){#radar .scope::after{animation:none}}',
    '@keyframes rsweep{to{transform:rotate(360deg)}}',
    '#radar .head .t{color:var(--raccent);letter-spacing:.2em;font-weight:600;font-size:13px}',
    '#radar .head .right{margin-left:auto;text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#radar .head .newdec{flex:none;background:none;border:1px solid var(--rline);color:var(--rdim);',
    '  border-radius:6px;padding:2px 9px;font:11px var(--rmono);cursor:pointer}',

    // badges — NEUTRAL on purpose. A dead Vercel token is not urgent, and painting it red would
    // spend the one colour that means "drop everything" on something that can wait.
    '#radar .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:-12px}',
    '#radar .badges:empty{display:none}',
    '#radar .badge{border:1px solid var(--rline);background:var(--rpanel);color:var(--rmuted);',
    '  border-radius:999px;padding:3px 10px;font-size:11px;font-family:var(--rmono);white-space:nowrap}',
    '#radar .badge b{color:var(--rink);font-weight:700}',
    '#radar .badge button{background:none;border:none;color:var(--rink);text-decoration:underline;',
    '  font:inherit;padding:0 0 0 6px;cursor:pointer}',

    // hero — the one urgent thing. The only place red is spent on a whole frame.
    '#radar .now-label{font-size:11px;letter-spacing:.28em;color:var(--ralert);font-weight:700}',
    '#radar .hero{border:1px solid #ff5d6440;background:linear-gradient(180deg,#ff5d640d,transparent 70%),var(--rpanel);',
    '  border-radius:12px;padding:18px 18px;display:flex;align-items:center;gap:16px}',
    '#radar .hero-icon{font-size:28px;flex:none;line-height:1}',
    '#radar .hero-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '#radar .hero-title{font-size:18px;font-weight:700;color:var(--rink);font-family:var(--rsans)}',
    '#radar .hero-meta{color:var(--rmuted);font-size:13px}',
    '#radar .hero-meta b{color:var(--ralert);font-weight:700}',
    '#radar .jump{flex:none;border:none;border-radius:8px;background:var(--raccent);color:#06251a;',
    '  font:700 14px var(--rsans);padding:11px 20px;cursor:pointer}',
    '#radar .hero .q-act{margin-left:0}',
    // no-jump case: a surface radar could not identify gets a REASON, never a dead button. Wider
    // and wrapping since the reason became a sentence rather than the word "unknown".
    '#radar .nojump{flex:none;color:var(--rdim);font-size:11px;max-width:180px;text-align:right;line-height:1.35}',

    // quiet / empty board: the sweep and "all quiet", per the mockup's closing note
    '#radar .quiet{display:flex;flex-direction:column;align-items:center;gap:10px;padding:34px 10px;',
    '  border:1px solid var(--rline);border-radius:12px;background:var(--rpanel)}',
    '#radar .quiet .big{font-family:var(--rsans);font-size:17px;color:var(--rink);font-weight:600}',
    '#radar .quiet .sub{color:var(--rdim);font-size:12px;text-align:center}',
    '#radar .quiet .scope{width:34px;height:34px}',

    // queue
    '#radar .queue{display:flex;flex-direction:column}',
    '#radar .q-row{display:flex;align-items:center;gap:12px;padding:10px 6px;border-bottom:1px solid var(--rline)}',
    '#radar .q-row:last-child{border-bottom:none}',
    '#radar .q-icon{width:24px;text-align:center;color:var(--rmuted);font-size:15px;flex:none}',
    '#radar .q-text{color:var(--rink);font-family:var(--rsans);font-size:14px;min-width:0;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}',
    '#radar .q-text small{color:var(--rdim);font-size:12px;margin-left:10px;font-family:var(--rmono)}',
    '#radar .q-act{margin-left:auto;flex:none;border:1px solid #2a3646;color:var(--rmuted);background:none;',
    '  border-radius:6px;padding:3px 13px;font:12px var(--rmono);cursor:pointer}',
    '#radar .q-act:disabled{opacity:.5}',
    '#radar .q-more{align-self:flex-start;margin-top:8px;background:none;border:1px solid var(--rline);',
    '  color:var(--rmuted);border-radius:6px;padding:5px 13px;font:12px var(--rmono);cursor:pointer}',
    // expanded group members: indented, quieter, and visibly subordinate to the row they came from
    '#radar .q-row.member{padding-left:30px;border-bottom-style:dotted}',
    '#radar .q-row.member .q-text{font-size:13px;color:var(--rmuted)}',
    '#radar .q-empty{padding:8px 6px 8px 30px;color:var(--rdim);font-size:12px}',

    // inline failure chip — the revert half of the mutation contract, anchored to its own row
    '#radar .chip{display:block;color:var(--ralert);font-size:11px;font-family:var(--rmono);',
    '  padding:0 6px 8px 42px;overflow-wrap:anywhere}',

    // folds
    '#radar .folds{display:flex;flex-direction:column;gap:8px}',
    '#radar .fold{display:flex;align-items:center;gap:12px;border:1px solid var(--rline);border-radius:9px;',
    '  background:var(--rpanel);padding:11px 14px;color:var(--rmuted);cursor:pointer;',
    '  font-family:var(--rsans);font-size:13.5px;width:100%;text-align:left}',
    '#radar .fold .caret{color:var(--rdim);font-family:var(--rmono)}',
    '#radar .fold .n{color:var(--rink);font-weight:700;font-variant-numeric:tabular-nums}',
    '#radar .fold .icon{width:22px;text-align:center}',
    '#radar .fold .peek{margin-left:auto;color:var(--rdim);font-size:12px;font-family:var(--rmono);',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}',
    '#radar .fold-open{border:1px solid var(--rline);border-radius:9px;background:var(--rpanel);overflow:hidden}',
    '#radar .fold-open .fold{border:none;border-radius:0;background:none}',
    '#radar .er{display:flex;align-items:center;gap:12px;padding:9px 14px 9px 30px;border-top:1px solid var(--rline);flex-wrap:wrap}',
    // Wider than the mockup's 150px: mockup names were short slugs ("p61 chokepoint"), real ones are
    // an issue key PLUS a title ("PROJ-108 Search indexing") and were ellipsing mid-word.
    '#radar .er .name{color:var(--rink);font-family:var(--rsans);font-size:13.5px;width:210px;flex:none;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#radar .er .phrase{color:var(--rmuted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 90px}',
    '#radar .er .when{margin-left:auto;color:var(--rdim);font-size:11.5px;flex:none}',
    '#radar .er .live{color:var(--raccent)}',                        // GREEN = live. The only one here.
    '#radar .ladder-key{padding:8px 14px 12px 30px;color:var(--rdim);font-size:11px;',
    '  border-top:1px solid var(--rline);font-family:var(--rsans)}',

    // ladder: five states, four of them told apart by SHAPE alone
    '#radar .ladder{display:inline-flex;gap:3px;flex:none}',
    '#radar .step{width:16px;height:14px;border-radius:3px;background:#161d27;border:1px solid var(--rline);',
    '  padding:0;cursor:default}',
    '#radar .step.done{background:#d7e2ee4d;border-color:#d7e2ee66}',
    '#radar .step.cur{background:#161d27;border-color:#d7e2ee59}',
    '#radar .step.unk{background:repeating-linear-gradient(45deg,#2b3543,#2b3543 2px,#161d27 2px,#161d27 4px);',
    '  border-color:#2b3543}',
    '#radar .step.bad{background:#ff5d6438;border-color:#ff5d645f}',
    '#radar .step.flagcell{cursor:pointer}',

    // worktree cleanup rows: COMMANDS FOR THE HUMAN. Radar removes nothing, ever.
    '#radar .wt{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 30px;border-top:1px solid var(--rline)}',
    '#radar .wt code{flex:1 1 auto;min-width:0;font-family:var(--rmono);font-size:11.5px;color:var(--rmuted);',
    '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#radar .wt .why{flex:none;color:var(--rdim);font-size:11px}',
    '#radar .wt.dirty code{color:var(--rdim)}',
    '#radar .wt.sub code{color:var(--rmuted);font-family:var(--rsans);font-size:12px}',
    '#radar .wt.dirty-toggle{width:100%;background:none;border-left:none;border-right:none;border-bottom:none;',
    '  text-align:left;cursor:pointer;font:inherit}',
    '#radar .wt.dirty-toggle .caret{color:var(--rdim);font-family:var(--rmono);flex:none}',

    // p6 select mode + confirm sheet + recovery (spec §7.2). Checkboxes exist ONLY in select mode;
    // the resting board renders none of this.
    '#radar .selbtn{flex:none;background:none;border:1px solid var(--rline);color:var(--rdim);',
    '  border-radius:6px;padding:2px 9px;font:11px var(--rmono);cursor:pointer}',
    '#radar .selbox{flex:none;margin:0 2px 0 0;accent-color:var(--raccent)}',
    '#radar .selbar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;',
    '  border:1px solid var(--rline);border-radius:9px;background:var(--rpanel);padding:10px 14px;',
    '  font:12px var(--rmono);color:var(--rmuted)}',
    '#radar .selbar button{background:none;border:1px solid #2a3646;color:var(--rink);border-radius:7px;',
    '  padding:6px 12px;font:12px var(--rmono);cursor:pointer}',
    '#radar .selbar button:disabled{opacity:.5}',
    '#radar .hsheet{position:fixed;z-index:50;inset:0;background:#0b0e13d9;display:flex;',
    '  align-items:center;justify-content:center;padding:18px}',
    '#radar .hsheet .card{background:var(--rpanel);border:1px solid var(--rline);border-radius:12px;',
    '  padding:16px;max-width:640px;width:100%;max-height:86vh;overflow:auto;display:flex;',
    '  flex-direction:column;gap:10px}',
    '#radar .hsheet h4{margin:0;font:600 13px var(--rsans);color:var(--rink)}',
    '#radar .hsheet textarea{width:100%;min-height:180px;background:#0b0e13;color:var(--rink);',
    '  border:1px solid var(--rline);border-radius:8px;padding:8px 10px;font:12px var(--rmono)}',
    '#radar .hsheet .meta{color:var(--rdim);font-size:11px;font-family:var(--rmono);overflow-wrap:anywhere}',
    '#radar .hsheet .safety{color:var(--rmuted);font-size:11.5px;border-top:1px solid var(--rline);padding-top:8px}',
    '#radar .hsheet .btns{display:flex;gap:8px}',
    '#radar .hsheet button{background:none;border:1px solid #2a3646;color:var(--rink);border-radius:7px;',
    '  padding:6px 12px;font:12px var(--rmono);cursor:pointer}',
    '#radar .hsheet .err{color:var(--ralert);font-size:12px;font-family:var(--rmono);overflow-wrap:anywhere}',
    '#radar .recover{display:flex;align-items:center;gap:12px;border:1px solid var(--rline);',
    '  border-radius:9px;background:var(--rpanel);padding:11px 14px;color:var(--rink);',
    '  font-family:var(--rsans);font-size:13.5px;flex-wrap:wrap}',
    '#radar .recover button{background:none;border:1px solid #2a3646;color:var(--rink);border-radius:7px;',
    '  padding:5px 12px;font:12px var(--rmono);cursor:pointer}',

    // popovers — read-only for runbook/context; the only inputs are the tag/flag/decide writes
    '#radar .rpop{position:fixed;z-index:40;background:var(--rpanel);border:1px solid var(--rline);',
    '  border-radius:10px;padding:12px;min-width:260px;max-width:min(420px,92vw);max-height:70vh;overflow:auto;',
    '  box-shadow:0 14px 34px rgba(0,0,0,.6)}',
    '#radar .rpop[hidden]{display:none}',
    '#radar .rpop h4{margin:0 0 8px;font:600 13px var(--rsans);color:var(--rink)}',
    '#radar .rpop dl{margin:0;font-size:12px}',
    '#radar .rpop dt{color:var(--rdim);margin-top:7px}',
    '#radar .rpop dd{margin:2px 0 0;color:var(--rink);overflow-wrap:anywhere}',
    '#radar .rpop .ro{margin-top:10px;color:var(--rdim);font-size:11px;border-top:1px solid var(--rline);padding-top:8px}',
    '#radar .rpop input{width:100%;background:#0b0e13;color:var(--rink);border:1px solid var(--rline);',
    '  border-radius:8px;padding:8px 10px;font:14px var(--rmono);margin-top:6px}',
    '#radar .rpop input:focus{outline:none;border-color:#2a3646}',
    '#radar .rpop .btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
    '#radar .rpop button{background:none;border:1px solid #2a3646;color:var(--rink);border-radius:7px;',
    '  padding:6px 12px;font:12px var(--rmono);cursor:pointer}',
    '#radar .rpop button.on{border-color:#d7e2ee59}',
  ].join('\n');

  // ---- the pane ---------------------------------------------------------------------------------

  function create(deps) {
    var d = deps || {};
    var jget = d.jget;
    var jpost = d.jpost;
    var host = d.mount || document.body;
    var now = d.now || function () { return Date.now(); };

    // Style + DOM are built once, on create, and never touched again by anything outside this file.
    if (!document.getElementById('radar-style')) {
      var st = el('style'); st.id = 'radar-style'; st.textContent = CSS;
      document.head.appendChild(st);
    }

    var pane = el('div'); pane.id = 'radar';
    var surface = el('div', 'rsurface');
    var head = el('div', 'head');
    var scope = el('div', 'scope'); scope.setAttribute('aria-hidden', 'true');
    var wordmark = el('span', 't', 'RADAR');
    var headRight = el('span', 'right');
    // p6 select mode lives behind ONE toolbar control. It sits in a slot renderHead() empties on a
    // viewer (spec §3): an affordance whose only outcome is 409 viewer_readonly is itself a chore,
    // so it is not rendered at all rather than rendered disabled.
    var selSlot = el('span');
    var selBtn = el('button', 'selbtn', 'select');
    selBtn.type = 'button';
    selBtn.title = 'Select rows to hand off';
    var newDec = el('button', 'newdec', '+ decision');
    newDec.type = 'button';
    newDec.title = 'Open a decision item';
    head.append(scope, wordmark, headRight, selSlot, newDec);
    var badges = el('div', 'badges');
    // The recovery element (spec §M4/§7.2) renders in its OWN zone above the board — never a row,
    // never inside the attention list.
    var recoverZone = el('section');
    var nowZone = el('section');
    nowZone.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    var queueZone = el('section', 'queue');
    var foldsZone = el('div', 'folds');
    var selBar = el('div', 'selbar');
    surface.append(head, badges, recoverZone, nowZone, queueZone, foldsZone, selBar);
    var pop = el('div', 'rpop'); pop.hidden = true;
    var sheetHost = el('div');
    pane.append(surface, pop, sheetHost);
    host.appendChild(pane);

    // ---- state held by the tab
    var snapshot = null;              // the last SUCCESSFULLY fetched state.json (kept on failure)
    var net = { fail: null, failedAt: null, lastOkAt: null, auth: null, noSnapshot: false, everFetched: false };
    var chips = {};                   // itemKey -> { msg, at }  (inline mutation failures)
    var pending = {};                 // itemKey -> true         (a mutation is in flight)
    var optimistic = { removed: {}, flags: {}, added: [] };
    var timer = null;
    var open = false;

    // EVERY FOLD STARTS CLOSED. `moving` used to be the one exception, and on the real board that
    // meant 44 epic rows dumped onto the resting screen the moment the tab opened — the exact
    // "scan everything" clutter the v2 mockup was approved to kill. The board's job is to answer
    // "what needs me", and a moving epic by definition does not: it is moving.
    var folds = { moving: false, parked: false, worktrees: false, queue: false, dirty: false, drift: false };
    try {
      var saved = JSON.parse(localStorage.getItem(LS_FOLDS) || 'null');
      if (saved && typeof saved === 'object') {
        // ONE-TIME MIGRATION. A v1 blob persisted `moving: true` as a side effect of toggling some
        // OTHER fold, back when moving defaulted open — saveFolds() writes the whole object. That
        // stored `true` is indistinguishable from a real preference, so the one key whose default
        // changed is dropped exactly once. Every deliberate toggle after this sticks for good, and
        // no other fold's preference is touched.
        if (saved._v !== FOLD_PREF_V) delete saved.moving;
        Object.keys(folds).forEach(function (k) { if (typeof saved[k] === 'boolean') folds[k] = saved[k]; });
      }
    } catch (_) { /* a corrupt preference is not a reason to have no radar */ }
    function saveFolds() {
      try { localStorage.setItem(LS_FOLDS, JSON.stringify(Object.assign({ _v: FOLD_PREF_V }, folds))); } catch (_) {}
    }
    // Which orphan groups are open. Deliberately NOT persisted: expanding 131 spec folders is an
    // act of triage you perform now, not a preference you want restored tomorrow morning.
    var expanded = {};

    // ---- p6 state -------------------------------------------------------------------------------
    // A selection is COMPOSED, never presented (spec §2): sel.on is entered deliberately, and the
    // resting board carries none of it. sel.rows is the ordered registry of selectable rows,
    // rebuilt on every render — shift-click ranges walk it by index.
    var sel = { on: false, picked: {}, lastIdx: null };
    var selRows = [];
    // The confirm sheet's five-state machine (spec §7.2). null = no sheet.
    var sheet = null;
    var sheetDrawnFor = null;         // rebuild the sheet DOM only when its identity changes,
                                      // so a re-render never clobbers an in-progress seed edit
    // One press empties the recovery element (spec §M4): a token that answered 200 — or 409
    // not_recoverable, which means the set resolved itself — never renders again.
    var recoveryDone = {};
    var recoveryChip = null;

    // ---- attention, after optimistic edits ------------------------------------------------------
    // Optimism lives HERE rather than by mutating `snapshot`, so the next successful fetch replaces
    // the whole board with server truth and the optimistic layer simply stops applying. A revert is
    // then just "forget the local edit" — there is no half-written snapshot to repair.
    // Attention items are NOT guaranteed unique by their natural key. Observed on the real board:
    // two different vault projects each own a `p1-foundation` spec folder, and a spec-orphan item
    // carries only `specFolder` — so both rows produced the same identity, and optimistically
    // tagging one made BOTH vanish from the queue.
    //
    // Disambiguated positionally here rather than by changing the state contract: the suffix is
    // derived from the item's order in a stable, server-sorted array, so it survives re-renders
    // (which is what optimistic.removed and the chip map require) without inventing data. The
    // underlying collision is an S-009 issue and is reported, not papered over — tagging either row
    // still posts the same ambiguous specFolder.
    function withKeys(list) {
      var seen = {};
      var assign = function (it) {
        var k = itemKey(it);
        seen[k] = (seen[k] || 0) + 1;
        it.__key = seen[k] > 1 ? k + '#' + seen[k] : k;
      };
      list.forEach(function (it) {
        assign(it);
        // A group's MEMBERS are the things that get tagged, so they need stable keys too — the
        // optimistic layer and the chip map are both keyed on them. The duplicate-suffix counter is
        // shared with the top level so a member can never collide with a loose row of the same name.
        if (isGroup(it) && Array.isArray(it.items)) it.items.forEach(assign);
      });
      return list;
    }
    function attention() {
      var base = (snapshot && Array.isArray(snapshot.attention)) ? snapshot.attention : [];
      withKeys(base);
      return optimistic.added.concat(base.filter(function (it) { return !optimistic.removed[key(it)]; }));
    }
    // A group's live members, minus anything optimistically tagged away. A group whose last member
    // has just been tagged renders as an empty expansion rather than a stale count.
    function membersOf(it) {
      if (!isGroup(it) || !Array.isArray(it.items)) return [];
      return it.items.filter(function (m) { return !optimistic.removed[key(m)]; });
    }
    // Every consumer goes through this, never itemKey() directly, so a de-duplicated key can never
    // be bypassed by a caller that forgot.
    function key(it) { return it.__key || itemKey(it); }
    function ladderOf(e) {
      var l = Object.assign({}, e.ladder);
      var f = optimistic.flags[e.key];
      if (f) l.flags = (f === 'on' || f === 'n/a') ? 'done' : 'todo';
      return l;
    }

    // ---- fetch ----------------------------------------------------------------------------------
    // ONE fetch, of OUR OWN server, every 60s. On a viewer that same route is proxied to the leader
    // SERVER-SIDE (radar-server.js), which is why the browser never holds a leader credential and
    // never talks cross-origin. No backoff: a failure is retried on the ordinary tick, per §7.
    async function tick() {
      try {
        var r = await jget('/api/radar/state');
        if (r.status === 401) {
          net.auth = 'expired'; net.failedAt = now(); net.everFetched = true;
          return render();
        }
        net.auth = null;
        if (r.status === 503) {
          // "no snapshot yet" is NOT an empty board. Conflating them is the false-green the whole
          // spec is built to avoid, so it gets its own message.
          net.noSnapshot = true; net.fail = null; net.everFetched = true;
          return render();
        }
        if (!r.ok) {
          var msg = 'HTTP ' + r.status;
          try { var b = await r.json(); if (b && (b.message || b.error)) msg = b.message || b.error; } catch (_) {}
          net.fail = msg; net.failedAt = now(); net.everFetched = true;
          return render();
        }
        var s = await r.json();
        snapshot = s;
        net.fail = null; net.noSnapshot = false; net.lastOkAt = now(); net.everFetched = true;
        // Server truth has landed: local optimism and stale failure chips have served their purpose.
        optimistic = { removed: {}, flags: {}, added: [] };
        chips = {};
        render();
      } catch (e) {
        net.fail = (e && e.message) || 'fetch failed';
        net.failedAt = now(); net.everFetched = true;
        render();
      }
    }

    // ---- mutation contract ----------------------------------------------------------------------
    // ONE implementation for tag / decide / close / flag, because four hand-rolled ones is how three
    // of them end up without a revert path. apply() edits the optimistic layer and returns an undo;
    // a non-2xx or a thrown fetch runs the undo and pins an inline chip on the row that failed.
    async function mutate(itemK, apply, send) {
      if (pending[itemK]) return;
      pending[itemK] = true;
      delete chips[itemK];
      var undo = apply();
      render();
      try {
        var r = await send();
        if (!r || !r.ok) {
          var msg = r ? ('HTTP ' + r.status) : 'no response';
          try { var b = await r.json(); if (b && (b.message || b.error)) msg = b.message || b.error; } catch (_) {}
          throw new Error(msg);
        }
        delete pending[itemK];
        render();
        // Pull server truth promptly so the optimistic row is replaced by the real one rather than
        // sitting on a guess until the next minute boundary.
        setTimeout(function () { tick(); }, 400);
      } catch (e) {
        try { undo(); } catch (_) {}
        delete pending[itemK];
        chips[itemK] = { msg: (e && e.message) || 'failed', at: now() };
        render();
        setTimeout(function () {
          if (chips[itemK] && now() - chips[itemK].at >= CHIP_MS - 50) { delete chips[itemK]; render(); }
        }, CHIP_MS);
      }
    }

    function removeItem(key) {
      optimistic.removed[key] = true;
      return function () { delete optimistic.removed[key]; };
    }

    // ---- p6: selectors, suppression, the sheet and recovery (spec §6.1/§6.6/§7.2) ---------------

    // Must stay byte-equal to SAFETY_NOTICE in radar/handoff.js (S-007 owns the constant; the
    // p6 UI test compares the two, so the copy cannot drift silently). Spec §7.2 pins the constant
    // as the PLAIN TEXT of the sentence — 334 UTF-8 bytes, canonical copy at
    // _specs/p6-handoff/fixtures/s007-seed/SAFETY_NOTICE.txt: the spec's ** and backticks are its
    // own markdown emphasis, and literal asterisks would render as asterisks in this DOM.
    var SAFETY_NOTICE = 'The session is instructed to inspect and plan only on its first turn, ' +
      'and to ask before modifying, committing, pushing, merging or deleting anything. It runs ' +
      'without --dangerously-skip-permissions, so Claude\'s own permission prompts still apply ' +
      '— but your existing allowlists may already permit some commands. This is not a sandbox.';

    // §6.1 producer encoding, single pass over the original characters: % -> %25, : -> %3A.
    // A selector is a lock identity — this must match radar/handoff-keys.js::encodeSegment exactly.
    function encSeg(s) {
      var out = '';
      for (var i = 0; i < String(s).length; i++) {
        var ch = String(s)[i];
        out += ch === '%' ? '%25' : ch === ':' ? '%3A' : ch;
      }
      return out;
    }
    function uuid4() {
      try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (_) {}
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      });
    }

    // The fact keys a board row contributes, minted from the published snapshot exactly as
    // radar/handoff-keys.js mints them server-side (§6.2). The tab needs its own copy because the
    // board's worktree and epic rows are suppressed HERE — attention[] arrives pre-suppressed from
    // derive(), but repos/epics arrive intact (stop-capture and the lifecycle read them, so the
    // snapshot data itself must never be hollowed out).
    function dirtySum(w) {
      return w && w.dirty ? (w.dirty.staged || 0) + (w.dirty.unstaged || 0) + (w.dirty.untracked || 0) : 0;
    }
    function wtKeysOf(w) {
      var out = [];
      if (w.stale) out.push('wt:' + encSeg(w.path) + ':stale');
      if (dirtySum(w) > 0) out.push('wt:' + encSeg(w.path) + ':dirty');
      return out;
    }
    function epicKeysOf(e) {
      var out = [];
      var repos = (snapshot && snapshot.repos) || {};
      Object.keys(repos).forEach(function (repoId) {
        var r = repos[repoId];
        (r.branches || []).forEach(function (b) {
          if (b.epic !== e.key) return;
          if (typeof b.unpushed === 'number' && b.unpushed > 0) out.push('branch:' + encSeg(repoId) + ':' + encSeg(b.name) + ':unpushed');
          if (b.mergedIntoDevelop === false) out.push('branch:' + encSeg(repoId) + ':' + encSeg(b.name) + ':unmerged-develop');
          if (b.mergedIntoMain === false) out.push('branch:' + encSeg(repoId) + ':' + encSeg(b.name) + ':unmerged-main');
        });
        (r.worktrees || []).forEach(function (w) {
          // worktree -> epic goes through the BRANCH RECORD, never w.epic, which does not exist
          var hit = (r.branches || []).filter(function (b) { return b.name === w.branch; })[0];
          if (hit && hit.epic === e.key) out.push.apply(out, wtKeysOf(w));
        });
      });
      (e.signals || []).forEach(function (s) {
        if (s === 'merged-not-deployed' || s === 'deployed-flag-off') out.push('epic:' + encSeg(e.key) + ':' + s);
      });
      return out;
    }
    // The union of every live handoff's factKeys — §6.6's one suppression identity. Null when no
    // handoff is live, so the resting board takes the fast path.
    function coveredKeys() {
      var cov = null;
      ((snapshot && snapshot.handoffs) || []).forEach(function (h) {
        (h.factKeys || []).forEach(function (fk) { (cov = cov || {})[fk] = true; });
      });
      return cov;
    }
    // Removed iff it contributes AT LEAST ONE key and every one is covered — the non-empty
    // precondition is §9 trap 20: without it, one live handoff would hide every row.
    function rowSuppressed(keys, cov) {
      if (!cov || keys.length === 0) return false;
      return keys.every(function (fk) { return cov[fk]; });
    }

    // Row -> selector (§6.1's table). Returns null for a row that is not selectable — and a row
    // that is not selectable contributes no fact key and is never suppressed.
    function selectorsOfItem(it) {
      switch (it.type) {
        case 'mergeable': return { selectors: ['epic:' + encSeg(it.epic)], repos: (epicByKey(it.epic) || {}).repos || [] };
        case 'default-unpushed': return { selectors: ['branch:' + encSeg(it.repo) + ':' + encSeg(it.branch)], repos: [it.repo] };
        case 'orphan': return { selectors: ['orphan:' + encSeg(it.repo) + ':' + encSeg(it.branch)], repos: [it.repo] };
        case 'orphan-group': {
          var ss = [], rr = [];
          membersOf(it).forEach(function (m) { ss.push('orphan:' + encSeg(m.repo) + ':' + encSeg(m.branch)); rr.push(m.repo); });
          return ss.length ? { selectors: ss, repos: rr } : null;
        }
        default: return null;     // blocked, blocked-stale, decision, rule-violation, spec-orphan*
      }
    }

    function exitSelect() {
      sel = { on: false, picked: {}, lastIdx: null };
      sheet = null;
      // sheetDrawnFor keeps its last identity on purpose: renderSheet only clears the host on an
      // identity CHANGE, so resetting it here makes "no sheet" read as already-drawn and leaves
      // the last card attached over the board until a reload.
    }
    function pickedRows() {
      return Object.keys(sel.picked).map(function (k) { return sel.picked[k]; });
    }
    function currentSelectors() {
      var seen = {}, out = [];
      pickedRows().forEach(function (e) {
        e.selectors.forEach(function (s) { if (!seen[s]) { seen[s] = true; out.push(s); } });
      });
      return out;
    }
    function setPicked(row, on) {
      if (on) sel.picked[row.id] = row.entry;
      else delete sel.picked[row.id];
    }
    function toggleRowAt(idx, shiftKey) {
      var row = selRows[idx];
      if (!row) return;
      if (shiftKey && sel.lastIdx != null && selRows[sel.lastIdx]) {
        var lo = Math.min(sel.lastIdx, idx), hi = Math.max(sel.lastIdx, idx);
        for (var i = lo; i <= hi; i++) setPicked(selRows[i], true);
      } else {
        setPicked(row, !sel.picked[row.id]);
      }
      sel.lastIdx = idx;
      render();
    }
    // Registers a selectable row and, in select mode, prepends its checkbox. The registry is the
    // shift-click range order, so it is rebuilt in render order on every pass.
    function selRow(rowEl, entry, label) {
      if (!sel.on || !entry) return;
      var id = entry.selectors.join(',');
      var idx = selRows.length;
      selRows.push({ id: id, entry: entry });
      var box = el('input', 'selbox');
      box.type = 'checkbox';
      box.checked = !!sel.picked[id];
      box.setAttribute('aria-label', 'select ' + label);
      box.onclick = function (ev) { toggleRowAt(idx, !!(ev && ev.shiftKey)); };
      rowEl.insertBefore ? rowEl.insertBefore(box, rowEl.firstChild) : rowEl.append(box);
      // `space` toggles (spec §7.2) — the row answers it as well as the box, so a focused row
      // needs no pointer.
      rowEl.onkeydown = function (ev) {
        if (ev && (ev.key === ' ' || ev.key === 'Space')) { if (ev.preventDefault) ev.preventDefault(); toggleRowAt(idx, !!ev.shiftKey); }
      };
    }

    function renderSelBar() {
      clear(selBar);
      selBar.hidden = !sel.on;
      if (!sel.on) return;
      var rows = pickedRows();
      var repos = {};
      rows.forEach(function (e) { (e.repos || []).forEach(function (r) { repos[r] = true; }); });
      var label = rows.length + ' selected';
      var repoList = Object.keys(repos).sort().join(' ');
      selBar.append(el('span', null, label + (repoList ? ' · ' + repoList : '')));
      var go = el('button', null, 'hand off');
      go.type = 'button';
      go.disabled = rows.length === 0;
      go.onclick = function () { postPreview(currentSelectors(), undefined); };
      var cancel = el('button', null, 'cancel');
      cancel.type = 'button';
      cancel.onclick = function () { exitSelect(); render(); };
      selBar.append(go, cancel);
    }

    // ---- the confirm sheet (spec §7.2's five-state machine; `selecting` is sel.on itself) -------
    async function postPreview(selectors, seedOverride) {
      if (!selectors.length) return;
      sheet = { state: 'previewing', selectors: selectors, seedOverride: seedOverride };
      render();
      try {
        var body = seedOverride === undefined ? { selectors: selectors } : { selectors: selectors, seedOverride: seedOverride };
        var r = await jpost('/api/radar/handoff/preview', body);
        var b = null;
        try { b = await r.json(); } catch (_) { b = null; }
        if (r.ok && b && b.plan) {
          // The idempotency key is minted once per DISPLAYED plan and reused for every submit of
          // it (§7.1); an edit re-previews, which mints a new plan and therefore a new key.
          sheet = { state: 'ready', selectors: selectors, plan: b.plan, hash: b.hash, idemKey: uuid4() };
        } else {
          sheet = { state: 'failed', selectors: selectors, from: 'preview', err: errOf(r, b) };
        }
      } catch (e) {
        sheet = { state: 'failed', selectors: selectors, from: 'preview', err: { transport: true, message: (e && e.message) || 'network error' } };
      }
      render();
    }
    function errOf(r, b) {
      return {
        status: r ? r.status : 0,
        error: (b && b.error) || ('HTTP ' + (r ? r.status : '?')),
        message: (b && b.message) || '',
        incidentId: (b && b.incidentId) || null,
      };
    }
    async function postCommit() {
      var s = sheet;
      var body = { previewId: s.plan.previewId, hash: s.hash, idempotencyKey: s.idemKey };
      sheet = { state: 'committing', selectors: s.selectors, plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: body };
      render();
      try {
        var r = await jpost('/api/radar/handoff', body);
        var b = null;
        try { b = await r.json(); } catch (_) { b = null; }
        if (r.ok) {
          // 201, 202 and 200-resumed all close the sheet the same way: the dispatch is owned by
          // the server now, and the next poll redraws the board (suppression included).
          exitSelect();
          render();
          setTimeout(function () { tick(); }, 400);
          return;
        }
        sheet = { state: 'failed', selectors: s.selectors, from: 'commit', plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: body, err: errOf(r, b) };
      } catch (e) {
        sheet = { state: 'failed', selectors: s.selectors, from: 'commit', plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: body, err: { transport: true, message: (e && e.message) || 'network error' } };
      }
      render();
    }
    async function retrySheet() {
      var s = sheet;
      if (s.from === 'commit' && (s.err.transport || (s.err.status === 409 && s.err.error === 'in_flight'))) {
        // Same request, SAME idempotency key — the claim protocol makes the re-send safe.
        sheet = { state: 'committing', selectors: s.selectors, plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: s.body };
        render();
        try {
          var r = await jpost('/api/radar/handoff', s.body);
          var b = null;
          try { b = await r.json(); } catch (_) { b = null; }
          if (r.ok) { exitSelect(); render(); setTimeout(function () { tick(); }, 400); return; }
          sheet = { state: 'failed', selectors: s.selectors, from: 'commit', plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: s.body, err: errOf(r, b) };
        } catch (e) {
          sheet = { state: 'failed', selectors: s.selectors, from: 'commit', plan: s.plan, hash: s.hash, idemKey: s.idemKey, body: s.body, err: { transport: true, message: (e && e.message) || 'network error' } };
        }
        render();
        return;
      }
      // A settled failure spends the key (§M2): re-preview with the selection the sheet still
      // holds, minting a new plan and a new key. A failed preview re-previews the same way.
      postPreview(s.selectors, s.seedOverride);
    }

    function renderSheet() {
      var idFor = sheet
        ? sheet.state + ':' + (sheet.plan ? sheet.plan.previewId : '') + ':' + (sheet.err ? sheet.err.error + (sheet.err.incidentId || '') : '')
        : null;
      if (idFor === sheetDrawnFor) return;
      sheetDrawnFor = idFor;
      clear(sheetHost);
      if (!sheet || sheet.state === 'selecting') return;
      var wrap = el('div', 'hsheet');
      var card = el('div', 'card');
      wrap.appendChild(card);
      if (sheet.state === 'previewing' || sheet.state === 'committing') {
        card.append(el('h4', null, sheet.state === 'previewing' ? 'building the brief…' : 'dispatching…'));
      } else if (sheet.state === 'ready') {
        card.append(el('h4', null, 'Hand off'));
        // The EXACT seed text, editable. Editing and blurring re-previews with seedOverride —
        // editing by itself never confirms.
        var ta = el('textarea');
        ta.value = sheet.plan.seedText;
        ta.setAttribute('aria-label', 'seed text');
        ta.onblur = function () {
          if (sheet && sheet.state === 'ready' && ta.value !== sheet.plan.seedText) {
            postPreview(sheet.selectors, ta.value);
          }
        };
        card.append(ta);
        card.append(el('div', 'meta', 'preview ' + sheet.plan.previewId));
        card.append(el('div', 'meta', 'workdir ' + sheet.plan.workdir));
        card.append(el('div', 'meta', 'argv ' + JSON.stringify(sheet.plan.argv)));
        card.append(el('div', 'safety', SAFETY_NOTICE));
        var btns = el('div', 'btns');
        var ok = el('button', null, 'confirm'); ok.type = 'button';
        ok.onclick = function () { postCommit(); };
        var no = el('button', null, 'cancel'); no.type = 'button';
        no.onclick = function () { exitSelect(); render(); };
        btns.append(ok, no);
        card.append(btns);
      } else if (sheet.state === 'failed') {
        card.append(el('h4', null, 'Hand off failed'));
        // One incident, never a list (spec §7.3): the server's code and sentence verbatim, the
        // incidentId as an opaque token to quote, and exactly one remedy control.
        card.append(el('div', 'err', sheet.err.error));
        if (sheet.err.message) card.append(el('div', 'err', sheet.err.message));
        if (sheet.err.incidentId) card.append(el('div', 'meta', sheet.err.incidentId));
        var b2 = el('div', 'btns');
        var retry = el('button', null, 'retry'); retry.type = 'button';
        retry.onclick = function () { retrySheet(); };
        var no2 = el('button', null, 'cancel'); no2.type = 'button';
        no2.onclick = function () { exitSelect(); render(); };
        b2.append(retry, no2);
        card.append(b2);
      }
      sheetHost.appendChild(wrap);
    }

    // ---- the recovery element (spec §M4, §7.2) --------------------------------------------------
    // Rendered iff state.handoffRecovery !== null — a REQUIRED field, so an omitted key can never
    // render it. ONE element for the whole undecidable set: no id, no count, no per-item action,
    // and its text is byte-identical whether one handoff or ten are undecidable.
    async function recoveryPress(op, token) {
      try {
        var r = await jpost('/api/radar/recovery/' + op, { token: token });
        if (r.ok) { recoveryDone[token] = true; recoveryChip = null; render(); setTimeout(function () { tick(); }, 400); return; }
        var b = null;
        try { b = await r.json(); } catch (_) { b = null; }
        if (r.status === 409 && b && b.error === 'not_recoverable') {
          // Not an error to the user: the set resolved itself, so the element simply disappears.
          recoveryDone[token] = true; recoveryChip = null; render(); return;
        }
        // The only failure reachable after a press (500 ledger_write_failed) leaves the element
        // exactly as it was, showing the server's sentence — nothing was recorded, nothing killed.
        recoveryChip = (b && b.message) || ('HTTP ' + r.status);
        render();
      } catch (e) {
        recoveryChip = (e && e.message) || 'network error';
        render();
      }
    }
    function renderRecovery(t) {
      clear(recoverZone);
      var hr = snapshot && snapshot.handoffRecovery;
      if (!hr || recoveryDone[hr.token]) return;
      var box = el('div', 'recover');
      box.append(el('span', null, 'A handoff was dispatched ' + age(hr.since, t) + ' ago and never produced a transcript, but its process is still running.'));
      var adopt = el('button', null, 'adopt'); adopt.type = 'button';
      adopt.onclick = function () { recoveryPress('adopt', hr.token); };
      var discard = el('button', null, 'discard'); discard.type = 'button';
      discard.onclick = function () { recoveryPress('discard', hr.token); };
      box.append(adopt, discard);
      if (recoveryChip) box.append(el('div', 'chip', recoveryChip));
      recoverZone.appendChild(box);
    }

    // ---- popover ---------------------------------------------------------------------------------
    function closePop() { pop.hidden = true; clear(pop); }
    function openPop(anchor, build) {
      clear(pop);
      build(pop);
      pop.hidden = false;
      var r = anchor.getBoundingClientRect();
      var w = pop.offsetWidth || 280;
      var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      var top = r.bottom + 8;
      if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 8);
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      var first = pop.querySelector('input, button');
      if (first) try { first.focus(); } catch (_) {}
    }
    function defList(pairs) {
      var dl = el('dl');
      pairs.forEach(function (p) {
        if (p[1] == null || p[1] === '') return;
        dl.append(el('dt', null, p[0]), el('dd', null, p[1]));
      });
      return dl;
    }

    // Read-only, and it says so. runbook/context are for reading the derivation, not acting on it.
    function readOnlyPop(title, pairs, note) {
      return function (root) {
        root.append(el('h4', null, title), defList(pairs));
        root.append(el('div', 'ro', note || 'read-only — radar derives this, it does not change it'));
        var btns = el('div', 'btns');
        var close = el('button', null, 'close'); close.type = 'button'; close.onclick = closePop;
        btns.append(close); root.append(btns);
      };
    }

    // ---- rendering --------------------------------------------------------------------------------

    function renderHead(t) {
      var machines = (snapshot && snapshot.machines) || [];
      var ok = machines.filter(function (m) { return m.bridge === 'ok'; }).length;
      var parts = [];
      parts.push('scan ' + (snapshot ? hhmm(snapshot.generatedAt) : '—'));
      if (machines.length) {
        parts.push(ok === machines.length
          ? (machines.length === 1 ? '1 machine ✓' : machines.length + ' machines ✓')
          : ok + '/' + machines.length + ' machines');
      }
      headRight.textContent = parts.join(' · ');

      // p6: the select affordance exists ONLY on a leader (spec §3). state.role is published by
      // the leader and rewritten to "viewer" by the viewer's own proxy, so this read is correct on
      // both machines. On a viewer the control is NOT rendered — not disabled, absent.
      clear(selSlot);
      var viewer = snapshot && snapshot.role === 'viewer';
      if (viewer) {
        if (sel.on) exitSelect();
      } else if (snapshot) {
        selBtn.textContent = sel.on ? 'done' : 'select';
        selBtn.onclick = function () {
          if (sel.on) exitSelect();
          else sel = { on: true, picked: {}, lastIdx: null };
          render();
        };
        selSlot.appendChild(selBtn);
      }
    }

    function badge(text, strongText, action) {
      var b = el('div', 'badge');
      b.append(document.createTextNode(text));
      if (strongText) b.append(el('b', null, strongText));
      if (action) {
        var btn = el('button', null, action.label); btn.type = 'button';
        btn.onclick = action.onClick; b.append(btn);
      }
      return b;
    }

    // Every badge the spec names, all NEUTRAL: machine offline, per-source stale/error,
    // snapshot age past 2x cadence, auth expiry, and the state-fetch-failure marker.
    function renderBadges(t) {
      clear(badges);

      if (net.auth === 'expired') {
        badges.appendChild(badge('auth expired — radar cannot read state', null, {
          label: 're-enter token',
          onClick: function () { if (d.promptToken) d.promptToken(); },
        }));
      }
      if (net.fail) {
        var since = net.lastOkAt ? Math.round((t - net.lastOkAt) / 60000) : null;
        badges.appendChild(badge(
          'state stale — fetch failed' + (since != null ? ' · ' + since + 'm' : '') + ' · ' + net.fail));
      }
      if (snapshot) {
        var cadenceMs = 10 * 60000;
        var snapAge = t - Date.parse(snapshot.generatedAt);
        if (isFinite(snapAge) && snapAge > STALE_MULT * cadenceMs) {
          badges.appendChild(badge('snapshot ', age(snapshot.generatedAt, t) + ' old'));
        }
        (snapshot.machines || []).forEach(function (m) {
          if (m.bridge === 'ok') return;
          badges.appendChild(badge(m.id + ' bridge ', m.bridge || 'unknown'));
        });
        var src = snapshot.sources || {};
        Object.keys(src).forEach(function (k) {
          var s = src[k];
          if (!s || s.status === 'ok' || s.status === 'disabled') return;
          var bd = badge(k + ' ', s.status);
          if (s.error) bd.title = s.error;
          badges.appendChild(bd);
        });
      }
    }

    // Hero + queue rows share this: one row of copy per attention type, no free text anywhere else.
    function describe(it, t) {
      switch (it.type) {
        case 'blocked':
        case 'blocked-stale': {
          // The wait clock lives on the SESSION (blockedSince), not on the attention item, so it is
          // looked up rather than assumed — an attention item that has outlived its session renders
          // without a wait time instead of inventing one.
          var s = sessionFor(it.sessionKey);
          var waited = s && s.blockedSince ? age(s.blockedSince, t) : null;
          var left = minsLeft(it.deadline, t);
          // "≈" is not decoration: cacheExpiresAt is last-submit + 60min, an approximation the spec
          // requires to be shown as one (§M2).
          var approx = s && s.cacheApprox ? '≈' : '';
          return {
            icon: '⏳',
            title: 'Answer the ' + sessionLabel(it, s) + ' session',
            // The short session id stays in the meta whenever it is not already the title — two
            // sessions in the same directory are indistinguishable without it.
            meta: [waited ? 'waiting ' + waited : null,
              s && s.notificationType ? s.notificationType : null,
              it.sessionKey ? it.sessionKey.machine : null,
              (it.sessionKey && sessionLabel(it, s) !== String(it.sessionKey.sessionId).slice(0, 8))
                ? String(it.sessionKey.sessionId).slice(0, 8) : null].filter(Boolean).join(' · '),
            // A countdown that has run out must say so. "dies in 0 min" reads like a rounding
            // artifact; "window has closed" is the actual fact, and it changes what you do next.
            urgent: left == null ? null : (left === 0 ? 'cache window has closed' : 'cache dies in ' + approx + left + ' min'),
            // Queue rows render `small`, not `meta`. Several sessions share one cwd, so the label
            // is the SAME words on every row ("Answer the workspace session") — without the short id
            // here the rows are literally indistinguishable and you cannot tell which one you
            // already dealt with. A stale row also says so, since it no longer carries a countdown.
            small: [it.sessionKey ? it.sessionKey.machine : null,
              it.sessionKey ? String(it.sessionKey.sessionId).slice(0, 8) : null,
              it.type === 'blocked-stale' ? 'window closed' : null].filter(Boolean).join(' · '),
            act: 'jump',
          };
        }
        case 'rule-violation':
          return { icon: '⚠', title: it.repo + ' ' + it.env + ' — deployed SHA is off-branch',
            meta: it.note || '', small: it.env, act: 'context' };
        case 'decision': {
          var dn = days(it.since, t);
          return { icon: '◆', title: 'Decide: ' + (it.title || it.id),
            meta: dn == null ? 'no deadline' : 'day ' + dn, small: dn == null ? 'no deadline' : 'day ' + dn, act: 'decide' };
        }
        case 'mergeable':
          return { icon: '⇡', title: 'Merge ' + it.epic + ' into develop',
            meta: it.note || 'pushed, not on develop', small: it.note || 'runbook', act: 'runbook' };
        case 'orphan':
          return { icon: '?', title: 'Tag orphan branch ' + it.branch, meta: it.repo, small: it.repo, act: 'tag' };
        case 'spec-orphan':
          return { icon: '?', title: 'Tag orphan spec ' + it.specFolder, meta: 'spec vault', small: 'spec', act: 'tag' };
        // ONE ROW, WHATEVER THE COUNT. 131 unmapped spec folders is one job — "triage the spec
        // vault" — not 131 decisions, and rendering it as 131 near-identical rows turned the queue
        // into a grinding list. The count stays honest and the row expands; nothing is hidden.
        case 'orphan-group': {
          var nb = membersOf(it).length;
          return { icon: '?', title: 'Triage ' + nb + ' untagged branch' + (nb === 1 ? '' : 'es'),
            meta: 'no epic maps to them', small: 'branches', act: 'expand' };
        }
        case 'spec-orphan-group': {
          var ns = membersOf(it).length;
          return { icon: '?', title: 'Triage ' + ns + ' untagged spec folder' + (ns === 1 ? '' : 's'),
            meta: 'spec vault', small: 'specs', act: 'expand' };
        }
        default:
          return { icon: '·', title: it.type, meta: '', small: '', act: null };
      }
    }

    // The action button for an item, wherever it appears. `jump` is the ONLY green control.
    function actionButton(it, t, hero) {
      var itemK = key(it);
      var kinds = (it.actions || []).map(function (a) { return a.kind; });

      if (it.type === 'blocked' || it.type === 'blocked-stale') {
        var jumpAct = (it.actions || []).filter(function (a) { return a.kind === 'jump'; })[0];
        // surface:null upstream means radar could not identify the tab. No button — a Jump that
        // cannot land is worse than no Jump, because you only find out after the context switch.
        // But it says WHY, because "which of N tabs is blocked" is the question this pane exists
        // to answer, and "cannot tell, there are 4" is a real answer where "unknown" is not.
        if (!jumpAct) return el('span', 'nojump', nojumpText(it));
        var jb = el('button', hero ? 'jump' : 'q-act', hero ? 'Jump ↵' : 'jump');
        jb.type = 'button';
        jb.onclick = function () {
          try {
            var m = jumpAct.machine;
            var res = d.onJump ? d.onJump({ machine: m, tabUuid: jumpAct.tabUuid, tabRef: jumpAct.tabRef, peerUrl: peerUrlFor(m) }) : null;
            if (res && res.ok === false) { chips[itemK] = { msg: res.reason || 'cannot reach that tab', at: now() }; render(); }
          } catch (e) { chips[itemK] = { msg: (e && e.message) || 'jump failed', at: now() }; render(); }
        };
        return jb;
      }

      var b = el('button', 'q-act');
      b.type = 'button';
      b.disabled = !!pending[itemK];

      if (isGroup(it)) {
        b.textContent = expanded[itemK] ? 'collapse' : 'expand';
        b.dataset.role = 'group-toggle';
        b.onclick = function () { expanded[itemK] = !expanded[itemK]; render(); };
        return b;
      }

      if (it.type === 'decision' && kinds.indexOf('close') !== -1) {
        b.textContent = 'decide';
        b.onclick = function () {
          openPop(b, function (root) {
            root.append(el('h4', null, it.title || it.id));
            root.append(defList([
              ['id', it.id], ['epic', it.epic || '—'],
              ['open since', it.since ? it.since.slice(0, 10) : '—'],
              ['context', it.context || null],
            ]));
            var btns = el('div', 'btns');
            var done = el('button', 'on', 'mark decided'); done.type = 'button';
            done.onclick = function () {
              closePop();
              mutate(itemK, function () { return removeItem(itemK); },
                function () { return jpost('/api/radar/decisions/' + encodeURIComponent(it.id) + '/close', {}); });
            };
            var cancel = el('button', null, 'cancel'); cancel.type = 'button'; cancel.onclick = closePop;
            btns.append(done, cancel); root.append(btns);
          });
        };
        return b;
      }

      if (it.type === 'orphan' || it.type === 'spec-orphan') {
        b.textContent = 'tag';
        b.onclick = function () {
          openPop(b, function (root) {
            root.append(el('h4', null, it.type === 'orphan' ? 'Tag ' + it.repo + ':' + it.branch : 'Tag ' + it.specFolder));
            var input = el('input');
            input.type = 'text';
            input.placeholder = 'epic key, e.g. PROJ-108';
            input.setAttribute('list', 'radar-epics');
            input.setAttribute('aria-label', 'epic key');
            root.append(input, epicDatalist());
            var btns = el('div', 'btns');
            var go = el('button', 'on', 'tag'); go.type = 'button';
            go.onclick = function () {
              var epic = (input.value || '').trim();
              if (!epic) { input.focus(); return; }
              closePop();
              mutate(itemK, function () { return removeItem(itemK); }, function () {
                return it.type === 'orphan'
                  ? jpost('/api/radar/tag', { kind: 'branch', repo: it.repo, branch: it.branch, epic: epic })
                  : jpost('/api/radar/tag', { kind: 'spec', specFolder: it.specFolder, epic: epic });
              });
            };
            input.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); go.click(); } };
            var cancel = el('button', null, 'cancel'); cancel.type = 'button'; cancel.onclick = closePop;
            btns.append(go, cancel); root.append(btns);
          });
        };
        return b;
      }

      if (it.type === 'mergeable') {
        b.textContent = 'runbook';
        b.onclick = function () {
          var e = epicByKey(it.epic);
          openPop(b, readOnlyPop('Merge ' + it.epic, [
            ['why', 'every branch is pushed; none are on develop yet'],
            ['repos', e ? (e.repos || []).join(', ') : null],
            ['phrase', e ? e.phrase : null],
            ['note', it.note],
            ['order', 'merge --no-ff per repo, in the repo order above'],
          ], 'read-only — radar never merges, pushes or deploys'));
        };
        return b;
      }

      b.textContent = 'context';
      b.onclick = function () {
        openPop(b, readOnlyPop((it.repo || '') + ' ' + (it.env || ''), [
          ['what', it.note || 'deployed SHA is not an ancestor of the target branch'],
          ['repo', it.repo], ['env', it.env],
          ['deployed sha', deployedSha(it.repo, it.env)],
        ], 'read-only — radar never deploys or rolls back'));
      };
      return b;
    }

    function deployedSha(repo, env) {
      var r = snapshot && snapshot.repos && snapshot.repos[repo];
      var e = r && r.deploy && r.deploy[env];
      return e && e.sha ? String(e.sha).slice(0, 10) : null;
    }
    // What do you CALL a blocked session that radar could not map to an epic?
    //
    // On the real board this is the common case, not the edge case: hook events arrive without a
    // usable cwd, so repo and epic are both null and the hero read "Answer the cccea42e session" —
    // a hex prefix, on the one row that is supposed to tell you where to go, next to no Jump button
    // because the surface is unknown too. Useless.
    //
    // Claude Code encodes the session's project directory in transcriptPath
    // (~/.claude/projects/-Users-you-code-workspace/<uuid>.jsonl), so the name is recoverable even
    // when the mapping is not. Falls back through epic -> repo -> project dir -> uuid prefix, and
    // never invents one: the uuid prefix is still there when nothing else is.
    function sessionLabel(it, s) {
      if (it.epic) return it.epic;
      if (s && s.repo) return s.repo;
      var tp = s && s.transcriptPath;
      if (tp) {
        var m = String(tp).match(/\/projects\/([^/]+)\//);
        if (m && m[1]) {
          var dir = m[1].replace(/^-/, '').split('-').filter(Boolean).pop();
          if (dir) return dir;
        }
      }
      return (it.sessionKey && String(it.sessionKey.sessionId).slice(0, 8)) || 'blocked';
    }

    // The reason travels on the attention item (derive copies it there), with the session as a
    // fallback for a snapshot whose items predate that. `ambiguous-tabs:<n>` carries its count in
    // the token, which is the single most useful thing this line can say.
    function nojumpText(it) {
      var s = sessionFor(it.sessionKey);
      var r = it.surfaceReason || (s && s.surfaceReason) || null;
      var m = /^ambiguous-tabs:(\d+)$/.exec(r || '');
      if (m) return m[1] + ' tabs in that workspace — cannot tell which';
      return NOJUMP_TEXT[r] || 'no tab — surface unknown';
    }

    function sessionFor(key) {
      if (!key) return null;
      return ((snapshot && snapshot.sessions) || []).filter(function (s) {
        return s.key && s.key.machine === key.machine && s.key.sessionId === key.sessionId;
      })[0] || null;
    }
    function epicByKey(k) {
      return ((snapshot && snapshot.epics) || []).filter(function (e) { return e.key === k; })[0] || null;
    }
    function peerUrlFor(machineId) {
      var m = ((snapshot && snapshot.machines) || []).filter(function (x) { return x.id === machineId; })[0];
      // Not in the v1 state contract; read defensively so a later collector can supply it without
      // a UI change. Absent -> the host decides (it can usually switch machines in place).
      return (m && (m.peerUrl || m.webUrl)) || null;
    }
    function epicDatalist() {
      var dl = el('datalist'); dl.id = 'radar-epics';
      ((snapshot && snapshot.epics) || []).forEach(function (e) {
        var o = el('option'); o.value = e.key; dl.appendChild(o);
      });
      return dl;
    }

    function renderHero(t) {
      clear(nowZone);
      var items = attention();

      if (!items.length) {
        var quiet = el('div', 'quiet');
        var sc = el('div', 'scope'); sc.setAttribute('aria-hidden', 'true');
        quiet.append(sc);
        if (net.noSnapshot) {
          quiet.append(el('div', 'big', 'no snapshot yet'));
          quiet.append(el('div', 'sub', 'radar has not published a scan on this machine yet'));
        } else if (!snapshot) {
          quiet.append(el('div', 'big', net.everFetched ? 'radar unavailable' : 'loading…'));
          quiet.append(el('div', 'sub', net.fail || net.auth || 'reading /api/radar/state'));
        } else {
          quiet.append(el('div', 'big', 'all quiet'));
          quiet.append(el('div', 'sub', 'nothing is waiting on you'));
        }
        nowZone.appendChild(quiet);
        return;
      }

      var it = items[0];
      var info = describe(it, t);
      nowZone.appendChild(el('span', 'now-label', 'NOW'));
      var hero = el('div', 'hero');
      hero.append(el('span', 'hero-icon', info.icon));
      var main = el('div', 'hero-main');
      main.append(el('span', 'hero-title', info.title));
      var meta = el('span', 'hero-meta');
      if (info.meta) meta.append(document.createTextNode(info.meta));
      if (info.urgent) {
        if (info.meta) meta.append(document.createTextNode(' · '));
        meta.append(el('b', null, info.urgent));      // RED, and only ever for a deadline
      }
      main.append(meta);
      hero.append(main);
      hero.append(actionButton(it, t, true));
      selRow(hero, selectorsOfItem(it), info.title);
      nowZone.appendChild(hero);
      var itemK = key(it);
      if (chips[itemK]) nowZone.appendChild(el('div', 'chip', chips[itemK].msg));
      // A group can take the hero slot on a board with nothing more urgent on it. Expanding it
      // there has to work too, or the members would be unreachable from the one place they landed.
      if (isGroup(it) && expanded[itemK]) appendMembers(nowZone, it, t);
    }

    function queueRow(it, t, member) {
      var info = describe(it, t);
      var row = el('div', 'q-row' + (member ? ' member' : ''));
      row.dataset.key = key(it);
      row.append(el('span', 'q-icon', info.icon));
      var text = el('span', 'q-text', info.title);
      if (info.small) text.append(el('small', null, info.small));
      row.append(text);
      row.append(actionButton(it, t, false));
      // p6 select mode: selectable rows get a checkbox; the rest render exactly as they always did
      // and ignore selection entirely (spec §7.2 — blocked rows keep jump).
      selRow(row, selectorsOfItem(it), info.title);
      return row;
    }

    function appendMembers(host2, group, t) {
      var members = membersOf(group);
      if (!members.length) {
        host2.appendChild(el('div', 'q-empty', 'all tagged — this row clears on the next scan'));
        return;
      }
      members.forEach(function (m) {
        host2.appendChild(queueRow(m, t, true));
        var k = key(m);
        if (chips[k]) host2.appendChild(el('div', 'chip', chips[k].msg));
      });
    }

    function renderQueue(t) {
      clear(queueZone);
      var items = attention().slice(1);
      if (!items.length) return;
      var shown = folds.queue ? items : items.slice(0, QUEUE_MAX);
      shown.forEach(function (it) {
        queueZone.appendChild(queueRow(it, t));
        var k = key(it);
        if (chips[k]) queueZone.appendChild(el('div', 'chip', chips[k].msg));
        if (isGroup(it) && expanded[k]) appendMembers(queueZone, it, t);
      });
      if (items.length > QUEUE_MAX) {
        // The overflow is an EXPANDER, not a link to a second screen: at 125 spec-orphans the queue
        // must stay one short list by default and still be fully reachable in one tap.
        var more = el('button', 'q-more', folds.queue
          ? '− collapse'
          : '+' + (items.length - QUEUE_MAX) + ' more');
        more.type = 'button';
        more.dataset.role = 'queue-more';
        more.onclick = function () { folds.queue = !folds.queue; saveFolds(); render(); };
        queueZone.appendChild(more);
      }
    }

    // Why is this deploy cell hatched? The cell itself must stay one 16x14 rectangle — the mockup
    // was approved after an earlier version was rejected for clutter, so the answer goes in the
    // TOOLTIP, where it costs nothing until asked for. Every field here is optional and read
    // defensively: mod-deploy adds facts over time (branchMismatch, ageDays, deployAgeStale) and a
    // collector that has not caught up yet must not break a render.
    function deployReasons(e, env) {
      var out = [];
      (e.repos || []).forEach(function (repoId) {
        var r = snapshot && snapshot.repos && snapshot.repos[repoId];
        var d = r && r.deploy && r.deploy[env];
        if (!d) { out.push(repoId + ': no deploy probe configured'); return; }
        var bits = [];
        if (d.status && d.status !== 'ok') bits.push(d.status);
        if (d.branchMismatch === true) bits.push('probe answered a different branch');
        if (d.shaKnownLocally === false) bits.push('deployed sha not reachable locally');
        if (d.deployAgeStale === true) bits.push('deployed ' + (d.ageDays != null ? d.ageDays + 'd' : 'long') + ' ago');
        if (d.note) bits.push(d.note);
        if (d.error) bits.push(d.error);
        out.push(repoId + (bits.length ? ': ' + bits.join(' · ') : ': ok'));
      });
      return out;
    }

    function ladderStrip(e) {
      var l = ladderOf(e);
      var strip = el('span', 'ladder');
      LADDER.forEach(function (pair) {
        var k = pair[0], label = pair[1];
        var v = l[k] || 'unknown';
        var cls = 'step' + (v === 'done' ? ' done' : v === 'current' ? ' cur' : v === 'violation' ? ' bad' : v === 'unknown' ? ' unk' : '');
        var cell = el('span', cls);
        cell.title = label + ': ' + v;
        if (k === 'deployedDev' || k === 'prod') {
          var why = deployReasons(e, k === 'prod' ? 'prod' : 'dev');
          if (why.length) cell.title += '\n' + why.join('\n');
        }
        cell.setAttribute('aria-label', label + ' ' + v);
        cell.dataset.cell = k;
        cell.dataset.state = v;
        if (k === 'flags') {
          // The one ladder cell that is an ASSERTION rather than an observation, so it is the one
          // that can be edited — spec §2: radar never detects a flag, the operator asserts it.
          cell.classList.add('flagcell');
          cell.setAttribute('role', 'button');
          cell.title = 'flag: ' + v + (e.flag && e.flag.stale ? ' (asserted ' + e.flag.assertedAt + ' — re-assert?)' : '') + ' — click to assert';
          cell.onclick = function (ev) {
            ev.stopPropagation();
            openPop(cell, function (root) {
              root.append(el('h4', null, 'Flag for ' + e.key));
              root.append(el('div', 'ro', e.flag
                ? 'asserted ' + e.flag.state + ' on ' + (e.flag.assertedAt || '?') + (e.flag.stale ? ' — over 30 days ago' : '')
                : 'never asserted — radar cannot detect flag state'));
              var btns = el('div', 'btns');
              ['on', 'off', 'n/a'].forEach(function (s) {
                var b = el('button', e.flag && e.flag.state === s ? 'on' : null, s);
                b.type = 'button';
                b.onclick = function () {
                  closePop();
                  var fkey = 'flag:' + e.key;
                  mutate(fkey, function () {
                    var prev = optimistic.flags[e.key];
                    optimistic.flags[e.key] = s;
                    return function () { if (prev === undefined) delete optimistic.flags[e.key]; else optimistic.flags[e.key] = prev; };
                  }, function () { return jpost('/api/radar/flag', { epic: e.key, state: s }); });
                };
                btns.append(b);
              });
              root.append(btns);
            });
          };
        }
        strip.appendChild(cell);
      });
      return strip;
    }

    function epicRow(e, t, showLadder) {
      var row = el('div', 'er');
      row.dataset.epic = e.key;
      // An epic row selects the whole group as ONE epic: selector (spec §6.1's row->selector table)
      selRow(row, { selectors: ['epic:' + encSeg(e.key)], repos: e.repos || [] }, e.key);
      row.append(el('span', 'name', e.title ? e.key + ' ' + e.title : e.key));
      if (showLadder) row.append(ladderStrip(e));
      row.append(el('span', 'phrase', e.phrase || ''));
      var live = (e.signals || []).indexOf('session-live') !== -1 || (e.signals || []).indexOf('session-blocked') !== -1;
      var ageText = age(e.lastActivityAt, t);
      var when = el('span', 'when' + (live ? ' live' : ''), live ? '● live now' : ageText);
      if (!live && ageText === '—') when.title = 'no branch, commit or session activity — this epic is known only from Jira';
      row.append(when);
      var fkey = 'flag:' + e.key;
      if (chips[fkey]) row.append(el('div', 'chip', chips[fkey].msg));
      return row;
    }

    function foldSection(id, icon, label, count, peek, buildBody) {
      var openNow = !!folds[id];
      var wrap = el('div', openNow ? 'fold-open' : '');
      var headBtn = el('button', 'fold');
      headBtn.type = 'button';
      headBtn.dataset.fold = id;
      headBtn.setAttribute('aria-expanded', openNow ? 'true' : 'false');
      headBtn.append(el('span', 'caret', openNow ? '▾' : '▸'));
      headBtn.append(el('span', 'icon', icon));
      var lab = el('span');
      lab.append(el('span', 'n', String(count)));
      lab.append(document.createTextNode(' ' + label));
      headBtn.append(lab);
      headBtn.append(el('span', 'peek', openNow ? '' : (peek || '')));
      headBtn.onclick = function () { folds[id] = !folds[id]; saveFolds(); render(); };
      wrap.appendChild(headBtn);
      if (openNow) buildBody(wrap);
      return wrap;
    }

    function peekOf(list, n) {
      var names = list.slice(0, n).map(function (e) { return e.key; });
      if (list.length > n) names.push('+' + (list.length - n));
      return names.join(' · ');
    }

    function renderFolds(t) {
      clear(foldsZone);
      if (!snapshot) return;
      // p6 suppression of BOARD rows (spec §6.6): an epic or worktree row leaves while some live
      // handoff holds every fact key it contributes, and returns the moment that stops being true.
      // attention[] arrives pre-suppressed from derive(); the epic and worktree rows are suppressed
      // here because their snapshot DATA must stay intact for every other consumer.
      var cov = coveredKeys();
      var epics = (snapshot.epics || []).filter(function (e) { return !rowSuppressed(epicKeysOf(e), cov); });
      var active = epics.filter(function (e) { return e.zone === 'active'; });
      var dormant = epics.filter(function (e) { return e.zone === 'dormant'; });

      var stale = [];
      var dirty = [];
      Object.keys(snapshot.repos || {}).forEach(function (id) {
        (snapshot.repos[id].worktrees || []).forEach(function (w) {
          if (rowSuppressed(wtKeysOf(w), cov)) return;
          if (w.stale && w.cleanupCommand) stale.push({ repo: id, w: w });
          if (w.dirty && (w.dirty.staged || w.dirty.unstaged || w.dirty.untracked)) dirty.push({ repo: id, w: w });
        });
      });

      if (active.length) {
        foldsZone.appendChild(foldSection('moving', '●', 'moving', active.length, peekOf(active, 4), function (wrap) {
          active.forEach(function (e) { wrap.appendChild(epicRow(e, t, true)); });
          wrap.appendChild(el('div', 'ladder-key', 'bar = spec → pushed → merged → on dev → on prod → flag on   ·   filled = done, outlined = current, hatched = unknown'));
        }));
      }
      if (dormant.length) {
        foldsZone.appendChild(foldSection('parked', '🌙', 'parked', dormant.length, peekOf(dormant, 4), function (wrap) {
          dormant.forEach(function (e) { wrap.appendChild(epicRow(e, t, true)); });
        }));
      }
      // Jira drift. These epics are NOT work — Jira says in-flight, git says nothing exists, or the
      // reverse. They were deliberately removed from the board (a stale Jira status must not make an
      // epic permanently ACTIVE), but removed is not the same as unreachable: 34 rows visible only
      // in state.json is a digest nobody reads. One folded line, closed by default.
      var drift = snapshot.jiraDrift || [];
      if (drift.length) {
        foldsZone.appendChild(foldSection('drift', '📋', 'jira drift', drift.length,
          'status says one thing, git says another', function (wrap) {
            drift.forEach(function (d) {
              var row = el('div', 'wt');
              row.append(el('code', null, d.epic));
              row.append(el('span', 'why', d.note || d.direction || 'drift'));
              wrap.appendChild(row);
            });
          }));
      }
      if (stale.length || dirty.length) {
        foldsZone.appendChild(foldSection('worktrees', '🧹', 'worktrees to clean', stale.length,
          (stale.length ? 'commands ready' : 'none clean yet') + (dirty.length ? ' · ' + dirty.length + ' dirty' : ''),
          function (wrap) {
            stale.forEach(function (s) {
              var row = el('div', 'wt');
              // a worktree row selects wt:<path> (spec §6.1)
              selRow(row, { selectors: ['wt:' + encSeg(s.w.path)], repos: [s.repo] }, s.w.path);
              row.append(el('code', null, s.w.cleanupCommand));
              row.append(el('span', 'why', s.w.staleReason || 'stale'));
              var copy = el('button', 'q-act', 'copy'); copy.type = 'button';
              copy.onclick = function () {
                try {
                  navigator.clipboard.writeText(s.w.cleanupCommand);
                  copy.textContent = 'copied';
                  setTimeout(function () { copy.textContent = 'copy'; }, 1500);
                } catch (_) { copy.textContent = 'select it'; }
              };
              row.append(copy);
              wrap.appendChild(row);
            });
            // Dirty worktrees are NEVER cleanup-ready and never get a command — spec §M1. They are
            // a warning that live work is sitting there, which is the opposite of "safe to remove".
            //
            // ONE LINE, NOT NINETEEN. On the real board this printed 19 full absolute paths, none
            // of which offers an action — the fold's actionable content (the cleanup commands) was
            // pushed off the top by a wall of read-only text. It is now a count that expands, so
            // the fold opens on the four things you can actually run.
            if (dirty.length) {
              var sep = el('button', 'wt sub dirty-toggle');
              sep.type = 'button';
              sep.dataset.fold = 'dirty';
              sep.setAttribute('aria-expanded', folds.dirty ? 'true' : 'false');
              sep.append(el('span', 'caret', folds.dirty ? '▾' : '▸'));
              sep.append(el('code', null, dirty.length + ' worktree' + (dirty.length === 1 ? ' has' : 's have') + ' uncommitted work — not cleanup-ready, no command offered'));
              sep.onclick = function () { folds.dirty = !folds.dirty; saveFolds(); render(); };
              wrap.appendChild(sep);
              if (folds.dirty) {
                dirty.forEach(function (s) {
                  var row = el('div', 'wt dirty');
                  selRow(row, { selectors: ['wt:' + encSeg(s.w.path)], repos: [s.repo] }, s.w.path);
                  row.append(el('code', null, '⚠ ' + s.w.path));
                  row.append(el('span', 'why', s.w.branch || 'detached'));
                  wrap.appendChild(row);
                });
              }
            }
          }));
      }
    }

    function render() {
      var t = now();
      try {
        selRows = [];                 // the selectable-row registry is rebuilt in render order
        renderHead(t);
        renderBadges(t);
        renderRecovery(t);
        renderHero(t);
        renderQueue(t);
        renderFolds(t);
        renderSelBar();
        renderSheet();
      } catch (e) {
        // A render bug must degrade to "radar looks broken", never to a broken cmux. The pane keeps
        // whatever it managed to paint and says so.
        try {
          clear(nowZone);
          nowZone.appendChild(el('div', 'chip', 'radar render failed: ' + ((e && e.message) || e)));
        } catch (_) {}
        if (window.console) console.error('radar render failed', e);
      }
    }

    // ---- new decision (the fourth mutation) --------------------------------------------------------
    // The mockup has no control for OPENING a decision — it only shows existing ones — but §7 puts
    // `decide` under the same optimistic/revert contract as the others, so it needs a real caller.
    // One 11px chip in the head is the smallest honest home for it.
    newDec.onclick = function () {
      openPop(newDec, function (root) {
        root.append(el('h4', null, 'Open a decision'));
        var title = el('input'); title.type = 'text'; title.placeholder = 'what has to be decided';
        title.setAttribute('aria-label', 'decision title');
        var epic = el('input'); epic.type = 'text'; epic.placeholder = 'epic (optional)';
        epic.setAttribute('list', 'radar-epics'); epic.setAttribute('aria-label', 'decision epic');
        root.append(title, epic, epicDatalist());
        var btns = el('div', 'btns');
        var go = el('button', 'on', 'open'); go.type = 'button';
        go.onclick = function () {
          var text = (title.value || '').trim();
          if (!text) { title.focus(); return; }
          var e = (epic.value || '').trim();
          closePop();
          var newKey = 'newdec:' + text;
          mutate(newKey, function () {
            var ghost = { type: 'decision', id: newKey, title: text, epic: e || null, since: new Date(now()).toISOString(), actions: [{ kind: 'context' }, { kind: 'close' }] };
            optimistic.added.unshift(ghost);
            return function () { optimistic.added = optimistic.added.filter(function (x) { return x !== ghost; }); };
          }, function () { return jpost('/api/radar/decide', e ? { title: text, epic: e } : { title: text }); });
        };
        title.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); go.click(); } };
        var cancel = el('button', null, 'cancel'); cancel.type = 'button'; cancel.onclick = closePop;
        btns.append(go, cancel); root.append(btns);
      });
    };

    // dismiss a popover on any click outside it
    document.addEventListener('pointerdown', function (ev) {
      if (pop.hidden) return;
      if (pop.contains(ev.target)) return;
      closePop();
    }, true);

    // ---- lifecycle ---------------------------------------------------------------------------------
    function openPane() {
      if (open) return;
      open = true;
      document.body.classList.add('mode-radar');
      render();
      tick();
      if (!timer) timer = setInterval(function () { if (!document.hidden) tick(); }, POLL_MS);
    }
    function closePane() {
      open = false;
      document.body.classList.remove('mode-radar');
      closePop();
      if (timer) { clearInterval(timer); timer = null; }
    }

    var api = {
      open: openPane,
      close: closePane,
      isOpen: function () { return open; },
      // The same function the 60s timer calls. Reachable so a console (or a browser test) can force
      // the refresh the timer would otherwise perform a minute from now.
      refresh: tick,
      el: pane,
    };
    window.cmuxRadar.instance = api;
    return api;
  }

  window.cmuxRadar = { create: create, instance: null, QUEUE_MAX: QUEUE_MAX, POLL_MS: POLL_MS };
})();
