/* cmux-remote — the source-control bar in the file explorer (p8 STORY-006, specs.md §6.4).
 *
 * Dual-export, like menuparse.js: the browser gets `window.cmuxGitBar`, `node --test` gets
 * `module.exports`. Requiring this file touches no DOM and issues no network call — that is the
 * whole point of the split below.
 *
 * TWO OBJECTS, ONE OWNERSHIP RULE: **everything but pixels lives in the model.**
 *
 *   createGitBarModel({ jget, jpost, machine, nowMs, fillComposer, leaveFiles, openPanel, note })
 *     → { at, hide, scopeLost, destroy, current, subscribe, tapPull, tapPush, tapSync, tapPanel }
 *   createGitBar({ model, doc, mount }) → { destroy }
 *
 * Round 2 of the spec review found the alternative split unimplementable: the model was assigned
 * every tap-time guard while the seams those guards need (jpost, fillComposer, leaveFiles) were
 * injected into the DOM layer, whose public API could not reach them. So the model owns the cache,
 * the sequencing, the identity gate, the refusals and every action; the view has nothing left to
 * get wrong but rendering.
 *
 * The three properties this file exists to make provable without a browser:
 *
 *   1. THE DISPLAY CACHE IS DISPLAY-ONLY (§5.2, §5.4). It is keyed by the EXACT browsed directory
 *      — never by containment interval, which would make a descent into a nested child repo a hit
 *      on the parent's entry and name the WRONG repository. No action ever consumes it: every
 *      request carries the CURRENT browsed dir, and the server re-resolves identity at action time.
 *
 *   2. ONE PATH-IDENTITY GATE ON EVERY ACTION RESPONSE (§5.4), applied BEFORE any other field of
 *      that response is read. The bar showing repo A for directory D must not act on A when D now
 *      resolves to B. On mismatch: terminate the action (zero fills, zero opens, zero further
 *      action requests), evict D's cache entry, and re-render from ONE fresh cache-bypassing probe
 *      — the only response shape that carries the complete bar state {repo,name,branch,state}.
 *      The gate detects PATH-identity changes only; a repo replaced in place at the same canonical
 *      path is undetectable by any path comparison and is declared harmless, because every value an
 *      action acts on is derived server-side at action time and never from this display.
 *
 *   3. RESPONSES ARRIVE OUT OF ORDER AND MUST NEVER OVERWRITE A NEWER ONE (§5.3). Path comparison
 *      alone is NOT enough: in A1→B→A2 both A1 and A2 match the current path, and the older
 *      response can resurrect a branch from before a checkout. So: a generation counter, captured
 *      per request, plus a real abort — and hide()/destroy() are invalidating transitions that
 *      increment it too, because the generation predicate alone would happily accept a response
 *      pending across them (no newer at() exists).
 *
 * RENDERING SAFETY. Repo directory names and git ref names are attacker-influencable strings
 * entering a DOM inside the authenticated origin — refs legally contain `<`, `>`, quotes and
 * slashes; directory names legally contain everything but `/` and NUL. Every dynamic string in
 * this file reaches the document through `textContent` on an element built with
 * `doc.createElement`. There is no markup-parsing sink anywhere in this file, and its absence is
 * asserted over the source text itself in test/gitbar.test.js.
 *
 * §7 IN ONE LINE: every failure hides the bar. A git problem must not degrade browsing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cmuxGitBar = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const TTL_MS = 5000;                      // §5.2 display-cache TTL, measured on the injected clock
  const API = '/api/cmux/gitread/';         // p8's own routes; the p7 ⎇ door is never touched

  // STORY-010 (war-game M7b). The text this model fills is what the operator would have typed, and
  // running it inside a repo they did not author runs THAT REPO'S configured programs — hooks on
  // `commit`, `uploadpack` on `fetch`/`pull`, `receivepack` on `push`, `core.sshCommand` on an ssh
  // remote, `core.fsmonitor` on `pull --rebase`. All five measured. A visible `-c
  // core.hooksPath=/dev/null` in the templates closes exactly ONE of them, so it was rejected: the
  // text is never neutralised, and the boundary is MARKED instead.
  //
  // The string is a verbatim copy of gitread.js's BROWSED_TEXT_MARK, and a test asserts the two
  // agree byte for byte — the server is the single source of the wording, without this file taking
  // a runtime dependency on anything the browser might not have loaded.
  const BROWSED_TEXT_MARK =
    'browsed repo — running this text runs that repo\'s configured programs; the text shows the verb, not the hooks';

  // FAIL-CLOSED, and that direction is the decision: the mark is withheld ONLY on the exact string
  // `workspace`. Absent, null, misspelled or a value from some future server all mark — an unread
  // warning costs a line of status text, an unshown one costs the operator the only signal there is.
  // The mirror of §6.5's canWrite rule, which withholds a CONTROL on the exact string `false`; both
  // read the ambiguous case as the less dangerous action, which for a control is "remove it" and
  // for a warning is "show it".
  const marksAsBrowsed = function (body) {
    return !body || body.provenance !== 'workspace';
  };

  // ---- the model -------------------------------------------------------------------------------

  function createGitBarModel(opts) {
    const o = opts || {};
    const jget = o.jget;
    const jpost = o.jpost;
    const nowMs = typeof o.nowMs === 'function' ? o.nowMs : function () { return Date.now(); };
    const fillComposer = o.fillComposer;
    const leaveFiles = o.leaveFiles;
    const openPanel = o.openPanel;
    const emitNote = typeof o.note === 'function' ? o.note : function () {};
    // Same function-or-value shape git.js:72 accepts, so one app-level `machine` seam feeds both.
    const getMachine = function () {
      const m = (typeof o.machine === 'function' ? o.machine() : o.machine);
      return m || '';
    };

    const cache = new Map();                // dir -> { repo, name, branch, state, at }
    const subs = new Set();

    let gen = 0;                            // §5.3 generation counter
    let ctrl = newController();             // aborts with its generation
    let dir = null;                         // the CURRENT browsed directory — the only truth (§5.4)
    let shown = null;                       // the identity the bar DISPLAYS, or null when hidden
    let syncOpen = false;
    let noteText = null;
    let dead = false;

    function newController() {
      return (typeof AbortController === 'function') ? new AbortController() : { abort: function () {}, signal: null };
    }

    const url = function (sub, qs) {
      return API + sub + '?machine=' + encodeURIComponent(getMachine()) + (qs ? '&' + qs : '');
    };
    const dirQs = function (d) { return 'dir=' + encodeURIComponent(d); };

    async function readJson(r) {
      try { return await r.json(); } catch (_) { return null; }
    }

    // Every invalidating transition goes through here: at(), hide() and destroy() (§5.3). The
    // predecessor's controller is aborted so its HTTP request and the git children behind it stop,
    // not merely its publication.
    function invalidate() {
      gen += 1;
      try { ctrl.abort(); } catch (_) {}
      ctrl = newController();
      return gen;
    }

    function view() {
      if (!shown) return { visible: false };
      return {
        visible: true,
        repo: shown.repo,
        name: shown.name,
        branch: shown.branch,
        state: shown.state,
        note: noteText,
        syncOpen: syncOpen,
      };
    }

    function publish() {
      if (dead) return;
      const v = view();
      for (const fn of Array.from(subs)) { try { fn(v); } catch (_) {} }
    }

    // Reasons render through the injected #status seam AND ride the published state, per §7's
    // "the bar itself or the existing status line" — never a toast.
    function setNote(text) {
      noteText = text || null;
      if (text) { try { emitNote(text); } catch (_) {} }
    }

    function entryOf(body) {
      return { repo: body.repo, name: body.name, branch: body.branch, state: body.state, at: nowMs() };
    }

    function display(e) {
      shown = e ? { repo: e.repo, name: e.name, branch: e.branch, state: e.state } : null;
      publish();
    }

    function freshEntry(d) {
      const e = cache.get(d);
      if (!e) return null;
      if (nowMs() - e.at >= TTL_MS) { cache.delete(d); return null; }
      return e;
    }

    // ---- the probe ------------------------------------------------------------------------------
    // The one response shape carrying the complete bar state. Every refusal the server can make —
    // not a repo, out of read scope, jail, parse failure, git failure, admission overflow — is
    // deliberately indistinguishable here, so this function never asks WHY and never says why: it
    // hides. That indistinguishability is a security property; rendering a cause would rebuild the
    // existence oracle the server spent five review rounds removing.
    async function probeInto(d, g) {
      const signal = ctrl.signal;
      let r, body;
      try {
        r = await jget(url('probe', dirQs(d)), { signal: signal });
        body = await readJson(r);
      } catch (_) {
        if (g !== gen || dead) return null;      // superseded or torn down: publish nothing (§5.3)
        cache.delete(d);
        display(null);
        return null;
      }
      if (g !== gen || dead) return null;
      if (!r.ok || !body || !body.repo) {        // §7: hidden, silent — including 503 probe_busy
        cache.delete(d);
        display(null);
        return body;
      }
      const e = entryOf(body);
      cache.set(d, e);
      display(e);
      return body;
    }

    // ---- the path-identity gate (§5.4) ----------------------------------------------------------
    // Applied to EVERY action response BEFORE any other field of it is interpreted. `repo` is the
    // canonical toplevel the server resolved from the dir we just sent; anything that is not an
    // exact match to what the bar displays — a different toplevel, a null, an absent field on a
    // {error:…} body, any non-403 failure — is treated as "the identity behind this response is not
    // the one on screen", which is the only honest reading.
    function gateOf(r, body) {
      if (r.status === 403) return 'forbidden';
      if (!r.ok) return 'failed';
      if (!body || body.repo !== (shown && shown.repo)) return 'mismatch';
      return 'match';
    }

    // Mismatch and failure share ONE repair, and it is the §5.4 transition: terminate, evict, and
    // re-render from exactly one fresh cache-bypassing probe. A persistent problem hides the bar
    // through that probe's own {repo:null}; a transient one heals. Nothing here retries the action.
    function repair(reason) {
      const d = dir;
      const g = gen;
      cache.delete(d);
      shown = null;                              // identity unverified ⇒ nothing is displayed
      setNote(reason);
      publish();
      return probeInto(d, g);
    }

    // 403 means the repo left read scope. Hiding IS the rendering, and no probe is needed — the
    // probe would answer {repo:null} and hide it again (§5.4, §6).
    //
    // EVICTION, not merely hiding, is the load-bearing half. hide() deliberately keeps the display
    // cache — a bar hidden for the viewer may be re-shown for free on the way back (§5.2) — but a
    // REFUSED identity must never be re-shown for free: the very next at() on this directory would
    // be a cache hit and would repaint the bar, with no request to discover the refusal again.
    function evict() {
      cache.delete(dir);
      shown = null;
    }

    function forbidden(reason) {
      evict();
      setNote(reason);
      publish();
    }

    // ---- the sync guard, tap-time copy (§6.2) ---------------------------------------------------
    // The SAME predicate the server enforces at generation and the generated text enforces at
    // execution: unmerged > 0 ∨ MERGE_HEAD ∨ rebase-merge ∨ rebase-apply. `git add -A` with
    // unmerged paths marks conflicts RESOLVED — markers included — and the next commit ships
    // `<<<<<<<`. An unreadable status is a BLOCKED status, never a quiet pass.
    function blockedReasons(s) {
      if (!s || s.error || !s.counts || !s.inProgress) return ['state unreadable'];
      const out = [];
      if (Number(s.counts.unmerged) > 0) out.push('unmerged paths');
      if (s.inProgress.merge) out.push('merge in progress');
      if (s.inProgress.rebase) out.push('rebase in progress');
      return out;
    }

    // ---- actions --------------------------------------------------------------------------------
    // ALL of them send the CURRENT browsed dir, never a repo path from the cache (§5.4).

    async function postCommand(verb, params) {
      const g = gen;
      let r, body;
      try {
        r = await jpost(url('command'), { verb: verb, dir: dir, params: params || {} });
        body = await readJson(r);
      } catch (_) {
        if (g !== gen || dead) return;
        return repair('source control: request failed');
      }
      if (g !== gen || dead) return;
      const k = gateOf(r, body);
      if (k === 'forbidden') return forbidden('source control: this repository left scope');
      // 409 not_on_branch lands here: the bar's push/pull controls were stale, and the repair's
      // fresh probe is exactly the refresh that removes them.
      if (k === 'failed') return repair('source control: ' + ((body && body.error) || ('http ' + r.status)));
      if (k === 'mismatch') return repair('this directory now resolves to a different repository');
      if (!body.text) { setNote('could not build that command'); publish(); return; }
      const res = fillComposer ? fillComposer(body.text) : { ok: false, reason: 'no composer' };
      // A fill failure is a real state, not an exception: the composer's pane may be an altscreen
      // or a pager, or there may be no sticky surface at all on a cold load straight into Files.
      // Surface the reason and STAY in Files — leaving on a fill the user cannot see is a fill they
      // will repeat (git.js:287 does the same).
      if (res && res.ok === false) {
        setNote('nothing filled: ' + ((res && res.reason) || 'no pane'));
        publish();
        return;
      }
      syncOpen = false;
      // The marking, at the point the operator reads the text — AFTER the fill, so it is the last
      // thing written to the status line the fill itself writes to, and it survives leaveFiles()
      // because `note` is the app's status seam and not this bar's DOM. `body.text` was handed to
      // fillComposer above, untouched: the marking is presentation and never payload.
      setNote(marksAsBrowsed(body) ? BROWSED_TEXT_MARK : null);
      publish();
      if (leaveFiles) leaveFiles();
    }

    function tapPull() { return branchAction('pull-rebase'); }
    function tapPush() { return branchAction('push'); }

    // NO branch parameter is sent, ever. The server derives the ref from HEAD after authorization
    // and 409s on detached/unborn (§6.1) — a client-supplied branch is a client-supplied option.
    function branchAction(verb) {
      if (dead || !shown || !dir) return;
      if (shown.state !== 'branch') return;      // the control is not offered off a branch (§7)
      return postCommand(verb, {});
    }

    // tapSync() with NO argument toggles the commit row — `✓` opens it, `×` closes it. That is the
    // only setter the published `syncOpen` field can have: the contract publishes syncOpen, lists
    // no other method, and forbids logic in the view. tapSync(message) — any string — is the action.
    async function tapSync(message) {
      if (dead || !shown || !dir) return;
      if (typeof message === 'undefined') { syncOpen = !syncOpen; publish(); return; }
      const msg = String(message === null ? '' : message);
      // A courtesy check; the server re-performs it as 400 empty_message. No request is issued.
      if (!msg.trim()) { setNote('commit message is empty'); publish(); return; }
      const g = gen;
      let r, body;
      try {
        r = await jget(url('status', dirQs(dir)), { signal: ctrl.signal });
        body = await readJson(r);
      } catch (_) {
        if (g !== gen || dead) return;
        return repair('source control: status read failed');
      }
      if (g !== gen || dead) return;
      // The gate runs BEFORE the guard fields are read. A status naming a different repo must not
      // have its counts consulted at all — those counts describe a repository the operator is not
      // standing in, and a "clean" verdict from them would fill a commit for the wrong tree.
      const k = gateOf(r, body);
      if (k === 'forbidden') return forbidden('source control: this repository left scope');
      if (k === 'failed') return repair('source control: ' + ((body && body.error) || ('http ' + r.status)));
      if (k === 'mismatch') return repair('this directory now resolves to a different repository');
      const reasons = blockedReasons(body);
      if (reasons.length) { setNote('sync refused: ' + reasons.join(', ')); publish(); return; }
      return postCommand('sync', { message: msg });
    }

    // The panel door re-resolves like every other action, and its own fresh probe DOUBLES as the
    // render source on mismatch — so a mismatch here costs no second request (§5.4).
    async function tapPanel() {
      if (dead || !shown || !dir) return;
      const d = dir;
      const g = gen;
      let r, body;
      try {
        // Cache-bypassing by construction: no freshEntry() consultation on this path, warm or not.
        r = await jget(url('probe', dirQs(d)), { signal: ctrl.signal });
        body = await readJson(r);
      } catch (_) {
        if (g !== gen || dead) return;
        setNote('the panel could not open here');
        publish();
        return;
      }
      if (g !== gen || dead) return;
      // 503 probe_busy or any other failure: do not open, keep the bar, say so. Best-effort display
      // degrades to no panel, never to a panel opened on an unverified identity.
      if (!r.ok) {
        setNote('the panel could not open here (' + ((body && body.error) || ('http ' + r.status)) + ')');
        publish();
        return;
      }
      if (!body || body.repo !== shown.repo) {
        cache.delete(d);
        if (body && body.repo) { const e = entryOf(body); cache.set(d, e); shown = { repo: e.repo, name: e.name, branch: e.branch, state: e.state }; }
        else { shown = null; }
        setNote('the panel did not open: this directory now resolves elsewhere');
        publish();
        return;
      }
      const e = entryOf(body);
      cache.set(d, e);
      setNote(null);
      // The RESPONSE's identity, never the display's — the panel binds to what the server resolved
      // NOW. This runs BEFORE the bar adopts the response, deliberately: once `shown` has been
      // updated the two are indistinguishable, and a door that read the display instead would be
      // unfalsifiable. Opening first keeps the property observable in a test.
      if (openPanel) openPanel({ repo: body.repo, name: body.name, src: 'read' });
      display(e);
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    function at(path) {
      if (dead) return;
      dir = path;
      syncOpen = false;
      noteText = null;
      const g = invalidate();
      const hit = freshEntry(path);
      if (hit) { display(hit); return; }       // a revisit within TTL is free
      display(null);                            // nothing is known about this directory yet
      return probeInto(path, g);                // fire-and-forget; the returned promise is for tests
    }

    function hide() {
      if (dead) return;
      invalidate();
      dir = null;
      shown = null;
      syncOpen = false;
      noteText = null;
      publish();
    }

    // §7, panel-initiated. The PANEL discovered the refusal (git.js fires onScopeLost on a bar-bound
    // status 403) and is leaving; the bar must leave with it. This is `forbidden` without a reason:
    // the bar was not the surface that learned it, and git.js deliberately renders no cause for a
    // scope decision, so neither does this. invalidate() is what stops a probe still in flight for
    // this directory from landing afterwards and putting the bar back.
    function scopeLost() {
      if (dead) return;
      invalidate();
      evict();
      syncOpen = false;                          // as hide() does — a stale draft must not reopen
      noteText = null;
      publish();
    }

    function destroy() {
      if (dead) return;
      invalidate();
      dead = true;
      dir = null;
      shown = null;
      subs.clear();                             // no later publication is observable
    }

    function current() {
      const v = view();
      return v;
    }

    function subscribe(fn) {
      if (typeof fn !== 'function' || dead) return function () {};
      subs.add(fn);
      try { fn(view()); } catch (_) {}
      return function () { subs.delete(fn); };
    }

    return { at, hide, scopeLost, destroy, current, subscribe, tapPull, tapPush, tapSync, tapPanel };
  }

  // ---- the view --------------------------------------------------------------------------------
  // THIN by contract: it subscribes, it builds elements, it wires taps to model.tap*(). No guards,
  // no network, no clock, no state beyond the in-progress commit message it must not lose across a
  // re-render. Every dynamic string below is set with textContent on a created element.

  function createGitBar(opts) {
    const o = opts || {};
    const model = o.model;
    const doc = o.doc;
    const mount = o.mount;
    let msgInput = null;

    const make = function (tag, cls, text) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };
    const button = function (label, title, onTap) {
      const b = make('button', 'gbbtn', label);
      b.type = 'button';
      if (title) b.title = title;
      b.onclick = onTap;
      return b;
    };
    const clear = function () {
      if (!mount) return;
      if (typeof mount.replaceChildren === 'function') { mount.replaceChildren(); return; }
      while (mount.firstChild) mount.removeChild(mount.firstChild);
    };

    function render(v) {
      // A publication mid-typing must not eat the draft commit message.
      const draft = msgInput ? msgInput.value : '';
      clear();
      msgInput = null;
      if (!v || !v.visible) return;             // §7: hidden means NOTHING of the bar is mounted

      const row = make('div', 'gbrow');
      row.appendChild(make('span', 'gbicon', '⎇'));
      row.appendChild(make('span', 'gbname', v.name == null ? '' : v.name));
      row.appendChild(make('span', 'gbsep', '·'));
      row.appendChild(make('span', 'gbbranch', v.state === 'detached' ? 'detached' : (v.branch == null ? '' : v.branch)));
      if (v.state === 'unborn') row.appendChild(make('span', 'gbstate', 'unborn'));

      if (v.state === 'branch') {
        row.appendChild(button('↓↻', 'pull --rebase', function () { model.tapPull(); }));
        row.appendChild(button('↑', 'push', function () { model.tapPush(); }));
      }
      row.appendChild(button('✓', 'commit everything', function () { model.tapSync(); }));
      row.appendChild(button('›', 'source control panel', function () { model.tapPanel(); }));
      mount.appendChild(row);

      if (v.syncOpen) {
        const sr = make('div', 'gbsync');
        const input = doc.createElement('input');
        input.type = 'text';
        input.className = 'gbmsg';
        input.placeholder = 'commit message';
        input.value = draft;
        msgInput = input;
        sr.appendChild(input);
        sr.appendChild(button('Commit', 'generate the commit command', function () { model.tapSync(msgInput ? msgInput.value : ''); }));
        sr.appendChild(button('×', 'close', function () { model.tapSync(); }));
        mount.appendChild(sr);
      }

      if (v.note) mount.appendChild(make('div', 'gbnote', v.note));
    }

    const off = model.subscribe(render);

    return {
      destroy: function () {
        if (typeof off === 'function') off();
        msgInput = null;
        clear();
      },
    };
  }

  // BROWSED_TEXT_MARK is exported so the wording can be asserted against gitread.js's copy rather
  // than re-typed in a test — a test carrying its own third spelling would pass while the two that
  // ship drifted apart.
  return { createGitBarModel, createGitBar, BROWSED_TEXT_MARK };
});
