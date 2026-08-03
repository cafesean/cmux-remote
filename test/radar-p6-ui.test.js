'use strict';
// p6 — S-008 (select mode, the confirm-sheet state machine, the recovery element, the viewer
// affordance) and S-009's board-row suppression, against the REAL public/radar.js running on a
// minimal DOM stand-in.
//
// The repo is dependency-free, so there is no jsdom to borrow: the stand-in below implements
// exactly the DOM surface radar.js consumes (createElement, append/insertBefore, textContent,
// attributes, handlers) and nothing else. Every oracle here is a ROLE or TEXT or an outgoing
// request body — never an implementation class name, which could pass while the same UI ships
// under a different style (spec §11).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ---- DOM stand-in --------------------------------------------------------------------------------

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    classList: null,
    style: {},
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    _text: null,                       // non-null => a text leaf
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
    get firstChild() { return this.childNodes[0] || null; },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === this) return true;
      return false;
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return null; },
    focus() {},
    get textContent() {
      if (this._text !== null) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      this.childNodes.length = 0;
      const t = makeText(String(v));
      t.parentNode = this;
      this.childNodes.push(t);
    },
  };
  node.classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    contains(c) { return this._set.has(c); },
  };
  let cls = '';
  Object.defineProperty(node, 'className', {
    get() { return cls; },
    set(v) { cls = v; },
  });
  Object.defineProperty(node, 'offsetWidth', { get() { return 0; } });
  Object.defineProperty(node, 'offsetHeight', { get() { return 0; } });
  return node;
}
function makeText(s) {
  return { _text: s, parentNode: null, childNodes: [], get textContent() { return this._text; } };
}

function installDom() {
  const byId = {};
  const document = {
    head: makeNode('head'),
    body: makeNode('body'),
    hidden: false,
    createElement: (tag) => {
      const n = makeNode(tag);
      Object.defineProperty(n, 'id', {
        get() { return n.attributes.id || ''; },
        set(v) { n.attributes.id = v; byId[v] = n; },
      });
      return n;
    },
    createTextNode: (s) => makeText(s),
    getElementById: (id) => byId[id] || null,
    addEventListener: () => {},
  };
  const window = { innerWidth: 1024, innerHeight: 768, console };
  const localStorage = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = String(v); } };
  global.window = window;
  global.document = document;
  global.localStorage = localStorage;
  // node exposes `navigator` as a getter-only global — radar.js only touches it inside handlers
  // these tests never fire (clipboard copy), so the built-in stands.
  return { window, document };
}

// walk helpers — the assertions speak in roles and accessible text
function walk(root, fn) {
  fn(root);
  for (const c of root.childNodes || []) if (c.tagName) walk(c, fn);
}
function buttonsNamed(root, name) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'BUTTON' && n.textContent === name) out.push(n); });
  return out;
}
function checkboxes(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'INPUT' && n.type === 'checkbox') out.push(n); });
  return out;
}
function textareas(root) {
  const out = [];
  walk(root, (n) => { if (n.tagName === 'TEXTAREA') out.push(n); });
  return out;
}
function containsText(root, s) {
  let hit = false;
  walk(root, (n) => { if (n._text === null && n.childNodes.some((c) => c._text !== null && c._text.indexOf(s) !== -1)) hit = true; });
  return hit;
}
function click(btn, ev) {
  assert.ok(btn, 'the control must exist');
  assert.ok(!btn.disabled, 'the control must be enabled');
  return btn.onclick(ev || { shiftKey: false });
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---- boot the real module ------------------------------------------------------------------------

installDom();
require(path.join('..', 'public', 'radar.js'));
const cmuxRadar = global.window.cmuxRadar;
assert.ok(cmuxRadar && typeof cmuxRadar.create === 'function', 'public/radar.js must register window.cmuxRadar');

// One instance per test: fresh mount, scripted fetch stubs, manual clock.
function boot(state, net) {
  global.localStorage._m = {};       // fold preferences must never leak between tests
  const mount = makeNode('div');
  const posts = [];
  const impl = Object.assign({
    preview: (body) => ({ status: 200, json: { v: 1, plan: PLAN_A, hash: 'a'.repeat(64) } }),
    handoff: (body) => ({ status: 201, json: { handoffId: 'h-1', status: 'active', sessionId: 'u', transcriptPath: '/t', logPath: '/l', factKeys: [] } }),
    adopt: (body) => ({ status: 200, json: {} }),
    discard: (body) => ({ status: 200, json: {} }),
  }, net || {});
  const route = (p) => (p.endsWith('/preview') ? 'preview'
    : p.endsWith('/handoff') ? 'handoff'
      : p.endsWith('/adopt') ? 'adopt'
        : p.endsWith('/discard') ? 'discard' : p);
  const api = cmuxRadar.create({
    mount,
    now: () => Date.parse('2026-08-01T12:00:00.000Z'),
    jget: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(state.current || state)) }),
    jpost: async (p, body) => {
      posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) });
      const r = impl[route(p)];
      const out = typeof r === 'function' ? r(body) : r;
      if (out instanceof Error) throw out;
      return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(JSON.stringify(out.json)) };
    },
  });
  return { api, mount, posts, impl };
}

const PLAN_A = {
  previewId: 'aaaaaaaa-0000-4000-8000-000000000001',
  handoffId: 'h-20260801-1200-aaaaaa',
  sessionUuid: 'bbbbbbbb-0000-4000-8000-000000000002',
  windowName: 'h-20260801-1200-aaaaaa-e1',
  machine: 'machine-a',
  selectors: ['epic:E1'],
  factKeys: ['branch:r1:feature/E1-a:unpushed'],
  workdir: '/repos/r1',
  claudeBin: '/usr/local/bin/claude',
  claudeVersion: '2.1.220 (Claude Code)',
  seedPath: '/radar/handoffs/h.md',
  logPath: '/radar/handoffs/h.log',
  transcriptPath: '/claude/projects/-repos-r1/b.jsonl',
  argv: ['--remote-control', '-n', 'h-20260801-1200-aaaaaa-e1', '--session-id', 'bbbbbbbb-0000-4000-8000-000000000002', 'SEED'],
  seedText: '/radar-handoff\nMISSION: finish E1\nFIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.',
  createdAt: '2026-08-01T12:00:00.000Z',
  expiresAt: '2026-08-01T12:02:00.000Z',
};
const PLAN_B = Object.assign({}, PLAN_A, {
  previewId: 'cccccccc-0000-4000-8000-000000000003',
  seedText: 'edited seed\nFIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.',
});

// The fixture board: one row of every kind that matters to selection, plus epics and worktrees.
function boardState(over) {
  return Object.assign({
    v: 1,
    generatedAt: '2026-08-01T11:59:00.000Z',
    collectorId: 'machine-a',
    machines: [{ id: 'machine-a', bridge: 'ok', lastSeenAt: '2026-08-01T11:59:00.000Z' }],
    sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, deploy: { status: 'disabled' }, jira: { status: 'disabled' }, specs: { status: 'disabled' }, config: { status: 'ok' } },
    counts: { blocked: 1, decisions: 1, mergeable: 1, orphans: 3, staleWorktrees: 1, handoffsLive: 0 },
    repos: {
      r1: {
        path: '/repos/r1',
        defaultBranches: { develop: 'd', main: 'm' },
        branches: [
          { name: 'feature/E1-a', sha: 's', epic: 'E1', epicVia: 'issue-key', isDefault: false, unpushed: 3, noRemote: false, mergedIntoDevelop: false, mergedIntoMain: null, lastCommitAt: '2026-07-30T00:00:00.000Z', worktree: '/repos/r1/.claude/worktrees/e1' },
          { name: 'feature/E2-a', sha: 's', epic: 'E2', epicVia: 'issue-key', isDefault: false, unpushed: 0, noRemote: false, mergedIntoDevelop: false, mergedIntoMain: null, lastCommitAt: '2026-06-01T00:00:00.000Z', worktree: null },
          { name: 'old-idea', sha: 's', epic: null, epicVia: 'orphan', isDefault: false, unpushed: 0, noRemote: true, mergedIntoDevelop: null, mergedIntoMain: null, lastCommitAt: '2026-05-01T00:00:00.000Z', worktree: null },
        ],
        worktrees: [
          { path: '/repos/r1/.claude/worktrees/e1', branch: 'feature/E1-a', head: 's', isMain: false, bare: false, locked: false, prunable: false, dirty: { staged: 0, unstaged: 2, untracked: 0 }, dirtyError: null, stale: false, staleReason: null, cleanupCommand: null },
          { path: '/repos/r1/.claude/worktrees/stale1', branch: 'feature/E2-a', head: 's', isMain: false, bare: false, locked: false, prunable: false, dirty: { staged: 0, unstaged: 0, untracked: 0 }, dirtyError: null, stale: true, staleReason: 'merged', cleanupCommand: 'git -C /repos/r1 worktree remove /repos/r1/.claude/worktrees/stale1' },
        ],
        deploy: null,
        fetch: { status: 'ok', error: null },
      },
    },
    epics: [
      { key: 'E1', aliases: [], title: null, jira: null, ladder: { spec: 'unknown', pushed: 'current', mergedDevelop: 'todo', deployedDev: 'todo', prod: 'todo', flags: 'unknown' }, zone: 'active', signals: ['recent-commit', 'unpushed-commits', 'dirty-worktree'], phrase: 'building', lastActivityAt: '2026-07-30T00:00:00.000Z', repos: ['r1'], flag: null, branchCount: 1 },
      { key: 'E2', aliases: [], title: null, jira: null, ladder: { spec: 'unknown', pushed: 'done', mergedDevelop: 'current', deployedDev: 'todo', prod: 'todo', flags: 'unknown' }, zone: 'dormant', signals: ['unmerged-develop'], phrase: '1 branch unmerged', lastActivityAt: '2026-06-01T00:00:00.000Z', repos: ['r1'], flag: null, branchCount: 1 },
    ],
    sessions: [{ key: { machine: 'machine-a', sessionId: '11111111-0000-4000-8000-000000000001' }, status: 'blocked', epic: 'E1', repo: 'r1', surface: { tabUuid: 't-1', tabRef: 'w1/t1' }, notificationType: 'permission_prompt', cacheExpiresAt: null, blockedSince: '2026-08-01T11:00:00.000Z' }],
    attention: [
      { type: 'blocked', sessionKey: { machine: 'machine-a', sessionId: '11111111-0000-4000-8000-000000000001' }, epic: 'E1', deadline: null, surfaceReason: null, actions: [{ kind: 'jump', machine: 'machine-a', tabRef: 'w1/t1', tabUuid: 't-1' }] },
      { type: 'rule-violation', repo: 'r1', env: 'prod', note: 'off-branch', actions: [{ kind: 'context' }] },
      { type: 'decision', id: 'd1', epic: null, title: 'pick a path', since: '2026-07-28T00:00:00.000Z', actions: [{ kind: 'context' }, { kind: 'close' }] },
      { type: 'mergeable', epic: 'E2', note: null, actions: [{ kind: 'context' }] },
      { type: 'default-unpushed', repo: 'r1', branch: 'main', unpushed: 2, actions: [{ kind: 'context' }] },
      { type: 'spec-orphan', specFolder: 'p9-thing', project: 'x', actions: [{ kind: 'tag' }] },
      {
        type: 'orphan-group',
        count: 2,
        items: [
          { type: 'orphan', repo: 'r1', branch: 'old-idea', actions: [{ kind: 'tag' }] },
          { type: 'orphan', repo: 'r1', branch: 'older-idea', actions: [{ kind: 'tag' }] },
        ],
        actions: [{ kind: 'expand' }],
      },
    ],
    handoffs: [],
    handoffRecovery: null,
    role: 'leader',
    jiraDrift: [],
  }, over || {});
}

async function bootAndRender(state, net) {
  const b = boot(state, net);
  await b.api.refresh();
  await flush();
  return b;
}
function enterSelect(b) {
  click(buttonsNamed(b.mount, 'select')[0]);
}
function openQueueFully(b) {
  const more = [];
  walk(b.mount, (n) => { if (n.tagName === 'BUTTON' && n.dataset.role === 'queue-more' && n.textContent.indexOf('more') !== -1) more.push(n); });
  if (more.length) click(more[0]);
}
function openFold(b, id) {
  const btns = [];
  walk(b.mount, (n) => { if (n.tagName === 'BUTTON' && n.dataset.fold === id) btns.push(n); });
  assert.ok(btns.length, `fold ${id} must exist`);
  if (btns[0].getAttribute('aria-expanded') !== 'true') click(btns[0]);
}

// ---- select mode (S-008) -------------------------------------------------------------------------

test('the resting board renders no checkbox, no action bar and no sheet — select is a mode entered deliberately', async () => {
  const b = await bootAndRender(boardState());
  assert.strictEqual(checkboxes(b.mount).length, 0);
  assert.strictEqual(buttonsNamed(b.mount, 'hand off').length, 0);
  assert.strictEqual(textareas(b.mount).length, 0);
  assert.strictEqual(buttonsNamed(b.mount, 'select').length, 1, 'the one toolbar control that enters the mode');
});

test('on a viewer the select affordance is NOT RENDERED at all — an affordance that can only 409 is itself a chore', async () => {
  const b = await bootAndRender(boardState({ role: 'viewer' }));
  assert.strictEqual(buttonsNamed(b.mount, 'select').length, 0);
  // the board itself still renders — refusal is scoped to the affordance, not the tab
  assert.ok(containsText(b.mount, 'RADAR'));
  assert.strictEqual(checkboxes(b.mount).length, 0);
});

test('select mode: checkboxes exist ONLY on selectable rows; blocked keeps jump; decision, rule-violation and spec-orphan rows get none', async () => {
  const b = await bootAndRender(boardState());
  enterSelect(b);
  openQueueFully(b);
  // selectable on this board: mergeable, default-unpushed, orphan-group header = 3 checkboxes
  assert.strictEqual(checkboxes(b.mount).length, 3);
  // the blocked hero keeps its jump control and carries no checkbox
  assert.ok(buttonsNamed(b.mount, 'Jump ↵').length === 1 || buttonsNamed(b.mount, 'jump').length >= 1);
  const labels = checkboxes(b.mount).map((c) => c.getAttribute('aria-label'));
  for (const l of labels) {
    assert.ok(!/decision|Decide|deployed SHA|spec/.test(l || ''), `no checkbox may belong to a non-selectable row: ${l}`);
  }
});

test('rows map to selectors per §6.1: epic row, mergeable, worktree, orphan-group members, default-unpushed — and the preview body carries the deduped set', async () => {
  const b = await bootAndRender(boardState());
  enterSelect(b);
  openQueueFully(b);
  openFold(b, 'moving');            // E1's epic row
  openFold(b, 'worktrees');         // the stale worktree row
  // tick: mergeable(E2), default-unpushed, orphan-group header, epic row E1, stale worktree
  for (const box of checkboxes(b.mount)) click(box);
  const handOff = buttonsNamed(b.mount, 'hand off')[0];
  click(handOff);
  await flush();
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].path, '/api/radar/handoff/preview');
  assert.deepStrictEqual(b.posts[0].body.selectors.slice().sort(), [
    'branch:r1:main',
    'epic:E1',
    'epic:E2',
    'orphan:r1:old-idea',
    'orphan:r1:older-idea',
    'wt:/repos/r1/.claude/worktrees/stale1',
  ], 'an epic header travels as ONE epic: selector; a group header expands to every member; nothing else is invented');
});

test('selecting an epic row and its mergeable item is ONE identity — they tick together and dedupe to one selector', async () => {
  const b = await bootAndRender(boardState());
  // make E2 the mergeable epic AND give it a visible epic row
  enterSelect(b);
  openQueueFully(b);
  openFold(b, 'parked');            // E2's epic row lives in parked
  const boxes = checkboxes(b.mount);
  const mergeableBox = boxes.find((c) => /Merge E2/.test(c.getAttribute('aria-label') || ''));
  const epicBox = boxes.find((c) => (c.getAttribute('aria-label') || '') === 'select E2');
  assert.ok(mergeableBox && epicBox);
  click(mergeableBox);
  assert.ok(containsText(b.mount, '1 selected'), 'the same fact selection is ONE selection, not two');
  click(buttonsNamed(b.mount, 'hand off')[0]);
  await flush();
  assert.deepStrictEqual(b.posts[0].body.selectors, ['epic:E2']);
});

test('shift-click selects the whole range between the anchor and the target', async () => {
  const b = await bootAndRender(boardState());
  enterSelect(b);
  openQueueFully(b);
  const boxes = checkboxes(b.mount);
  assert.ok(boxes.length >= 3);
  click(boxes[0]);
  click(boxes[2], { shiftKey: true });
  assert.ok(containsText(b.mount, '3 selected'), 'anchor, target and everything between');
});

test('space toggles a row; the action bar shows the count and exactly two enabled controls; cancel drops the selection and posts nothing', async () => {
  const b = await bootAndRender(boardState());
  enterSelect(b);
  openQueueFully(b);
  // space on a selectable row
  let row = null;
  walk(b.mount, (n) => { if (!row && n.onkeydown && checkboxes(n).length === 1) row = n; });
  assert.ok(row, 'a selectable row answers the keyboard');
  row.onkeydown({ key: ' ', shiftKey: false, preventDefault: () => {} });
  assert.ok(containsText(b.mount, '1 selected'));
  const handOff = buttonsNamed(b.mount, 'hand off');
  const cancel = buttonsNamed(b.mount, 'cancel');
  assert.strictEqual(handOff.length, 1);
  assert.strictEqual(cancel.length, 1);
  assert.ok(!handOff[0].disabled && !cancel[0].disabled);
  click(cancel[0]);
  assert.strictEqual(checkboxes(b.mount).length, 0, 'cancel leaves select mode');
  assert.strictEqual(b.posts.length, 0, 'nothing was posted');
});

// ---- the confirm sheet (S-008, spec §7.2) --------------------------------------------------------

async function toReady(b) {
  enterSelect(b);
  openQueueFully(b);
  const box = checkboxes(b.mount).find((c) => /Merge E2/.test(c.getAttribute('aria-label') || ''));
  click(box);
  click(buttonsNamed(b.mount, 'hand off')[0]);
  await flush();
}

test('ready: the sheet shows the EXACT seed text editable, the previewId, workdir, argv and the safety notice; confirm is the only control that commits', async () => {
  const b = await bootAndRender(boardState());
  await toReady(b);
  const ta = textareas(b.mount)[0];
  assert.ok(ta, 'the seed is an editable field');
  assert.strictEqual(ta.value, PLAN_A.seedText);
  assert.ok(containsText(b.mount, 'preview ' + PLAN_A.previewId));
  assert.ok(containsText(b.mount, 'workdir ' + PLAN_A.workdir));
  assert.ok(containsText(b.mount, 'argv ' + JSON.stringify(PLAN_A.argv)));

  // The safety sentence is pinned by spec §7.2 as PLAIN TEXT, 334 UTF-8 bytes, with the canonical
  // copy committed at _specs/p6-handoff/fixtures/s007-seed/SAFETY_NOTICE.txt — the spec's ** and
  // backticks are its own markdown emphasis, not string bytes (literal asterisks would render as
  // asterisks in this DOM). Oracle order: the canonical fixture, then radar/handoff.js's export
  // (S-007's constant, which must converge on the same bytes), then the literal.
  let notice = 'The session is instructed to inspect and plan only on its first turn, and to ask ' +
    'before modifying, committing, pushing, merging or deleting anything. It runs without ' +
    "--dangerously-skip-permissions, so Claude's own permission prompts still apply — but your " +
    'existing allowlists may already permit some commands. This is not a sandbox.';
  try {
    notice = require('fs').readFileSync(
      path.join(__dirname, '..', '_specs', 'p6-handoff', 'fixtures', 's007-seed', 'SAFETY_NOTICE.txt'), 'utf8');
  } catch (_) {
    try {
      const handoffMod = require('../radar/handoff');
      if (handoffMod && typeof handoffMod.SAFETY_NOTICE === 'string') notice = handoffMod.SAFETY_NOTICE;
    } catch (_2) { /* neither on disk yet — the literal stands */ }
  }
  assert.ok(containsText(b.mount, notice), 'the sheet renders the safety notice byte-equal to the pinned constant');

  assert.strictEqual(b.posts.length, 1, 'entering ready posted exactly one preview and no commit');
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  assert.strictEqual(b.posts.length, 2);
  assert.strictEqual(b.posts[1].path, '/api/radar/handoff');
  const body = b.posts[1].body;
  assert.deepStrictEqual(Object.keys(body).sort(), ['hash', 'idempotencyKey', 'previewId'],
    'commit carries {previewId, hash, idempotencyKey} and NEVER seed bytes');
  assert.strictEqual(body.previewId, PLAN_A.previewId);
  assert.strictEqual(body.hash, 'a'.repeat(64));
  // 201 closes the sheet and leaves select mode
  assert.strictEqual(textareas(b.mount).length, 0);
  assert.strictEqual(checkboxes(b.mount).length, 0);
});

test('202 and 200-resumed close the sheet exactly as 201 does — unconfirmed is not failed', async () => {
  for (const out of [{ status: 202, json: { handoffId: 'h-1', status: 'unconfirmed', sessionId: 'u', transcriptPath: '/t', logPath: '/l', factKeys: [] } },
    { status: 200, json: { resumed: true, handoff: { id: 'h-0' } } }]) {
    const b = await bootAndRender(boardState(), { handoff: out });
    await toReady(b);
    click(buttonsNamed(b.mount, 'confirm')[0]);
    await flush();
    assert.strictEqual(textareas(b.mount).length, 0, `a ${out.status} closes the sheet`);
    assert.strictEqual(checkboxes(b.mount).length, 0, 'and leaves select mode');
  }
});

test('cancel and a 201 both DETACH the sheet card — not just its textarea', async () => {
  // The old oracles counted textareas, which a stale "dispatching…" card does not have — so the
  // card could stay attached over the board until reload while every count read 0. The oracle
  // here is the card's own TEXT vanishing from the mount.
  let b = await bootAndRender(boardState());
  await toReady(b);
  click(buttonsNamed(b.mount, 'cancel').pop());
  await flush();
  assert.ok(!containsText(b.mount, 'preview ' + PLAN_A.previewId), 'cancel detaches the card');
  assert.ok(!containsText(b.mount, 'This is not a sandbox'), 'no safety notice survives a cancel');

  b = await bootAndRender(boardState());
  await toReady(b);
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  assert.ok(!containsText(b.mount, 'dispatching…'), 'a 201 detaches the transient dispatching card');
  assert.ok(!containsText(b.mount, 'preview ' + PLAN_A.previewId), 'nothing of the sheet survives a commit');
});

test('editing the seed and blurring re-previews with seedOverride — it never confirms, and the displayed plan changes', async () => {
  const b = await bootAndRender(boardState(), {
    preview: (body) => ({ status: 200, json: body && body.seedOverride ? { v: 1, plan: PLAN_B, hash: 'b'.repeat(64) } : { v: 1, plan: PLAN_A, hash: 'a'.repeat(64) } }),
  });
  await toReady(b);
  const ta = textareas(b.mount)[0];
  ta.value = 'edited seed';
  ta.onblur();
  await flush();
  assert.strictEqual(b.posts.length, 2);
  assert.strictEqual(b.posts[1].path, '/api/radar/handoff/preview', 'an edit re-previews; only confirm commits');
  assert.strictEqual(b.posts[1].body.seedOverride, 'edited seed');
  assert.ok(containsText(b.mount, 'preview ' + PLAN_B.previewId), 'a new plan is displayed');
  assert.strictEqual(textareas(b.mount)[0].value, PLAN_B.seedText);
});

test('the idempotency key is minted once per displayed plan: a transport retry reuses it, a re-preview mints a new one', async () => {
  let failNext = true;
  const b = await bootAndRender(boardState(), {
    handoff: () => {
      if (failNext) { failNext = false; return new Error('network down'); }
      return { status: 201, json: { handoffId: 'h-1', status: 'active', sessionId: 'u', transcriptPath: '/t', logPath: '/l', factKeys: [] } };
    },
  });
  await toReady(b);
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  // transport error -> failed, with ONE remedy control
  assert.strictEqual(buttonsNamed(b.mount, 'retry').length, 1);
  click(buttonsNamed(b.mount, 'retry')[0]);
  await flush();
  const commits = b.posts.filter((p) => p.path === '/api/radar/handoff');
  assert.strictEqual(commits.length, 2);
  assert.deepStrictEqual(commits[1].body, commits[0].body,
    'a transport retry re-sends the SAME request with the SAME idempotency key');
});

test('a settled failure spends the key: retry re-previews with the held selection and the next commit carries a NEW key', async () => {
  const b = await bootAndRender(boardState(), {
    handoff: { status: 500, json: { error: 'ledger_write_failed', message: 'the ledger append failed', incidentId: 'dddddddd-0000-4000-8000-000000000004' } },
  });
  await toReady(b);
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  // one code, one sentence, one incidentId — verbatim, never expanded (spec §7.3)
  assert.ok(containsText(b.mount, 'ledger_write_failed'));
  assert.ok(containsText(b.mount, 'the ledger append failed'));
  assert.ok(containsText(b.mount, 'dddddddd-0000-4000-8000-000000000004'));
  assert.strictEqual(buttonsNamed(b.mount, 'retry').length, 1, 'exactly one remedy control');
  const firstKey = b.posts.filter((p) => p.path === '/api/radar/handoff')[0].body.idempotencyKey;

  click(buttonsNamed(b.mount, 'retry')[0]);
  await flush();
  const last = b.posts[b.posts.length - 1];
  assert.strictEqual(last.path, '/api/radar/handoff/preview', 'a settled 5xx re-previews rather than re-running the spent key');
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  const commits = b.posts.filter((p) => p.path === '/api/radar/handoff');
  assert.strictEqual(commits.length, 2);
  assert.notStrictEqual(commits[1].body.idempotencyKey, firstKey, 'a new displayed plan mints a new key');
});

test('409 in_flight retries the same request; a preview failure shows the code and retries the preview', async () => {
  const b = await bootAndRender(boardState(), {
    handoff: { status: 409, json: { error: 'in_flight', message: 'that request is already executing' } },
  });
  await toReady(b);
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await flush();
  click(buttonsNamed(b.mount, 'retry')[0]);
  await flush();
  const commits = b.posts.filter((p) => p.path === '/api/radar/handoff');
  assert.strictEqual(commits.length, 2);
  assert.deepStrictEqual(commits[1].body, commits[0].body, '409 in_flight is the first request still running — same key, same body');

  const b2 = await bootAndRender(boardState(), {
    preview: { status: 422, json: { error: 'selector_unresolved', message: 'a selector resolved to nothing', incidentId: 'eeeeeeee-0000-4000-8000-000000000005' } },
  });
  enterSelect(b2);
  openQueueFully(b2);
  click(checkboxes(b2.mount)[0]);
  click(buttonsNamed(b2.mount, 'hand off')[0]);
  await flush();
  assert.ok(containsText(b2.mount, 'selector_unresolved'));
  assert.ok(containsText(b2.mount, 'eeeeeeee-0000-4000-8000-000000000005'));
  click(buttonsNamed(b2.mount, 'retry')[0]);
  await flush();
  assert.strictEqual(b2.posts.length, 2);
  assert.strictEqual(b2.posts[1].path, '/api/radar/handoff/preview', 'a failed preview re-previews');
});

// ---- the recovery element (S-008, spec §M4/§7.2) -------------------------------------------------

const RECOVERY = { token: '9'.repeat(64), since: '2026-08-01T11:13:00.000Z' };
// The element is found by its OWN sentence — the node whose first child is the span holding the
// text — so an ancestor whose recursive textContent merely contains it never double-counts.
const RECOVERY_RE = /^A handoff was dispatched .+ ago and never produced a transcript, but its process is still running\.$/;
const recoveryEls = (b) => {
  const out = [];
  walk(b.mount, (n) => {
    const first = n.childNodes[0];
    if (first && first.tagName === 'SPAN' && first.childNodes.length === 1
      && first.childNodes[0]._text !== null && RECOVERY_RE.test(first.childNodes[0]._text)) out.push(n);
  });
  return out;
};

test('the recovery element renders iff handoffRecovery !== null: ONE element, two controls, no id, no count, no "more"', async () => {
  const none = await bootAndRender(boardState());
  assert.strictEqual(recoveryEls(none).length, 0);

  const b = await bootAndRender(boardState({ handoffRecovery: RECOVERY }));
  const els = recoveryEls(b);
  assert.strictEqual(els.length, 1, 'exactly one element, above the board');
  const text = els[0].textContent;
  assert.ok(!/more/.test(text));
  assert.ok(!/h-2026/.test(text), 'no handoff id');
  assert.strictEqual(buttonsNamed(els[0], 'adopt').length, 1);
  assert.strictEqual(buttonsNamed(els[0], 'discard').length, 1);
  // exactly two controls — nothing else actionable on it
  let btns = 0;
  walk(els[0], (n) => { if (n.tagName === 'BUTTON') btns++; });
  assert.strictEqual(btns, 2);
});

test('the element is byte-identical however many handoffs are undecidable — it describes the set, never its size', async () => {
  const one = await bootAndRender(boardState({ handoffRecovery: RECOVERY }));
  // three undecidable handoffs publish the SAME {token, since} object (spec §M4: no ids, no count);
  // the board also carries them in handoffs[], which must change nothing on this element
  const three = await bootAndRender(boardState({
    handoffRecovery: RECOVERY,
    handoffs: [1, 2, 3].map((i) => ({ id: `h-20260801-110${i}-aaaaa${i}`, status: 'unconfirmed', selectors: ['epic:EX'], factKeys: [`orphan:rx:b${i}`], session: { machine: 'machine-a', sessionId: `${i}${i}${i}${i}${i}${i}${i}${i}-0000-4000-8000-00000000000${i}` } })),
  }));
  assert.strictEqual(recoveryEls(three).length, 1);
  assert.strictEqual(recoveryEls(three)[0].childNodes[0].textContent, recoveryEls(one)[0].childNodes[0].textContent);
});

test('adopt POSTs {token} and one press clears the element; discard POSTs the other route', async () => {
  const b = await bootAndRender(boardState({ handoffRecovery: RECOVERY }));
  click(buttonsNamed(recoveryEls(b)[0], 'adopt')[0]);
  await flush();
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].path, '/api/radar/recovery/adopt');
  assert.deepStrictEqual(b.posts[0].body, { token: RECOVERY.token });
  assert.strictEqual(recoveryEls(b).length, 0, 'one press empties the element — no second element behind it');

  const b2 = await bootAndRender(boardState({ handoffRecovery: RECOVERY }));
  click(buttonsNamed(recoveryEls(b2)[0], 'discard')[0]);
  await flush();
  assert.strictEqual(b2.posts[0].path, '/api/radar/recovery/discard');
  assert.deepStrictEqual(b2.posts[0].body, { token: RECOVERY.token });
  assert.strictEqual(recoveryEls(b2).length, 0);
});

test('409 not_recoverable is not an error to the user: the element disappears and no error affordance appears', async () => {
  const b = await bootAndRender(boardState({ handoffRecovery: RECOVERY }), {
    adopt: { status: 409, json: { error: 'not_recoverable', message: 'the set changed under you' } },
  });
  click(buttonsNamed(recoveryEls(b)[0], 'adopt')[0]);
  await flush();
  assert.strictEqual(recoveryEls(b).length, 0, 'the set resolved itself — the element simply disappears');
  assert.ok(!containsText(b.mount, 'not_recoverable'));
  assert.ok(!containsText(b.mount, 'the set changed under you'));
});

test('500 ledger_write_failed leaves the element exactly as it was, showing the server sentence — nothing was recorded', async () => {
  const b = await bootAndRender(boardState({ handoffRecovery: RECOVERY }), {
    discard: { status: 500, json: { error: 'ledger_write_failed', message: 'the ledger append failed', incidentId: 'ffffffff-0000-4000-8000-000000000006' } },
  });
  click(buttonsNamed(recoveryEls(b)[0], 'discard')[0]);
  await flush();
  const els = recoveryEls(b);
  assert.strictEqual(els.length, 1, 'the element stays — the press changed nothing');
  assert.ok(containsText(els[0], 'the ledger append failed'));
  assert.strictEqual(buttonsNamed(els[0], 'adopt').length, 1, 'both controls still stand');
  assert.strictEqual(buttonsNamed(els[0], 'discard').length, 1);
});

test('the recovery element is not an attention row: the queue renders identically with and without it', async () => {
  const without = await bootAndRender(boardState());
  const withEl = await bootAndRender(boardState({ handoffRecovery: RECOVERY }));
  const queueText = (b) => {
    const rows = [];
    walk(b.mount, (n) => { if (n.tagName === 'DIV' && /q-row/.test(n.className) && n.dataset.key) rows.push(n.textContent); });
    return rows;
  };
  assert.deepStrictEqual(queueText(withEl), queueText(without));
  // and the element does not live inside the queue rows' container
  const el = recoveryEls(withEl)[0];
  let inQueueRow = false;
  for (let n = el; n; n = n.parentNode) if (n.tagName === 'DIV' && /q-row/.test(n.className || '')) inQueueRow = true;
  assert.ok(!inQueueRow);
});

// ---- board-row suppression (S-009, spec §6.6) ----------------------------------------------------

test('a worktree row leaves the board while a live handoff holds its wt: keys, and an epic row while EVERY one of its keys is held', async () => {
  // E1's complete key set: unpushed + unmerged-develop on its branch, plus its dirty worktree
  const E1_KEYS = [
    'branch:r1:feature/E1-a:unpushed',
    'branch:r1:feature/E1-a:unmerged-develop',
    'wt:/repos/r1/.claude/worktrees/e1:dirty',
  ];
  const live = (keys) => [{ id: 'h-20260801-1200-cccccc', status: 'active', selectors: ['epic:E1'], factKeys: keys, session: { machine: 'machine-a', sessionId: '22222222-0000-4000-8000-000000000002' } }];

  const before = await bootAndRender(boardState());
  openFold(before, 'moving');
  openFold(before, 'worktrees');
  assert.ok(containsText(before.mount, 'E1'), 'the epic row is on the resting board');
  assert.ok(containsText(before.mount, '/repos/r1/.claude/worktrees/stale1'));

  const during = await bootAndRender(boardState({
    handoffs: live(E1_KEYS.concat(['wt:/repos/r1/.claude/worktrees/stale1:stale'])),
    counts: { blocked: 1, decisions: 1, mergeable: 1, orphans: 3, staleWorktrees: 1, handoffsLive: 1 },
  }));
  // both worktree rows are covered (E1's dirty one and the stale one), so the whole fold is gone
  let wtFold = 0;
  walk(during.mount, (n) => { if (n.tagName === 'BUTTON' && n.dataset.fold === 'worktrees') wtFold++; });
  assert.strictEqual(wtFold, 0, 'a fold with zero surviving rows does not render');
  let e1Row = false;
  walk(during.mount, (n) => { if (n.dataset && n.dataset.epic === 'E1') e1Row = true; });
  assert.ok(!e1Row, 'every E1 key is held, so its row is gone from the folds');
  assert.ok(!containsText(during.mount, '/repos/r1/.claude/worktrees/stale1'), 'the covered stale worktree row is gone');
  // E2 contributes an uncovered key set and stays
  openFold(during, 'parked');
  let e2Row = false;
  walk(during.mount, (n) => { if (n.dataset && n.dataset.epic === 'E2') e2Row = true; });
  assert.ok(e2Row, 'an epic with uncovered keys stays');

  const partial = await bootAndRender(boardState({
    handoffs: live(E1_KEYS.slice(0, 2)),     // the dirty-worktree key is NOT held
  }));
  openFold(partial, 'moving');
  let e1Partial = false;
  walk(partial.mount, (n) => { if (n.dataset && n.dataset.epic === 'E1') e1Partial = true; });
  assert.ok(e1Partial, 'one uncovered key keeps the row — suppression needs EVERY contributed key');
});

test('suppression ends with the live set: an empty handoffs[] renders the board exactly as before dispatch', async () => {
  const before = await bootAndRender(boardState());
  openFold(before, 'moving');
  const after = await bootAndRender(boardState({ handoffs: [] }));
  openFold(after, 'moving');
  assert.strictEqual(after.mount.textContent, before.mount.textContent,
    'no baseline, no residue: p5\'s facts decide what returns');
});
