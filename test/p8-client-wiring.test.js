// p8 STORY-007 — the wiring: public/app.js + public/index.html (specs.md §4, §5.3, §6.3, §6.6, §7).
//
// public/app.js is a 3000-line browser IIFE with no dual export: it cannot be required, and loading
// it needs a document. So the proof here is not "call the app and watch" — it is EXTRACT AND RUN.
// Each test lifts the exact shipped source text of one function out of public/app.js, feeds it to
// `new Function` with fakes bound to the seams that function names, and then exercises it. Two
// consequences worth stating, because they are what make this a measurement rather than a grep:
//
//   * The assertions run the SHIPPED bytes. A regex over the file passes against the same string
//     sitting in a comment, in a neighbouring function, or in dead code; evaluating the extracted
//     function cannot — it either behaves or it does not.
//   * A bad extraction cannot pass silently. Every chunk goes through `new Function`, which throws
//     on unbalanced or malformed text, so an extractor bug is a red test.
//
// Where a claim genuinely has no runtime (script tag ordering, the mount element's attributes) the
// assertion is structural and says so.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---- extraction ------------------------------------------------------------------------------
// A brace matcher that knows about comments and string literals, because app.js is full of both and
// a naive counter would stop at the `{` inside a comment. Division vs regex is not disambiguated —
// none of the extracted functions contain a regex literal, and any mistake surfaces as a parse
// failure in `new Function`, never as a quiet pass.
function matchBrace(src, open) {
  assert.equal(src[open], '{', 'matchBrace must start on a {');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces from offset ' + open);
}

// The full source text of a top-level `function NAME(...) { ... }`, signature included.
function fnSrc(name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(APP);
  assert.ok(m, 'public/app.js must declare function ' + name);
  const open = APP.indexOf('{', m.index + m[0].length - 1);
  return APP.slice(m.index, matchBrace(APP, open) + 1);
}

// The `try { … } catch (…) { … }` that encloses a marker — used for the defensive mount block.
function tryCatchAround(marker) {
  const at = APP.indexOf(marker);
  assert.ok(at > 0, 'public/app.js must contain ' + JSON.stringify(marker));
  const start = APP.lastIndexOf('try {', at);
  assert.ok(start > 0, 'the marker must sit inside a try block');
  const tryEnd = matchBrace(APP, APP.indexOf('{', start));
  const catchAt = APP.indexOf('catch', tryEnd);
  assert.ok(catchAt > 0 && catchAt - tryEnd < 12, 'the try block must be followed immediately by catch');
  return APP.slice(start, matchBrace(APP, APP.indexOf('{', catchAt)) + 1);
}

// Prose is not code. Assertions about what the source does NOT do run against a comment-free copy,
// or a comment saying "never a toast" would fail a test forbidding toasts.
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n < 0) break; i = n - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    out += c;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === '\\') { out += src[++i]; continue; }
        if (src[i] === c) break;
      }
    }
  }
  return out;
}

const jgetSrc = (() => {
  const m = /^[ \t]*const jget = .*$/m.exec(APP);
  assert.ok(m, 'public/app.js must declare const jget');
  return m[0];
})();

// ---- Group A: jget learns {signal} (§5.3) ------------------------------------------------------
// Without this the model's AbortController aborts a token object while the HTTP request — and the
// git children behind it — run to completion. "The abort is real" is the whole claim.

function buildJget(onFetch) {
  const fn = new Function(
    'fetch', 'noCacheUrl', 'authHeaders',
    jgetSrc + '\nreturn jget;',
  );
  return fn(onFetch, (u) => u + '?_=nocache', (h) => Object.assign({ Authorization: 'Bearer T' }, h));
}

test('A1 jget forwards the caller\'s signal to fetch — the same object, not a copy', () => {
  let init = null;
  const jget = buildJget((u, i) => { init = i; return 'RES'; });
  const ctrl = new AbortController();
  const out = jget('/api/cmux/gitread/probe', { signal: ctrl.signal });
  assert.equal(out, 'RES');
  assert.equal(init.signal, ctrl.signal, 'jget must pass the very signal it was handed');
});

test('A2 the forwarded signal stays live — aborting it is observable through what fetch received', () => {
  let init = null;
  const jget = buildJget((u, i) => { init = i; });
  const ctrl = new AbortController();
  jget('/x', { signal: ctrl.signal });
  assert.equal(init.signal.aborted, false);
  ctrl.abort();
  assert.equal(init.signal.aborted, true, 'a token object would never flip');
});

test('A3 every existing one-argument caller is untouched: no throw, and signal is simply absent', () => {
  let init = null;
  const jget = buildJget((u, i) => { init = i; });
  jget('/api/cmux/fs/roots');
  assert.equal(init.signal, undefined, 'a bare url must not fabricate a signal');
});

test('A4 auth, credentials and cache are byte-identical with and without opts', () => {
  const seen = [];
  const jget = buildJget((u, i) => { seen.push(i); });
  jget('/same');
  jget('/same', { signal: new AbortController().signal });
  for (const i of seen) {
    assert.equal(i.credentials, 'same-origin');
    assert.equal(i.cache, 'no-store');
    assert.equal(i.headers.Authorization, 'Bearer T');
    assert.equal(i.headers['cache-control'], 'no-cache');
  }
});

test('A5 the url still goes through noCacheUrl on both call shapes', () => {
  const urls = [];
  const jget = buildJget((u) => { urls.push(u); });
  jget('/a');
  jget('/b', { signal: null });
  assert.deepEqual(urls, ['/a?_=nocache', '/b?_=nocache']);
});

test('A6 no falsy opts can produce a non-signal `signal` — RequestInit.signal is nullable, not any', () => {
  // fetch converts `signal` to AbortSignal? — `null` and `undefined` are legal, `0` and `''` throw a
  // TypeError out of fetch itself. gitbar's no-AbortController fallback really does publish
  // {signal: null} (gitbar.js:90), so falsy signals reach this helper on old browsers.
  let init = null;
  const jget = buildJget((u, i) => { init = i; });
  for (const bad of [null, undefined, 0, '', 'signal', 7, { signal: null }, { signal: 0 }]) {
    jget('/x', bad);
    assert.equal(init.signal, undefined, 'falsy opts/signal must normalise to undefined, saw ' + String(init.signal));
  }
});

// ---- Group B: leaveFiles reaches selectTab (§6.3) ----------------------------------------------
// The polling-resume trap. exitFilesMode() drops the body classes and sets tabType — it never calls
// selectTab, so nothing resumes polling after setFilesMode's teardownPanes(). A bar that leaves
// Files through it hands the operator a DEAD terminal after a fill.

function buildLeaveFiles(state) {
  const calls = { selectTab: [], exitFilesMode: 0, renderTabs: 0, enterDir: [], openFiles: 0, findTab: [] };
  const fn = new Function(
    'state', 'findTab', 'selectTab', 'exitFilesMode', 'renderTabs', 'lastPath', 'enterDir', 'openFiles',
    fnSrc('leaveFiles') + '\n' + fnSrc('toggleFiles') + '\nreturn leaveFiles;',
  );
  const leaveFiles = fn(
    state,
    (id) => { calls.findTab.push(id); return state.tabs.includes(id) ? { id } : null; },
    (id) => { calls.selectTab.push(id); },
    () => { calls.exitFilesMode++; },
    () => { calls.renderTabs++; },
    () => '/somewhere',
    (p) => { calls.enterDir.push(p); },
    () => { calls.openFiles++; },
  );
  return { leaveFiles, calls };
}

test('B1 from Files with a live tab: selectTab runs, and exitFilesMode never does', () => {
  const { leaveFiles, calls } = buildLeaveFiles({ tabType: 'files', tab: { id: 't9' }, tabs: ['t9'] });
  leaveFiles();
  assert.deepEqual(calls.selectTab, ['t9'], 'the terminal must be re-selected so polling resumes');
  assert.equal(calls.exitFilesMode, 0, 'exitFilesMode alone would leave a frozen mirror');
});

test('B2 from the viewer with a live tab: same path — a fill can be generated with a file open', () => {
  const { leaveFiles, calls } = buildLeaveFiles({ tabType: 'viewer', tab: { id: 't1' }, tabs: ['t1'] });
  leaveFiles();
  assert.deepEqual(calls.selectTab, ['t1']);
  assert.equal(calls.exitFilesMode, 0);
});

test('B3 the tab is verified to still exist — a closed tab falls back, it is not selected blind', () => {
  const { leaveFiles, calls } = buildLeaveFiles({ tabType: 'files', tab: { id: 'gone' }, tabs: [] });
  leaveFiles();
  assert.deepEqual(calls.selectTab, [], 'selecting a tab that no longer exists is not a resume');
  assert.equal(calls.exitFilesMode, 1, 'with nothing to resume, leaving Files is the whole job');
  assert.equal(calls.renderTabs, 1);
});

test('B4 with no tab at all: leaves Files without re-entering it', () => {
  const { leaveFiles, calls } = buildLeaveFiles({ tabType: 'files', tab: null, tabs: [] });
  leaveFiles();
  assert.equal(calls.exitFilesMode, 1);
  assert.deepEqual(calls.enterDir, [], 'the OPEN branch of toggleFiles must be unreachable here');
  assert.equal(calls.openFiles, 0);
});

test('B5 called when Files is not up, it does nothing — it must never OPEN the explorer', () => {
  const { leaveFiles, calls } = buildLeaveFiles({ tabType: 'terminal', tab: { id: 't1' }, tabs: ['t1'] });
  leaveFiles();
  assert.deepEqual(calls.selectTab, []);
  assert.deepEqual(calls.enterDir, [], 'toggleFiles would resume the last path — the opposite of leaving');
  assert.equal(calls.openFiles, 0);
  assert.equal(calls.exitFilesMode, 0);
});

test('B6 leaveFiles names no exitFilesMode of its own — the one exit path lives in toggleFiles', () => {
  const src = fnSrc('leaveFiles');
  assert.equal(src.includes('exitFilesMode'), false,
    'a second copy of the exit branch is exactly how this drifts back into the trap');
  assert.ok(/\btoggleFiles\s*\(/.test(src), 'it must delegate to toggleFiles');
  assert.ok(/\bselectTab\s*\(/.test(fnSrc('toggleFiles')), 'and that path must reach selectTab');
});

// ---- Group C: the panel door (§6.6, v3.1) ------------------------------------------------------

function buildOpenPanel(opts) {
  const o = opts || {};
  const calls = { open: [], enterDir: [], openFiles: 0, teardownPanes: 0, exitFilesMode: 0, renderTabs: 0, errors: [] };
  const state = o.state || { files: { path: '/repo/sub' }, machine: 'mac-1', browser: null, tabType: 'files' };
  const gitUI = ('gitUI' in o) ? o.gitUI : {
    open: (arg) => { calls.open.push(arg); if (o.throwOnOpen) throw new Error('boom'); },
  };
  // `console` is injected as well as `window.console`: the shipped line guards on window.console but
  // calls the bare global, which is the same object in a browser and is NOT inside a `new Function`.
  const fn = new Function(
    'gitUI', 'state', 'exitFilesMode', 'exitBrowserMode', 'exitRadarMode', 'teardownPanes',
    'setStatus', 'renderTabs', 'enterDir', 'openFiles', 'window', 'console',
    fnSrc('openPanel') + '\nreturn openPanel;',
  );
  const fakeConsole = { error: (...a) => calls.errors.push(a) };
  const openPanel = fn(
    gitUI, state,
    () => { calls.exitFilesMode++; }, () => {}, () => {}, () => { calls.teardownPanes++; },
    () => {}, () => { calls.renderTabs++; },
    (p) => { calls.enterDir.push(p); }, () => { calls.openFiles++; },
    { console: fakeConsole }, fakeConsole,
  );
  return { openPanel, calls, state };
}

test('C1 the panel binds to the identity it is HANDED — repo, name and src pass through untouched', () => {
  const { openPanel, calls, state } = buildOpenPanel();
  openPanel({ repo: '/real/toplevel', name: 'the-repo', src: 'read' });
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].repo, '/real/toplevel');
  assert.equal(calls.open[0].name, 'the-repo');
  assert.equal(calls.open[0].src, 'read');
  assert.equal(state.tabType, 'git');
});

test('C2 nothing about the repo is read from app state — a different browsed path cannot leak in', () => {
  const { openPanel, calls } = buildOpenPanel({
    state: { files: { path: '/some/other/dir' }, machine: 'm', browser: null, tabType: 'files' },
  });
  openPanel({ repo: '/probe/said/this', name: 'n', src: 'read' });
  assert.equal(calls.open[0].repo, '/probe/said/this');
});

test('C3 onClose is EXPLICIT on the bar door — never inherited from the toolbar door', () => {
  const { openPanel, calls } = buildOpenPanel();
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  assert.equal(typeof calls.open[0].onClose, 'function',
    'git.js:293 only replaces its stored callback when one is SUPPLIED');
});

test('C4 closing returns to the Files view of the directory the panel was opened from', () => {
  const { openPanel, calls, state } = buildOpenPanel();
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  state.files.path = null;                 // Files was torn down while the panel was up
  calls.open[0].onClose();
  assert.deepEqual(calls.enterDir, ['/repo/sub'], 'the directory is captured at open, not re-read at close');
  assert.equal(calls.openFiles, 0);
});

test('C5 opened with no browsed directory, close lands on the roots screen, not enterDir(undefined)', () => {
  const { openPanel, calls } = buildOpenPanel({
    state: { files: { path: null }, machine: 'm', browser: null, tabType: 'files' },
  });
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  calls.open[0].onClose();
  assert.deepEqual(calls.enterDir, []);
  assert.equal(calls.openFiles, 1);
});

test('C6 the panes are torn down before the panel opens — an overlay over a live mirror is not a state', () => {
  const { openPanel, calls } = buildOpenPanel();
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  assert.equal(calls.teardownPanes, 1);
  assert.equal(calls.exitFilesMode, 1);
});

test('C7 no repo, no door — the model must have resolved an identity first', () => {
  const { openPanel, calls } = buildOpenPanel();
  openPanel(null);
  openPanel({});
  openPanel({ name: 'n', src: 'read' });
  assert.deepEqual(calls.open, []);
});

test('C8 with no panel mounted (git.js absent) the door is a no-op, not a crash', () => {
  const { openPanel, calls } = buildOpenPanel({ gitUI: null });
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  assert.deepEqual(calls.enterDir, []);
  assert.equal(calls.renderTabs, 0);
});

test('C9 a panel that throws on open returns the operator to the LISTING, not to a blank screen', () => {
  // Restoring tabType alone is not a recovery: exitFilesMode() has already dropped the body classes,
  // so #files is display:none and the panes are gone. Only re-entering the directory repaints.
  const { openPanel, calls } = buildOpenPanel({ throwOnOpen: true });
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  assert.equal(calls.errors.length, 1);
  assert.deepEqual(calls.enterDir, ['/repo/sub'], 'the same recovery close() performs');
});

test('C10 a throwing panel with no browsed directory falls back to the roots screen', () => {
  const { openPanel, calls } = buildOpenPanel({
    throwOnOpen: true,
    state: { files: { path: null }, machine: 'm', browser: null, tabType: 'files' },
  });
  openPanel({ repo: '/r', name: 'n', src: 'read' });
  assert.equal(calls.openFiles, 1);
  assert.deepEqual(calls.enterDir, []);
});

test('C11 v3.1: EVERY gitUI.open call site in app.js supplies onClose', () => {
  const sites = [];
  for (let i = APP.indexOf('gitUI.open('); i >= 0; i = APP.indexOf('gitUI.open(', i + 1)) {
    const open = APP.indexOf('{', i);
    sites.push(APP.slice(open, matchBrace(APP, open) + 1));
  }
  assert.ok(sites.length >= 2, 'both doors — the toolbar door and the bar door — must be present');
  for (const s of sites) assert.ok(/onClose\s*:/.test(s), 'a door that omits onClose inherits the other door\'s: ' + s.slice(0, 60));
});

test('C12 STORY-010: the panel is handed the status-line seam, so its generated text can be marked', () => {
  // The panel closes the instant it fills, so its own body cannot carry a note the operator would
  // still be able to read (§7: the bar itself or the existing status line, never a toast). If
  // app.js stops supplying `note`, git.js falls back to its no-op default and the panel door
  // becomes the one p8 surface that hands over browsed text silently — no test of git.js alone can
  // see that, because git.js is correct either way.
  const i = APP.indexOf('window.cmuxGit.create(');
  assert.ok(i > 0, 'app.js must mount the panel');
  const open = APP.indexOf('{', i);
  const block = APP.slice(open, matchBrace(APP, open) + 1);
  const carriesNote = (s) => /note\s*:\s*\(msg\)\s*=>\s*setStatus\(/.test(s);
  assert.ok(carriesNote(block), 'the panel gets `note`, wired to the status line: ' + block);
  // Its own control, inline: the predicate must fail on a block that has lost the seam. A source
  // assertion whose regex can no longer miss is an assertion that has stopped asserting.
  const stripped = block.replace(/note\s*:\s*\(msg\)\s*=>\s*setStatus\([^\n]*\n/, '');
  assert.notStrictEqual(stripped, block, 'the mutation must actually change the block');
  assert.ok(!carriesNote(stripped), 'NEGATIVE CONTROL DID NOT BITE: the seam check passes without the seam');
  // And it is the SAME seam the bar gets — one status line, not two conventions.
  assert.ok(/note:\s*\(msg\)\s*=>\s*setStatus\(msg,\s*true,\s*6000\)/.test(APP),
    'both p8 doors emit through setStatus(msg, true, 6000)');
  assert.strictEqual((APP.match(/note:\s*\(msg\)\s*=>\s*setStatus\(msg,\s*true,\s*6000\)/g) || []).length, 2,
    'exactly two note seams: the panel door and the bar door');
});

// ---- Group D: the defensive mount (§4) ---------------------------------------------------------
// Run the real block. A source-control add-on degrades to no source control, never to no mirror.

function runMount(cmuxGitBar, extra) {
  const calls = { errors: [], status: [], model: null, view: null };
  const state = Object.assign({ machine: 'mac-1' }, (extra && extra.state) || {});
  const fn = new Function(
    'window', 'console', '$', 'document', 'jget', 'jpost', 'state', 'fillComposer', 'leaveFiles', 'openPanel', 'setStatus',
    'let gitBarModel = null, gitBarView = null;\n'
      + tryCatchAround('window.cmuxGitBar')
      + '\nreturn { gitBarModel, gitBarView };',
  );
  const fakeConsole = { error: (...a) => calls.errors.push(a) };
  const out = fn(
    { cmuxGitBar, console: fakeConsole }, fakeConsole,
    (id) => ({ id }),
    { MARKER: 'document' },
    function jget() {}, function jpost() {}, state,
    function fillComposer() {}, function leaveFiles() {}, function openPanel() {},
    (...a) => { calls.status.push(a); },
  );
  return { out, calls, state };
}

test('D1 gitbar.js absent (404 or stale shell): the handle stays null and nothing throws', () => {
  const { out, calls } = runMount(undefined);
  assert.equal(out.gitBarModel, null);
  assert.equal(out.gitBarView, null);
  assert.deepEqual(calls.errors, [], 'a missing add-on is not an error to log — it is the degraded path');
});

test('D2 a stale gitbar.js without the expected export is refused by the typeof guard', () => {
  const { out } = runMount({ createGitBarModel: 'not a function' });
  assert.equal(out.gitBarModel, null);
});

test('D3 createGitBarModel throwing leaves BOTH handles null and swallows the throw', () => {
  const { out, calls } = runMount({
    createGitBarModel: () => { throw new Error('bad'); },
    createGitBar: () => ({ destroy() {} }),
  });
  assert.equal(out.gitBarModel, null);
  assert.equal(out.gitBarView, null, 'a half-mounted bar is worse than none');
  assert.equal(calls.errors.length, 1);
});

test('D4 createGitBar throwing after a good model still leaves the model null — no half-mount', () => {
  const { out } = runMount({
    createGitBarModel: () => ({ at() {}, hide() {} }),
    createGitBar: () => { throw new Error('view blew up'); },
  });
  assert.equal(out.gitBarModel, null);
  assert.equal(out.gitBarView, null);
});

test('D5 on the good path the model gets exactly the §6.4 seams, and the view gets model/doc/mount', () => {
  let modelOpts = null, viewOpts = null;
  const { out } = runMount({
    createGitBarModel: (o) => { modelOpts = o; return { MODEL: 1 }; },
    createGitBar: (o) => { viewOpts = o; return { VIEW: 1 }; },
  });
  assert.deepEqual(out.gitBarModel, { MODEL: 1 });
  for (const k of ['jget', 'jpost', 'machine', 'nowMs', 'fillComposer', 'leaveFiles', 'openPanel', 'note']) {
    assert.ok(k in modelOpts, 'the model contract requires ' + k);
  }
  assert.equal(viewOpts.model, out.gitBarModel);
  assert.deepEqual(viewOpts.doc, { MARKER: 'document' });
  assert.deepEqual(viewOpts.mount, { id: 'gitbar' }, 'the view mounts into #gitbar');
});

test('D6 the machine seam is a FUNCTION over live state, not a value snapshotted at mount', () => {
  let modelOpts = null;
  const { state } = runMount({
    createGitBarModel: (o) => { modelOpts = o; return {}; },
    createGitBar: () => ({}),
  });
  assert.equal(typeof modelOpts.machine, 'function');
  assert.equal(modelOpts.machine(), 'mac-1');
  state.machine = 'mac-2';
  assert.equal(modelOpts.machine(), 'mac-2', 'a snapshot would keep probing the old machine after a switch');
});

test('D7 §7: the note seam renders through the existing #status line — never a toast', () => {
  let modelOpts = null;
  const { calls } = runMount({
    createGitBarModel: (o) => { modelOpts = o; return {}; },
    createGitBar: () => ({}),
  });
  modelOpts.note('source control: this repository left scope');
  assert.equal(calls.status.length, 1);
  assert.equal(calls.status[0][0], 'source control: this repository left scope');
  assert.equal(calls.status[0][1], true, 'a refusal reads as an error, not as a success pill');
  assert.ok(calls.status[0][2] > 0, 'nothing else repaints #status in Files mode, so it must self-clear');
  const code = stripComments(tryCatchAround('window.cmuxGitBar'));
  assert.equal(/toast/i.test(code), false, 'the note seam is #status and the bar, and nothing else');
  assert.ok(/setStatus\(/.test(code));
});

test('D8 nowMs is a real clock function — the TTL is measured, not faked to a constant', () => {
  let modelOpts = null;
  runMount({ createGitBarModel: (o) => { modelOpts = o; return {}; }, createGitBar: () => ({}) });
  assert.equal(typeof modelOpts.nowMs, 'function');
  const a = modelOpts.nowMs();
  assert.ok(typeof a === 'number' && a > 1e12, 'nowMs must return epoch ms');
});

// ---- Group E: at() / hide() call sites (§5.3) ---------------------------------------------------
// Structural, and body-scoped: the needle is looked for inside the extracted function only, so a
// match in a comment three functions away cannot satisfy it.

test('E1 enterDir calls at(path) — and does so AFTER the synchronous repaint and the listing fetch', () => {
  const src = fnSrc('enterDir');
  const at = src.indexOf('gitBarModel.at(');
  assert.ok(at > 0, 'enterDir must tell the bar where it is standing');
  assert.ok(at > src.indexOf('renderCrumb('), 'the crumb paints first');
  assert.ok(at > src.indexOf('loadPage('), 'the listing must never wait on git');
  assert.equal(/await[^\n]*gitBarModel/.test(src), false, 'the probe is fire-and-forget');
  assert.ok(/if \(gitBarModel\)/.test(src), 'guarded — a missing gitbar.js must not break navigation');
});

test('E2 openFiles hides the bar — the roots screen has no directory to be standing in', () => {
  const src = fnSrc('openFiles');
  assert.ok(src.includes('gitBarModel.hide()'));
  assert.ok(src.indexOf('gitBarModel.hide()') < src.indexOf('await'),
    'hide() must run before the roots fetch, or a pending probe can publish first');
});

test('E3 openFile hides the bar on the way into the viewer', () => {
  const src = fnSrc('openFile');
  assert.ok(src.includes('gitBarModel.hide()'));
  assert.ok(src.indexOf('gitBarModel.hide()') < src.indexOf('await'));
});

test('E4 leaving the viewer back to the listing re-shows the bar for that directory', () => {
  // This path repaints Files WITHOUT going through enterDir, so it needs its own at().
  const at = APP.indexOf("if (state.files.path) {");
  assert.ok(at > 0, 'the popstate viewer-back branch must still exist');
  const branch = APP.slice(at, matchBrace(APP, APP.indexOf('{', at)) + 1);
  assert.ok(/gitBarModel\.at\(state\.files\.path\)/.test(branch),
    'without this the bar stays hidden for the rest of the visit after opening one file');
});

test('E5 no call site reaches past the model into the view or the network', () => {
  for (const name of ['enterDir', 'openFiles', 'openFile', 'leaveFiles', 'openPanel']) {
    const src = fnSrc(name);
    assert.equal(/gitBarView\./.test(src), false, name + ' must not drive the view directly');
    assert.equal(/gitread/.test(src), false, name + ' must not build p8 URLs — the model owns the network');
  }
});

// ---- Group F: index.html (§4) -------------------------------------------------------------------

test('F1 exactly one gitbar.js script tag, and it is ordered before app.js', () => {
  const tags = HTML.match(/<script[^>]*src="\/gitbar\.js[^"]*"[^>]*><\/script>/g) || [];
  assert.equal(tags.length, 1, 'two tags would create two models racing over one mount');
  assert.ok(HTML.indexOf('/gitbar.js') < HTML.indexOf('/app.js'),
    'app.js reads window.cmuxGitBar at mount time');
});

test('F2 the tag is versioned like its neighbours, so an installed PWA shell picks up a new build', () => {
  const m = /<script[^>]*src="\/gitbar\.js\?v=([^"]+)"/.exec(HTML);
  assert.ok(m, 'the tag must carry a ?v= cache-buster');
  assert.ok(m[1].length > 3);
});

test('F3 the mount lives inside #files, between the crumb bar and the listing', () => {
  const files = HTML.indexOf('<div id="files">');
  const mount = HTML.indexOf('<div id="gitbar">');
  assert.ok(files > 0 && mount > files, 'the bar belongs to the Files screen');
  assert.ok(mount < HTML.indexOf('<div id="flist">'), 'a bar under the scroll container is a bar nobody sees');
  assert.ok(mount > HTML.indexOf('<div id="fbar">'));
});

test('F4 the p4 trap: the mount carries no [hidden] attribute — hiding is EMPTINESS', () => {
  const m = /<div id="gitbar"[^>]*>/.exec(HTML);
  assert.ok(m);
  assert.equal(/\bhidden\b/.test(m[0]), false,
    'an explicit display outranks the UA [hidden] rule — .fvbtn.fvicon[hidden] is the scar from last time');
  // Measured, not inferred: `m[0]` stops at the `>`, so comparing it to the literal proves nothing
  // about what is INSIDE the element. The substring is the only thing that does.
  assert.ok(HTML.includes('<div id="gitbar"></div>'),
    'any whitespace inside the mount defeats :empty on first paint');
  assert.ok(/#gitbar:empty\s*\{[^}]*display:\s*none/.test(HTML), 'and :empty is what collapses it');
});

test('F5 an emptied mount paints nothing — no border or padding of its own to leave a ghost strip', () => {
  const m = /#gitbar\s*\{([^}]*)\}/.exec(HTML);
  assert.ok(m, '#gitbar must have a rule');
  for (const prop of ['border', 'padding', 'background', 'min-height', 'height']) {
    assert.equal(new RegExp('\\b' + prop).test(m[1]), false,
      '#gitbar must not declare ' + prop + ' — a count oracle passes against a stale attached bar, a pixel does not');
  }
  assert.ok(/\.gbrow[^{]*\{[^}]*border-bottom/.test(HTML), 'the rule belongs to the row, which only exists when visible');
});

test('F6 every class the view creates has a style — an unstyled bar is a broken bar', () => {
  const GITBAR = fs.readFileSync(path.join(__dirname, '..', 'public', 'gitbar.js'), 'utf8');
  const used = new Set();
  for (const m of GITBAR.matchAll(/'(gb[a-z]+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 8, 'expected the view to build at least eight class names, saw ' + used.size);
  for (const cls of used) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(HTML), 'public/index.html has no rule for .' + cls);
  }
});

test('F7 #status is reachable over the Files pane, which is where §7 renders reasons', () => {
  const m = /body\.mode-files #status[^{]*\{([^}]*)\}/.exec(HTML);
  assert.ok(m, 'the p4 lift must still be there');
  assert.ok(/z-index:\s*4/.test(m[1]), '#files sits at z-index 3; a status under it is feedback nobody sees');
});
