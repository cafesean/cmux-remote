'use strict';
// p8 STORY-008 — public/git.js: open({repo, name, src}) binds the read source, and canWrite gates
// the file row. Against the REAL public/git.js running on a minimal DOM stand-in.
//
// Two properties carry this story, and both are measured here rather than argued:
//
//   * TWO DOORS, TWO SOURCES (§6.6). The ⎇ toolbar door's request stream must stay byte-identical
//     to p7's — asserted against the literal URL strings and the literal command body, plus the
//     disjointness oracle: across a whole toolbar journey, no request URL mentions `gitread`. A
//     change that made both doors share a source would break these even while every other test
//     passed, which is the point of asserting the source binding and not just the behaviour.
//   * canWrite IS A HINT, NOT AUTHORITY (§6.5, §7). `=== false` — and only that shape — removes
//     the control; true or ABSENT renders what shipped, and absent is every ⎇-door response. A
//     write 403 heals through the BOUND source; a *status* 403 through the bar's source leaves
//     entirely, because the healing loop cannot exit a read gate that has started refusing.
//
// The repo is dependency-free, so there is no jsdom to borrow: the stand-in below implements
// exactly the DOM surface git.js consumes and nothing else. Oracles speak in accessible TEXT,
// request URLs and request bodies — never a style class, which could pass while the same UI
// shipped under different styling. Where a "gone" is asserted it is asserted as text absent from
// the LIVE mount, never as a count, because a count oracle passes against a stale attached panel.
//
// Every assertion here has a negative control at the bottom of the file: the fix is reverted by a
// textual mutation of the real source, the module is re-loaded in a fresh realm, and the oracle is
// required to throw. A mutation that does not change the file is itself a failure.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GIT_JS = path.join(__dirname, '..', 'public', 'git.js');
const SRC = fs.readFileSync(GIT_JS, 'utf8');

// ---- DOM stand-in ---------------------------------------------------------------------------

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
    insertBefore(k, ref) {
      if (!ref) return this.appendChild(k);
      if (k.parentNode) k.parentNode.removeChild(k);
      const i = this.childNodes.indexOf(ref);
      k.parentNode = this;
      this.childNodes.splice(i === -1 ? this.childNodes.length : i, 0, k);
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

// Just enough HTML to build git.js's one fixed template: open tags with quoted attributes, close
// tags, text. Anything richer would be a parser the product does not need.
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
  const win = { console };
  return { document: doc, window: win, node: (tag) => makeNode(doc, tag) };
}

// ---- load the REAL module, optionally with the fix reverted -----------------------------------

function loadGit(mutations) {
  let code = SRC;
  for (const [from, to] of mutations || []) {
    assert.ok(code.indexOf(from) !== -1, 'mutation anchor missing from public/git.js: ' + from);
    const next = code.replace(from, to);
    assert.notStrictEqual(next, code, 'mutation must actually change the source: ' + from);
    code = next;
  }
  const dom = makeDom();
  const ctx = { window: dom.window, document: dom.document, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'public/git.js' });
  assert.ok(ctx.window.cmuxGit && typeof ctx.window.cmuxGit.create === 'function',
    'public/git.js must register window.cmuxGit.create');
  return { create: ctx.window.cmuxGit.create, dom };
}

// ---- fixtures and a recording transport -------------------------------------------------------

const REPO = '/r/a';
const FILES = [
  { path: 'a.js', xy: ' M', staged: false, unstaged: true, untracked: false, unmerged: false },
  { path: 'b.js', xy: 'M ', staged: true, unstaged: false, untracked: false, unmerged: false },
];
// MEASURED, not assumed: parseStatusZ('UU c.js\0') yields unstaged:false — an unmerged entry is
// unmerged and nothing else, so it lands in exactly one group.
const CONFLICT = { path: 'c.js', xy: 'UU', staged: false, unstaged: false, untracked: false, unmerged: true };
const BRANCH = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false };

// p7's status body: no `canWrite` anywhere — measured, gitpanel.js contains no such field.
const p7Status = () => ({ repo: REPO, branch: BRANCH, files: FILES, inProgress: { merge: false, rebase: false } });
// p8's: the same shape plus the point-in-time hint.
const readStatus = (canWrite, files) => ({
  repo: REPO, branch: BRANCH, files: files || FILES,
  inProgress: { merge: false, rebase: false }, canWrite,
});

const ok = (json) => ({ status: 200, json });
const refuse = (status, json) => ({ status, json: json || { repo: null } });

function routeKey(url) {
  const m = /\/api\/cmux\/(gitread|git)\/([a-z]+)/.exec(url);
  return m ? m[1] + ':' + m[2] : url;
}

function defaults() {
  return {
    'git:repos': () => ok({ repos: [{ path: REPO, name: 'a', labels: ['repo'] }, { path: '/r/b', name: 'b', labels: [] }] }),
    'git:status': () => ok(p7Status()),
    'gitread:status': () => ok(readStatus(true)),
    'git:branches': () => ok({ repo: REPO, branches: [{ name: 'main', current: true, upstream: 'origin/main', unpushed: 0 }] }),
    'gitread:branches': () => ok({ repo: REPO, branches: [{ name: 'main', current: true, upstream: 'origin/main', unpushed: 0 }] }),
    'git:worktrees': () => ok({ repo: REPO, worktrees: [{ branch: 'main', path: REPO, dirty: 0 }] }),
    'gitread:worktrees': () => ok({ repo: REPO, worktrees: [{ branch: 'main', path: REPO, dirty: 0 }] }),
    'git:diff': () => ok({ repo: REPO, path: 'a.js', diff: '@@ -1 +1 @@\n-x\n+y', truncated: false, bytes: 18 }),
    'gitread:diff': () => ok({ repo: REPO, path: 'a.js', diff: '@@ -1 +1 @@\n-x\n+y', truncated: false, bytes: 18 }),
    'git:command': () => ok({ text: 'git commit -m ' }),
    // STORY-010: p8's command response carries the door the read gate admitted the repo through.
    // The default is `workspace`, so the marking arms below have to ASK for the browsed case rather
    // than inheriting it from a fixture that merely happens to omit the field.
    'gitread:command': () => ok({ text: "git -C '/r/a' commit -m ''", repo: REPO, name: 'a', provenance: 'workspace' }),
    'git:stage': () => ok({ ok: true }),
    'git:unstage': () => ok({ ok: true }),
  };
}

function boot(opts) {
  const o = opts || {};
  const g = loadGit(o.mutations);
  const mount = g.dom.node('div');
  const table = Object.assign(defaults(), o.routes || {});
  const reqs = [];
  const fills = [];
  const notes = [];                      // STORY-010: the injected status-line seam, app.js's setStatus
  const reply = (method, url, body) => {
    reqs.push({ method, url, body: body === undefined ? null : JSON.parse(JSON.stringify(body)) });
    const h = table[routeKey(url)];
    const out = h ? h(url, body, reqs) : refuse(404, { error: 'not_found' });
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => JSON.parse(JSON.stringify(out.json)),
    };
  };
  const api = g.create({
    mount,
    machine: 'm1',
    jget: async (url) => reply('GET', url),
    jpost: async (url, body) => reply('POST', url, body),
    fillComposer: (text) => { fills.push(text); return { ok: true }; },
    // Omitted deliberately when the caller asks: the seam is optional in git.js, and `noNote`
    // proves a host that supplies none still gets a working panel rather than a throw at fill time.
    note: o.noNote ? undefined : (msg) => { notes.push(msg); },
  });
  return { api, mount, reqs, fills, notes, urls: () => reqs.map((r) => r.url) };
}

// ---- DOM oracles ------------------------------------------------------------------------------

function walk(root, fn) {
  fn(root);
  for (const c of root.childNodes || []) if (c.tagName) walk(c, fn);
}
function buttons(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'BUTTON') out.push(n); });
  return out;
}
function labeled(root, s) { return buttons(root).filter((b) => b.textContent === s); }
function click(btn) {
  assert.ok(btn, 'the control must exist to be tapped');
  assert.ok(!btn.disabled, 'the control must be enabled to be tapped');
  return btn.onclick();
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

// Drive the ⎇ door all the way to a rendered Changes view.
async function toolbarToChanges(b) {
  b.api.open({ machine: 'm1', onClose: b.onClose });
  await flush();
  click(labeled(b.mount, 'a')[0]);
  await flush();
}

// ---- A. the ⎇ toolbar door: byte-identical to p7 ----------------------------------------------

test('⎇ door: open() with no repo lands on the repo list and issues exactly today\'s repos URL', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', onClose: () => {} });
  await flush();
  assert.deepStrictEqual(b.urls(), ['/api/cmux/git/repos?machine=m1']);
  assert.strictEqual(labeled(b.mount, 'a').length, 1, 'the list is the repo list');
  assert.strictEqual(b.mount.querySelector('.gtitle').textContent, 'Source control');
});

test('⎇ door: the whole journey emits p7\'s literal URLs and p7\'s command body, and never mentions gitread', async () => {
  const b = boot();
  await toolbarToChanges(b);
  click(labeled(b.mount, 'Branches')[0]);
  await flush();
  click(labeled(b.mount, 'Worktrees')[0]);
  await flush();
  click(labeled(b.mount, 'Changes')[0]);
  await flush();
  click(labeled(b.mount, 'a.js')[0]);
  await flush();
  click(labeled(b.mount, 'Commit')[0]);
  await flush();

  assert.deepStrictEqual(b.urls(), [
    '/api/cmux/git/repos?machine=m1',
    '/api/cmux/git/status?machine=m1&repo=%2Fr%2Fa',
    '/api/cmux/git/branches?machine=m1&repo=%2Fr%2Fa',
    '/api/cmux/git/worktrees?machine=m1&repo=%2Fr%2Fa',
    '/api/cmux/git/status?machine=m1&repo=%2Fr%2Fa',
    '/api/cmux/git/diff?machine=m1&repo=%2Fr%2Fa&path=a.js',
    '/api/cmux/git/command?machine=m1',
  ]);
  const cmd = b.reqs[b.reqs.length - 1];
  assert.strictEqual(cmd.method, 'POST');
  assert.deepStrictEqual(cmd.body, { verb: 'commit', params: { message: '' } },
    'p7\'s command body is {verb, params} — no dir, no extra key');
  // The disjointness that makes "the ⎇ journey never touches p8" source-assertable.
  assert.strictEqual(b.urls().filter((u) => u.indexOf('gitread') !== -1).length, 0);
  assert.deepStrictEqual(b.fills, ['git commit -m ']);
});

test('⎇ door: a staged file\'s unstage posts the p7 write route with {repo, paths}', async () => {
  const b = boot();
  await toolbarToChanges(b);
  const before = b.reqs.length;
  click(labeled(b.mount, 'unstage')[0]);
  await flush();
  const w = b.reqs[before];
  assert.strictEqual(w.url, '/api/cmux/git/unstage?machine=m1');
  assert.deepStrictEqual(w.body, { repo: REPO, paths: ['b.js'] });
});

test('⎇ door: a status 403 keeps today\'s behaviour — the panel stays open and notes it', async () => {
  const b = boot({ routes: { 'git:status': () => refuse(403, { error: 'unknown_repo' }) } });
  await toolbarToChanges(b);
  assert.ok(b.api.el.classList.contains('on'), 'the ⎇ door does not leave on a refusal');
  assert.ok(b.mount.textContent.indexOf('git status failed (http_403)') !== -1);
});

test('⎇ door: a refused write notes and stops — no extra request joins p7\'s stream', async () => {
  const b = boot({ routes: { 'git:stage': () => refuse(403, { error: 'unknown_repo' }) } });
  await toolbarToChanges(b);
  const before = b.reqs.length;
  click(labeled(b.mount, 'stage')[0]);
  await flush();
  assert.strictEqual(b.reqs.length, before + 1, 'exactly the write, and nothing after it');
  assert.ok(b.mount.textContent.indexOf('stage refused: unknown_repo') !== -1);
});

test('⎇ door: canWrite ABSENT renders today\'s controls — absent is not false', async () => {
  const b = boot();
  await toolbarToChanges(b);
  assert.ok(!('canWrite' in p7Status()), 'the p7 route carries no such field');
  assert.strictEqual(labeled(b.mount, 'stage').length, 1);
  assert.strictEqual(labeled(b.mount, 'unstage').length, 1);
  assert.strictEqual(b.mount.textContent.indexOf('Read-only here'), -1);
});

// ---- B. the bar door: source bound at open ----------------------------------------------------

test('bar door: open({repo, name, src:read}) skips the list and reads gitread keyed by dir', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read', onClose: () => {} });
  await flush();
  assert.deepStrictEqual(b.urls(), ['/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa'],
    'no repo-list step in between, and the anchor is spelled dir=');
  assert.strictEqual(b.mount.querySelector('.gtitle').textContent, 'a',
    'the title is the server-derived display name, not the path');
});

test('bar door: branches, worktrees and diff all bind to gitread, keyed by dir', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'Branches')[0]);
  await flush();
  click(labeled(b.mount, 'Worktrees')[0]);
  await flush();
  click(labeled(b.mount, 'Changes')[0]);
  await flush();
  click(labeled(b.mount, 'a.js')[0]);
  await flush();
  assert.deepStrictEqual(b.urls(), [
    '/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa',
    '/api/cmux/gitread/branches?machine=m1&dir=%2Fr%2Fa',
    '/api/cmux/gitread/worktrees?machine=m1&dir=%2Fr%2Fa',
    '/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa',
    '/api/cmux/gitread/diff?machine=m1&dir=%2Fr%2Fa&path=a.js',
  ]);
});

test('bar door: a command posts {verb, dir, params} to gitread and fills when the identity matches', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read', onClose: () => {} });
  await flush();
  click(labeled(b.mount, 'Push')[0]);
  await flush();
  const cmd = b.reqs[b.reqs.length - 1];
  assert.strictEqual(cmd.url, '/api/cmux/gitread/command?machine=m1');
  assert.deepStrictEqual(cmd.body, { verb: 'push', dir: REPO, params: { branch: 'main' } });
  assert.deepStrictEqual(b.fills, ["git -C '/r/a' commit -m ''"]);
  assert.ok(!b.api.el.classList.contains('on'), 'a filled command closes the panel, as it shipped');
});

test('bar door: a command whose response names a different repo does not fill — it notes and re-reads status', async () => {
  const b = boot({ routes: { 'gitread:command': () => ok({ text: "git -C '/r/other' push", repo: '/r/other', name: 'other' }) } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'Push')[0]);
  await flush();
  assert.deepStrictEqual(b.fills, [], 'nothing reaches the composer');
  assert.ok(b.api.el.classList.contains('on'), 'and the panel does not close');
  assert.strictEqual(b.urls()[b.urls().length - 1], '/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa');
  assert.ok(b.mount.textContent.indexOf('resolves to a different repository') !== -1);
});

test('bar door: stage and unstage still post the p7 WRITE routes — one write path in the system', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'stage')[0]);
  await flush();
  const w = b.reqs[1];
  assert.strictEqual(w.url, '/api/cmux/git/stage?machine=m1');
  assert.deepStrictEqual(w.body, { repo: REPO, paths: ['a.js'] });
  assert.strictEqual(b.urls().filter((u) => /gitread\/(stage|unstage)/.test(u)).length, 0);
});

test('bar door: src omitted binds p7 — the read source is an explicit opt-in, not a default', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a' });
  await flush();
  assert.deepStrictEqual(b.urls(), ['/api/cmux/git/status?machine=m1&repo=%2Fr%2Fa']);
});

test('bar door: Back returns to the ⎇ list on the p7 source, and the source stays reset', async () => {
  const b = boot();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(b.mount.querySelector('.gback'));
  await flush();
  assert.strictEqual(b.urls()[1], '/api/cmux/git/repos?machine=m1', 'the list is and remains the ⎇ list');
  click(labeled(b.mount, 'a')[0]);
  await flush();
  assert.strictEqual(b.urls()[2], '/api/cmux/git/status?machine=m1&repo=%2Fr%2Fa',
    'a repo opened from the list reads p7, whatever door opened the panel');
});

// ---- C. capability-honest rendering (§6.5) -----------------------------------------------------

test('canWrite false: no stage or unstage control anywhere, the reason is stated, and diffs still work', async () => {
  const b = boot({ routes: { 'gitread:status': () => ok(readStatus(false)) } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  assert.strictEqual(labeled(b.mount, 'stage').length, 0);
  assert.strictEqual(labeled(b.mount, 'unstage').length, 0);
  assert.strictEqual(b.mount.textContent.indexOf('unstage'), -1, 'the text is gone from the live mount');
  assert.ok(b.mount.textContent.indexOf('Read-only here') !== -1, 'and the boundary is stated one line up');
  assert.ok(labeled(b.mount, 'a.js').length === 1, 'the filename is still a control — diffs are reads');
  click(labeled(b.mount, 'a.js')[0]);
  await flush();
  assert.strictEqual(b.urls()[1], '/api/cmux/gitread/diff?machine=m1&dir=%2Fr%2Fa&path=a.js');
});

test('canWrite false: the unmerged conflict marker survives — it is information, not a control', async () => {
  const b = boot({ routes: { 'gitread:status': () => ok(readStatus(false, [CONFLICT])) } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  const marks = labeled(b.mount, 'conflict');
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].disabled, true);
  assert.strictEqual(labeled(b.mount, 'stage').length, 0);
});

test('canWrite true: the bar-opened panel renders the controls that shipped', async () => {
  const b = boot({ routes: { 'gitread:status': () => ok(readStatus(true)) } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  assert.strictEqual(labeled(b.mount, 'stage').length, 1);
  assert.strictEqual(labeled(b.mount, 'unstage').length, 1);
  assert.strictEqual(b.mount.textContent.indexOf('Read-only here'), -1);
});

// ---- D. the hint healing, and the state the healing cannot reach (§6.5, §7) --------------------

test('bar door: a write 403 keeps the refusal note AND heals through the bound source', async () => {
  let statuses = 0;
  const b = boot({
    routes: {
      // The anchor closed between status and tap: first status says yes, the write 403s, the
      // refreshed status says no.
      'gitread:status': () => { statuses++; return ok(readStatus(statuses === 1)); },
      'git:stage': () => refuse(403, { error: 'unknown_repo' }),
    },
  });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  assert.strictEqual(labeled(b.mount, 'stage').length, 1, 'armed from the first, stale, hint');
  click(labeled(b.mount, 'stage')[0]);
  await flush();
  assert.strictEqual(statuses, 2, 'exactly one healing read, through the BOUND source');
  assert.strictEqual(b.urls()[2], '/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa');
  assert.ok(b.mount.textContent.indexOf('stage refused: unknown_repo') !== -1,
    'the refusal survives the refresh it triggered');
  // The listing must be BACK — otherwise "no stage control" would be satisfied by the refusal note
  // having simply wiped the body, which is what happens with no healing read at all.
  assert.strictEqual(labeled(b.mount, 'a.js').length, 1, 'the refreshed listing is rendered');
  assert.strictEqual(labeled(b.mount, 'stage').length, 0, 'and the refreshed hint took the control away');
  assert.ok(b.mount.textContent.indexOf('Read-only here') !== -1);
});

test('bar door: a status 403 closes the panel and signals the bar — it never blames git for a scope decision', async () => {
  const closes = [];
  const lost = [];
  const b = boot({ routes: { 'gitread:status': () => refuse(403) } });
  b.api.open({
    machine: 'm1', repo: REPO, name: 'a', src: 'read',
    onClose: () => closes.push(1), onScopeLost: () => lost.push(1),
  });
  await flush();
  assert.deepStrictEqual(lost, [1], 'the opener is told to drop the bar, exactly once');
  assert.deepStrictEqual(closes, [1]);
  assert.ok(!b.api.el.classList.contains('on'), 'the panel is gone');
  assert.strictEqual(b.mount.textContent.indexOf('git status failed'), -1,
    'a scope decision is never reported as a git failure');
});

test('bar door: a status 403 arriving mid-session leaves rather than looping on dead controls', async () => {
  let statuses = 0;
  const lost = [];
  const b = boot({
    routes: {
      'gitread:status': () => { statuses++; return statuses === 1 ? ok(readStatus(true)) : refuse(403); },
      'git:stage': () => refuse(403, { error: 'unknown_repo' }),
    },
  });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read', onScopeLost: () => lost.push(1) });
  await flush();
  click(labeled(b.mount, 'stage')[0]);
  await flush();
  // The healing read is itself refused. Without the §7 arm the controls would stay live over a
  // repo the server refuses forever, and every tap would fail with a note blaming git.
  assert.deepStrictEqual(lost, [1]);
  assert.ok(!b.api.el.classList.contains('on'));
  assert.strictEqual(b.mount.textContent.indexOf('git status failed'), -1);
});

// ---- E. close state is per-open, never inherited (B11) -----------------------------------------

test('B11: the bar door\'s close never fires the toolbar door\'s callback', async () => {
  const fired = [];
  const b = boot();
  b.api.open({ machine: 'm1', onClose: () => fired.push('toolbar') });
  await flush();
  b.api.close();
  assert.deepStrictEqual(fired, ['toolbar'], 'the ⎇ door\'s own close still lands where it did');

  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read', onClose: () => fired.push('bar') });
  await flush();
  b.api.close();
  assert.deepStrictEqual(fired, ['toolbar', 'bar'], 'and the bar\'s close lands at the bar\'s own call site');
});

test('B11: an open that supplies no onClose inherits nothing — the stored callback is cleared', async () => {
  const fired = [];
  const b = boot();
  b.api.open({ machine: 'm1', onClose: () => fired.push('toolbar') });
  await flush();
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });   // no onClose
  await flush();
  b.api.close();
  assert.deepStrictEqual(fired, [], 'the round-5 defect: this used to exit Files to the terminal');
});

// ---- F. source structure ------------------------------------------------------------------------

test('source: open() assigns the close callback unconditionally; the conditional-retention shape is absent', () => {
  assert.ok(/onCloseCb = typeof [A-Za-z_$][\w$]*\.onClose === 'function' \? [A-Za-z_$][\w$]*\.onClose : null;/.test(SRC),
    'the unconditional assignment must be present verbatim');
  assert.strictEqual(/if\s*\([^)]*\.onClose\s*\)\s*onCloseCb/.test(SRC), false,
    'the conditional-retention shape must not exist anywhere in the file');
});

test('source: git.js still defines and references no basename helper', () => {
  assert.strictEqual(SRC.indexOf('basename'), -1,
    'the display name comes from the probe response\'s server-derived name');
});

test('source: canWrite is compared to false only — truthiness would swallow ABSENT', () => {
  assert.ok(/canWrite === false/.test(SRC));
  assert.strictEqual(/canWrite === true/.test(SRC), false);
  assert.strictEqual(/canWrite !== true/.test(SRC), false);
  assert.strictEqual(/if\s*\(\s*!?\s*(d\.)?canWrite\s*\)/.test(SRC), false, 'no truthiness gate');
});

test('source: the read source is bound at open and reset by the list — it is never global state', () => {
  assert.ok(/st\.src === 'read' \? '\/api\/cmux\/gitread\/' : '\/api\/cmux\/git\/'/.test(SRC));
  assert.ok(/st\.src === 'read' \? 'dir=' : 'repo='/.test(SRC));
  assert.ok(/async function showRepos\(\)[\s\S]{0,240}st\.src = 'git';/.test(SRC),
    'returning to the list resets the source to p7\'s');
  // The one write path: stage/unstage name the p7 route literally, never through the source helper.
  assert.ok(/jpost\('\/api\/cmux\/git\/' \+ verb/.test(SRC));
});

// ---- F2. STORY-010: provenance marking on the panel door's generated text ----------------------
// The bar is not the only surface that generates p8 text: the bar opens THIS panel bound to the
// read source, and its command buttons generate from the same route. A marking that lives only in
// the bar would be absent on exactly the journey the bar itself starts.
//
// The seam is the injected `note`, not this panel's body, and that is forced: `close()` is the
// statement after the fill, so a note written into the body is a note the operator cannot read.

const BROWSED_MARK = require('../gitread').BROWSED_TEXT_MARK;
const readCmd = (provenance) => {
  const body = { text: "git -C '/r/a' commit -m ''", repo: REPO, name: 'a' };
  if (provenance !== undefined) body.provenance = provenance;
  return () => ok(body);
};

test('bar door: a browsed repo\'s generated text is marked through the status seam, and the text is untouched', async () => {
  const b = boot({ routes: { 'gitread:command': readCmd('browsed') } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(b.fills, ["git -C '/r/a' commit -m ''"], 'the payload reaches the composer untouched');
  assert.deepStrictEqual(b.notes, [BROWSED_MARK], 'and the marking is emitted exactly once, verbatim');
});

test('bar door: a workspace repo\'s generated text is unmarked, and the text is byte-identical to the browsed one', async () => {
  const w = boot({ routes: { 'gitread:command': readCmd('workspace') } });
  w.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(w.mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(w.notes, [], 'a workspace repo is unmarked');

  const b = boot({ routes: { 'gitread:command': readCmd('browsed') } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(w.fills, b.fills, 'ONE text, two markings — the marking is never payload');
});

test('bar door: the marking is fail-closed — an absent or unrecognised provenance still marks', async () => {
  for (const p of [undefined, null, 'Workspace', '', 'browsed']) {
    const b = boot({ routes: { 'gitread:command': readCmd(p) } });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.notes, [BROWSED_MARK], `provenance ${JSON.stringify(p)} must mark`);
  }
});

test('⎇ door: p7\'s journey is unmarked — p7 carries no provenance and must not inherit the fail-closed default', async () => {
  const b = await (async () => { const x = boot(); await toolbarToChanges(x); return x; })();
  click(labeled(b.mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(b.fills, ['git commit -m '], 'PRECONDITION: the p7 fill happened');
  assert.deepStrictEqual(b.notes, [], 'the ⎇ door emits nothing — its request stream and its side effects are p7\'s');
});

test('bar door: a panel with no note seam still fills — the seam is optional, not required', async () => {
  const b = boot({ noNote: true, routes: { 'gitread:command': readCmd('browsed') } });
  b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(b.mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(b.fills, ["git -C '/r/a' commit -m ''"]);
  assert.strictEqual(b.api.el.classList.contains('on'), false, 'and it still closed after filling');
});

test('bar door: a fill that FAILED is not marked — there is no text in the operator\'s hand to mark', async () => {
  const g2 = loadGit();
  const mount = g2.dom.node('div');
  const notes = [];
  const table = Object.assign(defaults(), { 'gitread:command': readCmd('browsed') });
  const api = g2.create({
    mount,
    machine: 'm1',
    jget: async (url) => { const h = table[routeKey(url)]; const out = h ? h(url) : refuse(404, {}); return { ok: out.status < 300, status: out.status, json: async () => out.json }; },
    jpost: async (url, body) => { const h = table[routeKey(url)]; const out = h ? h(url, body) : refuse(404, {}); return { ok: out.status < 300, status: out.status, json: async () => out.json }; },
    fillComposer: () => ({ ok: false, reason: 'that pane is a pager' }),
    note: (m) => notes.push(m),
  });
  api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
  await flush();
  click(labeled(mount, 'Commit')[0]);
  await flush();
  assert.deepStrictEqual(notes, [], 'nothing was filled, so nothing is marked');
  assert.ok(mount.textContent.indexOf('nothing filled: that pane is a pager') !== -1, 'and the fill failure is still stated');
});

// ---- G. negative controls: every fix reverted, every oracle required to bite --------------------

// Each control is its own test, so one that stops biting names itself instead of hiding behind
// whichever control aborted the run first.
const CONTROLS = [];
const control = (label, run) => CONTROLS.push([label, run]);

  // NC1 — the round-5 defect restored: the conditional retention of onCloseCb.
control('conditional onCloseCb retention', async () => {
    const fired = [];
    const b = boot({ mutations: [["onCloseCb = typeof opt.onClose === 'function' ? opt.onClose : null;", 'if (opt.onClose) onCloseCb = opt.onClose;']] });
    b.api.open({ machine: 'm1', onClose: () => fired.push('toolbar') });
    await flush();
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    b.api.close();
    assert.deepStrictEqual(fired, []);
  });

  // NC2 — both doors share the p7 source.
control('source binding collapsed to p7', async () => {
    const b = boot({ mutations: [["st.src === 'read' ? '/api/cmux/gitread/' : '/api/cmux/git/'", "'/api/cmux/git/'"]] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.deepStrictEqual(b.urls(), ['/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa']);
  });

  // NC3 — the read source keyed by repo= instead of dir=.
control('read source keyed by repo=', async () => {
    const b = boot({ mutations: [["(st.src === 'read' ? 'dir=' : 'repo=')", "('repo=')"]] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.deepStrictEqual(b.urls(), ['/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa']);
  });

  // NC4 — the canWrite gate written as truthiness: ABSENT would disarm the ⎇ door.
control('canWrite gated on truthiness', async () => {
    const b = boot({ mutations: [['if (canWrite === false) {', 'if (canWrite !== true) {']] });
    await toolbarToChanges(b);
    assert.strictEqual(labeled(b.mount, 'stage').length, 1);
  });

  // NC5 — controls removed with no reason given.
control('read-only reason line removed', async () => {
    const b = boot({
      mutations: [['if (d.canWrite === false) {', 'if (false) {']],
      routes: { 'gitread:status': () => ok(readStatus(false)) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.ok(b.mount.textContent.indexOf('Read-only here') !== -1);
  });

  // NC6 — the stale hint never heals.
control('write-403 healing refresh removed', async () => {
    let statuses = 0;
    const b = boot({
      mutations: [["if (st.src === 'read') { st.notice = verb", 'if (false) { st.notice = verb']],
      routes: {
        'gitread:status': () => { statuses++; return ok(readStatus(statuses === 1)); },
        'git:stage': () => refuse(403, { error: 'unknown_repo' }),
      },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'stage')[0]);
    await flush();
    assert.strictEqual(labeled(b.mount, 'a.js').length, 1);
    assert.strictEqual(labeled(b.mount, 'stage').length, 0);
  });

  // NC7 — the §7 arm removed: the panel sits on dead controls and blames git.
control('status-403 scope-lost arm removed', async () => {
    const lost = [];
    const b = boot({
      mutations: [["if (st.src === 'read' && d.status === 403) return scopeLost();", 'if (false) return scopeLost();']],
      routes: { 'gitread:status': () => refuse(403) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read', onScopeLost: () => lost.push(1) });
    await flush();
    assert.deepStrictEqual(lost, [1]);
    assert.strictEqual(b.mount.textContent.indexOf('git status failed'), -1);
  });

  // NC8 — the §7 arm ungated: it would fire on the ⎇ door too, changing p7 behaviour.
control('scope-lost arm ungated from the bound source', async () => {
    const b = boot({
      mutations: [["if (st.src === 'read' && d.status === 403) return scopeLost();", 'if (d.status === 403) return scopeLost();']],
      routes: { 'git:status': () => refuse(403, { error: 'unknown_repo' }) },
    });
    await toolbarToChanges(b);
    assert.ok(b.api.el.classList.contains('on'));
    assert.ok(b.mount.textContent.indexOf('git status failed (http_403)') !== -1);
  });

  // NC9 — the healing refresh ungated: an extra request joins p7's stream.
control('healing refresh ungated from the bound source', async () => {
    const b = boot({
      mutations: [["if (st.src === 'read') { st.notice = verb", 'if (true) { st.notice = verb']],
      routes: { 'git:stage': () => refuse(403, { error: 'unknown_repo' }) },
    });
    await toolbarToChanges(b);
    const before = b.reqs.length;
    click(labeled(b.mount, 'stage')[0]);
    await flush();
    assert.strictEqual(b.reqs.length, before + 1);
  });

  // NC10 — the identity check dropped: a command for another repo reaches the composer.
control('command identity check dropped', async () => {
    const b = boot({
      mutations: [["if (st.src === 'read' && d.repo !== st.repo) {", 'if (false) {']],
      routes: { 'gitread:command': () => ok({ text: "git -C '/r/other' push", repo: '/r/other', name: 'other' }) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Push')[0]);
    await flush();
    assert.deepStrictEqual(b.fills, []);
  });

  // NC11 — writes routed through the bound source: two write paths in the system.
control('stage routed through the bound source', async () => {
    const b = boot({ mutations: [["await jpost('/api/cmux/git/' + verb + '?machine='", "await jpost(base() + verb + '?machine='"]] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'stage')[0]);
    await flush();
    assert.strictEqual(b.reqs[1].url, '/api/cmux/git/stage?machine=m1');
  });

  // NC12 — open() ignoring o.repo: the bar door lands on the repo list.
control('open() no longer branches on o.repo', async () => {
    const b = boot({ mutations: [['if (opt.repo) {', 'if (false) {']] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.deepStrictEqual(b.urls(), ['/api/cmux/gitread/status?machine=m1&dir=%2Fr%2Fa']);
  });

  // NC13 — the source not reset when the view returns to the list.
control('source not reset on return to the list', async () => {
    const b = boot({ mutations: [["      st.src = 'git';\n      st.view = 'repos';", "      st.view = 'repos';"]] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(b.mount.querySelector('.gback'));
    await flush();
    assert.strictEqual(b.urls()[1], '/api/cmux/git/repos?machine=m1');
  });

  // NC14 — the conflict marker treated as a control.
control('conflict marker gated on canWrite', async () => {
    const b = boot({
      mutations: [['if (f.unmerged) {', 'if (f.unmerged && canWrite !== false) {']],
      routes: { 'gitread:status': () => ok(readStatus(false, [CONFLICT])) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.strictEqual(labeled(b.mount, 'conflict').length, 1);
  });

  // NC15 — the display name dropped in favour of the path.
control('display name replaced by the path', async () => {
    const b = boot({ mutations: [['openRepo(opt.repo, opt.name || opt.repo)', 'openRepo(opt.repo, opt.repo)']] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    assert.strictEqual(b.mount.querySelector('.gtitle').textContent, 'a');
  });

  // NC16 — the read source made the default rather than an explicit opt-in.
control('read source defaulted instead of opted into', async () => {
    const b = boot({ mutations: [["st.src = opt.src === 'read' ? 'read' : 'git';", "st.src = 'read';"]] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a' });
    await flush();
    assert.deepStrictEqual(b.urls(), ['/api/cmux/git/status?machine=m1&repo=%2Fr%2Fa']);
  });

  // NC17 — the refusal note wiped by the refresh it triggered.
control('refusal note does not survive the healing refresh', async () => {
    const b = boot({
      mutations: [['if (st.notice) {', 'if (false) {']],
      routes: { 'gitread:status': () => ok(readStatus(true)), 'git:stage': () => refuse(403, { error: 'unknown_repo' }) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'stage')[0]);
    await flush();
    assert.ok(b.mount.textContent.indexOf('stage refused: unknown_repo') !== -1);
  });

  // NC18 — the p8 command body missing its addressing key.
control('command body drops dir on the read source', async () => {
    const b = boot({ mutations: [['{ verb, dir: st.repo, params }', '{ verb, params }']] });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Push')[0]);
    await flush();
    assert.deepStrictEqual(b.reqs[1].body, { verb: 'push', dir: REPO, params: { branch: 'main' } });
});

  // NC19 — STORY-010: the panel door generates p8 text and marks nothing.
control('provenance marking removed from the panel door', async () => {
    const b = boot({
      mutations: [["if (st.src === 'read' && d.provenance !== 'workspace') emitNote(BROWSED_TEXT_MARK);", '']],
      routes: { 'gitread:command': readCmd('browsed') },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.notes, [BROWSED_MARK]);
  });

  // NC20 — the gate written fail-OPEN: an absent field would go unmarked.
control('panel marking gated on the browsed string instead of on not-workspace', async () => {
    const b = boot({
      mutations: [["d.provenance !== 'workspace'", "d.provenance === 'browsed'"]],
      routes: { 'gitread:command': readCmd(undefined) },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.notes, [BROWSED_MARK]);
  });

  // NC21 — the marking ungated from the bound source: p7's journey would gain a side effect.
control('panel marking ungated from the read source', async () => {
    const b = boot({ mutations: [["if (st.src === 'read' && d.provenance !== 'workspace')", "if (d.provenance !== 'workspace')"]] });
    await toolbarToChanges(b);
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.notes, []);
  });

  // NC22 — the marking written into the panel body, which close() takes with it.
control('panel marking written to the body instead of the status seam', async () => {
    const b = boot({
      mutations: [['if (st.src === \'read\' && d.provenance !== \'workspace\') emitNote(BROWSED_TEXT_MARK);',
        "if (st.src === 'read' && d.provenance !== 'workspace') note(BROWSED_TEXT_MARK);"]],
      routes: { 'gitread:command': readCmd('browsed') },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.notes, [BROWSED_MARK], 'the marking must reach a surface that outlives the panel');
  });

  // NC23 — the marking appended to the payload rather than presented beside it.
control('panel appending the marking to the filled text', async () => {
    const b = boot({
      mutations: [['fillComposer(d.text)', "fillComposer(d.text + ' # browsed repo')"]],
      routes: { 'gitread:command': readCmd('browsed') },
    });
    b.api.open({ machine: 'm1', repo: REPO, name: 'a', src: 'read' });
    await flush();
    click(labeled(b.mount, 'Commit')[0]);
    await flush();
    assert.deepStrictEqual(b.fills, ["git -C '/r/a' commit -m ''"]);
  });

for (const [label, run] of CONTROLS) {
  test('negative control: ' + label, async () => {
    let threw = null;
    try { await run(); } catch (e) { threw = e; }
    assert.ok(threw, 'NEGATIVE CONTROL DID NOT BITE: ' + label);
  });
}
