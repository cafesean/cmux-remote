'use strict';
// p8 integration — the bar door hands the panel an onScopeLost, and losing scope takes the BAR with
// the panel (§7: "every failure hides the bar").
//
// STORY-008 gave public/git.js an `onScopeLost` option and fires it on a bar-bound status 403.
// STORY-007's public/app.js was written before that option existed, so the panel closed and the bar
// it was opened from survived — still offering pull/push/commit over a repository the read gate now
// refuses. Nothing in either story's own suite could see that: git.js's tests supply the callback
// themselves, and app.js's tests never reach the bar.
//
// So this file runs the three real modules together — public/gitbar.js required as-is, public/git.js
// evaluated in a vm on a DOM stand-in, and app.js's own `openPanel` extracted from source — and
// drives the whole journey: browse, tap ›, panel opens, status 403.
//
// Two oracle rules inherited from the stories this joins, and both matter here:
//   * A HIDDEN BAR IS ASSERTED AS TEXT ABSENT FROM THE LIVE MOUNT, never as a count of nodes or
//     controls. A count is satisfied by a bar left attached and merely emptied, and equally by one
//     that was re-rendered a tick later — which is exactly the failure this file exists to catch.
//   * EVERY ASSERTION HAS A NEGATIVE CONTROL at the bottom: the wiring is removed by a textual
//     mutation of the real app.js, the same journey is driven, and the oracle is required to throw.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const GIT_PATH = path.join(__dirname, '..', 'public', 'git.js');
const BAR_PATH = path.join(__dirname, '..', 'public', 'gitbar.js');
const APP = fs.readFileSync(APP_PATH, 'utf8');
const GIT_SRC = fs.readFileSync(GIT_PATH, 'utf8');
const BAR = require(BAR_PATH);

// ---- DOM stand-in ------------------------------------------------------------------------------
// The repo is dependency-free, so there is no jsdom to borrow. This implements exactly the surface
// git.js and gitbar.js's view consume between them, and nothing that parses markup beyond git.js's
// one fixed template — a view that reached for a markup sink would throw here rather than work.

function makeText(s) {
  return { _text: s, parentNode: null, childNodes: [], get textContent() { return this._text; } };
}

function makeNode(doc, tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attributes: {},
    style: {},
    hidden: false,
    disabled: false,
    title: '',
    type: '',
    _text: null,
    onclick: null,
    append(...kids) { for (const k of kids) this.appendChild(k); },
    appendChild(k) {
      if (k.parentNode) k.parentNode.removeChild(k);
      k.parentNode = this;
      this.childNodes.push(k);
      return k;
    },
    removeChild(k) {
      const i = this.childNodes.indexOf(k);
      if (i !== -1) { this.childNodes.splice(i, 1); k.parentNode = null; }
      return k;
    },
    replaceChildren(...kids) {
      for (const c of this.childNodes.slice()) c.parentNode = null;
      this.childNodes.length = 0;
      for (const k of kids) this.appendChild(k);
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    querySelector(sel) {
      const match = sel[0] === '.'
        ? (n) => String(n.className || '').split(/\s+/).indexOf(sel.slice(1)) !== -1
        : sel[0] === '#'
          ? (n) => n.attributes.id === sel.slice(1)
          : (n) => n.tagName === sel.toUpperCase();
      let found = null;
      const dive = (n) => {
        for (const c of n.childNodes) {
          if (found) return;
          if (!c.tagName) continue;
          if (match(c)) { found = c; return; }
          dive(c);
        }
      };
      dive(this);
      return found;
    },
    get firstChild() { return this.childNodes[0] || null; },
    get textContent() {
      if (this._text !== null) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes.length = 0;
      const t = makeText(String(v));
      t.parentNode = this;
      this.childNodes.push(t);
    },
    set innerHTML(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes.length = 0;
      for (const n of parseHtml(String(v), doc)) this.appendChild(n);
    },
  };
  node.classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    contains(c) { return this._set.has(c); },
  };
  let cls = '';
  Object.defineProperty(node, 'className', { get() { return cls; }, set(v) { cls = String(v); } });
  Object.defineProperty(node, 'id', {
    get() { return node.attributes.id || ''; },
    set(v) { node.attributes.id = String(v); },
  });
  return node;
}

function parseHtml(html, doc) {
  const roots = [];
  const stack = [];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  const put = (n) => {
    if (stack.length) stack[stack.length - 1].appendChild(n);
    else roots.push(n);
  };
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { stack.pop(); continue; }
    if (m[2]) {
      const node = doc.createElement(m[2]);
      const are = /([a-zA-Z-]+)="([^"]*)"/g;
      let a;
      while ((a = are.exec(m[3] || '')) !== null) {
        if (a[1] === 'class') node.className = a[2];
        else { node.setAttribute(a[1], a[2]); if (a[1] === 'type') node.type = a[2]; }
      }
      put(node);
      if (!m[4]) stack.push(node);
      continue;
    }
    if (m[5] !== undefined) put(makeText(m[5]));
  }
  return roots;
}

function makeDom() {
  const doc = {};
  Object.assign(doc, {
    createElement: (tag) => makeNode(doc, tag),
    createTextNode: (s) => makeText(s),
    addEventListener: () => {},
  });
  doc.head = makeNode(doc, 'head');
  doc.body = makeNode(doc, 'body');
  return { document: doc, window: { console }, node: (tag) => makeNode(doc, tag) };
}

// ---- source extraction -------------------------------------------------------------------------
// openPanel is run as the SHIPPED text, not a paraphrase: a paraphrase would keep passing after the
// real function lost the wiring, which is the whole defect this file guards.

function matchBrace(src, open) {
  assert.strictEqual(src[open], '{', 'matchBrace must start on a {');
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

function fnSrc(src, name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'public/app.js must declare function ' + name);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  return src.slice(m.index, matchBrace(src, open) + 1);
}

// Every `gitUI.open({...})` argument literal in app.js, in source order.
function openSites(src) {
  const out = [];
  for (let i = src.indexOf('gitUI.open('); i >= 0; i = src.indexOf('gitUI.open(', i + 1)) {
    const open = src.indexOf('{', i);
    out.push(src.slice(open, matchBrace(src, open) + 1));
  }
  return out;
}

function mutate(src, pairs) {
  let code = src;
  for (const [from, to] of pairs || []) {
    assert.ok(code.indexOf(from) !== -1, 'mutation anchor missing from public/app.js: ' + from);
    const next = code.replace(from, to);
    assert.notStrictEqual(next, code, 'a mutation must actually change the source: ' + from);
    code = next;
  }
  return code;
}

// ---- fixtures ----------------------------------------------------------------------------------

const DIR = '/w/alpha/src/lib';          // the browsed directory — deliberately NOT the toplevel
const REPO = '/w/alpha';
const NAME = 'alpha';
const PROBE = { repo: REPO, name: NAME, branch: 'main', state: 'branch' };

const ok = (json) => ({ status: 200, json });
const refuse = (status, json) => ({ status, json: json || { repo: null } });

// ---- the joined harness ------------------------------------------------------------------------

// gitbar.js is a UMD: unmutated it is simply required, and a mutated copy is evaluated in its own
// realm through the same module seam, so a control tests the REAL file with one thing removed.
function loadBar(mutations) {
  if (!mutations || !mutations.length) return BAR;
  const code = mutate(fs.readFileSync(BAR_PATH, 'utf8'), mutations);
  const ctx = { module: { exports: {} }, self: undefined, globalThis: undefined, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'public/gitbar.js' });
  const api = ctx.module.exports;
  assert.strictEqual(typeof api.createGitBarModel, 'function', 'the mutated copy must still load');
  return api;
}

function boot(opts) {
  const o = opts || {};
  const appSrc = mutate(APP, o.appMutations);
  const bar = loadBar(o.barMutations);
  const dom = makeDom();

  // The real panel, in its own realm on the stand-in DOM.
  const ctx = { window: dom.window, document: dom.document, console };
  vm.createContext(ctx);
  vm.runInContext(GIT_SRC, ctx, { filename: 'public/git.js' });
  assert.ok(ctx.window.cmuxGit && typeof ctx.window.cmuxGit.create === 'function');

  // ONE GATE, two expressions of its refusal — gitread.js's own rule 1: "authorizeRead() is the
  // single entry for the whole read/generate class". `status` refuses by throwing 403; `probe`
  // refuses by answering {repo:null} at 200, so it never becomes an existence oracle (gitread.js
  // §5.1). Modelling them as independent would be the fiction that lets a broken fix pass: the
  // re-probe after a scope loss would cheerfully re-admit the repo the panel was just refused.
  let gateOpen = true;
  const reqs = [];
  const routes = Object.assign({
    probe: () => (gateOpen ? ok(PROBE) : ok({ repo: null })),
    // The gate stops admitting this anchor mid-session, and the panel's status read is the request
    // that discovers it. Everything asked about the same anchor afterwards is refused too.
    status: () => { gateOpen = false; return refuse(403); },
  }, o.routes || {});
  const reply = (method, url, body) => {
    const kind = /\/gitread\/([a-z]+)/.exec(url);
    const key = kind ? kind[1] : (/\/git\/([a-z]+)/.exec(url) || [, 'other'])[1];
    reqs.push({ method, url, key });
    const h = routes[key];
    const out = h ? h(url, body, reqs) : refuse(404, { error: 'not_found' });
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => JSON.parse(JSON.stringify(out.json)),
    };
  };
  const jget = async (url) => reply('GET', url);
  const jpost = async (url, body) => reply('POST', url, body);

  const panelMount = dom.node('div');
  const gitUI = ctx.window.cmuxGit.create({
    mount: panelMount, jget, jpost, machine: 'm1',
    fillComposer: () => ({ ok: true }),
  });

  // openPanel is late-bound so the model can be built before the door that needs it.
  let openPanel = null;
  let clock = 1000;
  const notes = [];
  const gitBarModel = bar.createGitBarModel({
    jget, jpost, machine: 'm1', nowMs: () => clock,
    fillComposer: () => ({ ok: true, kind: 'shell' }),
    leaveFiles: () => {},
    openPanel: (arg) => { if (openPanel) openPanel(arg); },
    note: (m) => { notes.push(m); },
  });
  const barMount = dom.node('div');
  bar.createGitBar({ model: gitBarModel, doc: dom.document, mount: barMount });

  const state = { files: { path: DIR }, machine: 'm1', browser: null, tabType: 'files' };
  const calls = { enterDir: [], openFiles: 0, renderTabs: 0, errors: [] };
  const fakeConsole = { error: (...a) => calls.errors.push(a) };
  // enterDir is the SHIPPED one's git contract, not a bare stub: the real enterDir ends with
  // `if (gitBarModel) gitBarModel.at(p)` (app.js E1), and leaving that out would hide a bar that
  // comes straight back through the display cache.
  const enterDir = (p) => { calls.enterDir.push(p); gitBarModel.at(p); };
  const openFiles = () => { calls.openFiles++; gitBarModel.hide(); };
  openPanel = new Function(
    'gitUI', 'state', 'exitFilesMode', 'exitBrowserMode', 'exitRadarMode', 'teardownPanes',
    'setStatus', 'renderTabs', 'enterDir', 'openFiles', 'window', 'console', 'gitBarModel',
    fnSrc(appSrc, 'openPanel') + '\nreturn openPanel;',
  )(
    gitUI, state,
    () => {}, () => {}, () => {}, () => {},
    () => {}, () => { calls.renderTabs++; },
    enterDir, openFiles,
    { console: fakeConsole }, fakeConsole, gitBarModel,
  );

  return {
    gitUI, gitBarModel, barMount, panelMount, state, calls, reqs, notes,
    tick: (ms) => { clock += ms; },
    urls: () => reqs.map((r) => r.url),
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function walk(root, out) {
  out.push(root);
  for (const c of root.childNodes || []) if (c.tagName) walk(c, out);
  return out;
}
const controls = (mount) => walk(mount, []).filter((n) => typeof n.onclick === 'function');
const tap = (mount, label) => {
  const b = controls(mount).find((n) => n.textContent === label);
  assert.ok(b, 'expected a control labelled ' + JSON.stringify(label)
    + ', saw ' + JSON.stringify(controls(mount).map((n) => n.textContent)));
  return b.onclick();
};

// Drive the whole journey: stand in DIR, tap the bar's panel door, let the panel read status.
async function journeyToPanel(b) {
  await b.gitBarModel.at(DIR);
  await flush();
  assert.ok(b.barMount.textContent.indexOf(NAME) !== -1, 'precondition: the bar names the repo');
  tap(b.barMount, '›');
  await flush();
}

// ---- the wiring, measured end to end -----------------------------------------------------------

test('precondition: the panel really is opened from the bar, bound to the read source', async () => {
  const b = boot();
  await b.gitBarModel.at(DIR);
  await flush();
  tap(b.barMount, '›');
  await flush();
  assert.strictEqual(b.state.tabType, 'git', 'the bar door set the tab type');
  assert.ok(b.urls().some((u) => u.indexOf('/gitread/status?machine=m1&dir=' + encodeURIComponent(REPO)) !== -1),
    'the panel read p8\'s source, anchored on the repo the probe resolved');
});

test('a bar-bound status 403 hides the BAR, not only the panel', async () => {
  const b = boot();
  await journeyToPanel(b);
  // TEXT absent from the live mount, never a count: a count passes against a bar left attached and
  // emptied, and equally against one re-rendered a tick later by the close repaint.
  assert.strictEqual(b.barMount.textContent.indexOf(NAME), -1,
    'the bar survived a scope loss and still offers controls the server refuses forever');
  assert.strictEqual(b.barMount.textContent, '', 'nothing of the bar is mounted');
  assert.deepStrictEqual(b.gitBarModel.current(), { visible: false });
  assert.ok(!b.gitUI.el.classList.contains('on'), 'and the panel left too');
});

test('the bar stays hidden through the close repaint — the display cache must not put it back', async () => {
  // onScopeLost fires BEFORE onClose (git.js scopeLost), and onClose re-enters the directory, whose
  // at() consults the display cache. A warm entry there would re-show the bar with NO request at
  // all, one synchronous line after it was hidden.
  const b = boot();
  await journeyToPanel(b);
  assert.deepStrictEqual(b.calls.enterDir, [DIR], 'the close callback did re-enter the directory');
  await flush();
  assert.strictEqual(b.barMount.textContent, '',
    'the bar came back after the scope loss — hiding it must outlive the close repaint');
});

test('the ⎇ toolbar door is untouched: its open literal carries onClose and no onScopeLost', () => {
  const sites = openSites(APP);
  assert.ok(sites.length >= 2, 'both doors must be present');
  const bar = sites.filter((s) => /onScopeLost\s*:/.test(s));
  assert.strictEqual(bar.length, 1, 'exactly ONE door may carry onScopeLost — the bar door');
  assert.ok(/repo\s*:/.test(bar[0]), 'and it is the door that passes a repo, i.e. the bar door');
  for (const s of sites) {
    assert.ok(/onClose\s*:/.test(s), 'C11 still holds: every door supplies its own onClose');
  }
  const toolbar = sites.filter((s) => !/onScopeLost\s*:/.test(s));
  assert.ok(toolbar.length >= 1, 'the ⎇ door must still exist');
  for (const s of toolbar) {
    assert.strictEqual(/onScopeLost/.test(s), false,
      '§6.6 disjointness: the ⎇ journey must never touch p8 code');
  }
});

test('the handler goes through the MODEL — never the view, never the network', () => {
  const src = fnSrc(APP, 'openPanel');
  const m = /onScopeLost\s*:\s*[^\n]*/.exec(src);
  assert.ok(m, 'the bar door must carry an onScopeLost handler');
  assert.ok(/gitBarModel\.scopeLost\(\)/.test(m[0]), '§7: every failure hides the bar');
  assert.ok(/if\s*\(gitBarModel\)/.test(m[0]),
    'guarded — a missing gitbar.js must not turn a scope loss into a crash');
  assert.strictEqual(/gitBarView/.test(m[0]), false, 'the door must not drive the view directly');
  assert.strictEqual(/gitread/.test(m[0]), false, 'the model owns the network');
});

// ---- hide() vs scopeLost(): the distinction the wiring depends on -------------------------------

test('hide() keeps the display cache: a re-entry within the TTL is still free (§5.2, unchanged)', async () => {
  const b = boot();
  await b.gitBarModel.at(DIR);
  await flush();
  const probes = b.reqs.filter((r) => r.key === 'probe').length;
  b.gitBarModel.hide();
  assert.strictEqual(b.barMount.textContent, '', 'hidden means nothing is mounted');
  b.tick(10);
  await b.gitBarModel.at(DIR);
  await flush();
  assert.strictEqual(b.reqs.filter((r) => r.key === 'probe').length, probes,
    'the viewer round-trip must stay free — this is what forbids fixing the gap inside hide()');
  assert.ok(b.barMount.textContent.indexOf(NAME) !== -1, 'and the bar is back');
});

test('scopeLost() evicts: the same re-entry costs a fresh probe and shows nothing until it answers', async () => {
  const b = boot();
  await b.gitBarModel.at(DIR);
  await flush();
  b.gitBarModel.scopeLost();
  assert.strictEqual(b.barMount.textContent, '');
  b.tick(10);
  b.reqs.length = 0;
  const p = b.gitBarModel.at(DIR);
  assert.strictEqual(b.barMount.textContent, '',
    'a REFUSED identity must never be repainted from cache — the re-entry has to ask');
  await p; await flush();
  assert.strictEqual(b.reqs.filter((r) => r.key === 'probe').length, 1,
    'and asking is exactly one fresh probe');
});

test('openPanel is still ordered before display(e) in the bar model — this change did not reverse it', () => {
  const barSrc = fs.readFileSync(BAR_PATH, 'utf8');
  const openAt = barSrc.indexOf('if (openPanel) openPanel({');
  const displayAt = barSrc.indexOf('display(e);', openAt);
  assert.ok(openAt > 0 && displayAt > openAt,
    'STORY-006: the door opens on the RESPONSE identity, before the bar adopts it');
});

test('a scope loss with no bar mounted (gitbar.js absent) is a no-op, not a crash', async () => {
  // The defensive mount leaves gitBarModel null. The panel still calls onScopeLost.
  const b = boot();
  const fn = new Function(
    'gitUI', 'state', 'exitFilesMode', 'exitBrowserMode', 'exitRadarMode', 'teardownPanes',
    'setStatus', 'renderTabs', 'enterDir', 'openFiles', 'window', 'console', 'gitBarModel',
    fnSrc(APP, 'openPanel') + '\nreturn openPanel;',
  );
  const calls = { enterDir: [] };
  const openPanel = fn(
    b.gitUI, { files: { path: DIR }, machine: 'm1', browser: null, tabType: 'files' },
    () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
    (p) => { calls.enterDir.push(p); }, () => {},
    { console }, console, null,
  );
  openPanel({ repo: REPO, name: NAME, src: 'read' });
  await flush();
  assert.deepStrictEqual(calls.enterDir, [DIR], 'the operator still lands back in the listing');
});

// ---- negative controls -------------------------------------------------------------------------
// Each removes the wiring from the REAL app.js and requires the oracle above to bite.

const CONTROLS = [];
const control = (label, run) => CONTROLS.push([label, run]);

// NC1 — the gap as it stood: the bar door supplies no onScopeLost at all.
control('bar door supplies no onScopeLost (the shipped gap)', async () => {
  const b = boot({
    appMutations: [['        onScopeLost: () => { if (gitBarModel) gitBarModel.scopeLost(); },\n', '']],
  });
  await journeyToPanel(b);
  assert.strictEqual(b.barMount.textContent, '');
});

// NC2 — the handler wired but inert: the panel is told, the bar is not.
control('onScopeLost passed but the bar is never told', async () => {
  const b = boot({
    appMutations: [['if (gitBarModel) gitBarModel.scopeLost(); },', 'if (false) gitBarModel.scopeLost(); },']],
  });
  await journeyToPanel(b);
  assert.strictEqual(b.barMount.textContent, '');
});

// NC3 — THE ONE THAT MATTERS. The obvious wiring, hide(), which is what this gap looks like it
// needs: the panel is told, the bar is hidden, and the close repaint brings it straight back from
// the display cache. This control is the reason the handler does not call hide().
control('the handler calls hide() instead of scopeLost() — the cache repaints the refused bar', async () => {
  const b = boot({
    appMutations: [['if (gitBarModel) gitBarModel.scopeLost(); },', 'if (gitBarModel) gitBarModel.hide(); },']],
  });
  await journeyToPanel(b);
  assert.strictEqual(b.barMount.textContent, '');
});

// NC4 — scopeLost() reduced to hide()'s behaviour in the model: the eviction removed.
control('scopeLost() no longer evicts the refused identity', async () => {
  const b = boot({ barMutations: [['      cache.delete(dir);\n      shown = null;', '      shown = null;']] });
  await journeyToPanel(b);
  assert.strictEqual(b.barMount.textContent, '');
});

for (const [label, run] of CONTROLS) {
  test('negative control: ' + label, async () => {
    let threw = null;
    try { await run(); } catch (e) { threw = e; }
    assert.ok(threw, 'NEGATIVE CONTROL DID NOT BITE: ' + label);
  });
}
