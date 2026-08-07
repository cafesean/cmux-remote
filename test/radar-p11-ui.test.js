'use strict';
// p11 — the work-refs section of the radar board, against the REAL public/radar.js running on a
// minimal DOM stand-in.
//
// The repo is dependency-free, so there is no jsdom to borrow. The stand-in below implements exactly
// the DOM surface radar.js consumes and nothing else. It is deliberately this file's own copy rather
// than one shared with radar-p6-ui.test.js: a mock shared between two UI stories means one story's
// DOM need silently rewrites the other story's oracle, and these two suites must be able to fail
// independently.
//
// EVERY ORACLE IS A ROLE, A TEXT, A data- HOOK OR AN OUTGOING REQUEST — never a style class, which
// could pass while the same UI ships under a different stylesheet (spec §11).
//
// ONE MORE ORACLE THAN IT LOOKS: render() catches its own throw and paints "radar render failed"
// into the board. So "it did not throw" proves nothing here — every absence-tolerance test asserts
// that sentence is ABSENT, which is the only way to tell a tolerated missing field from a swallowed
// exception.
//
// Everything is synthesised: invented project keys, invented repo names, invented session ids, an
// example.com tracker host, invented titles and timestamps.
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
  Object.defineProperty(node, 'className', { get() { return cls; }, set(v) { cls = v; } });
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
  global.window = { innerWidth: 1024, innerHeight: 768, console };
  global.document = document;
  global.localStorage = {
    _m: {},
    getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); },
  };
}

// ---- walk helpers ---------------------------------------------------------------------------------

function walk(root, fn) {
  fn(root);
  for (const c of root.childNodes || []) if (c.tagName) walk(c, fn);
}
function nodesWhere(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) out.push(n); });
  return out;
}
const buttonsNamed = (root, name) => nodesWhere(root, (n) => n.tagName === 'BUTTON' && n.textContent === name);
const refRows = (root) => nodesWhere(root, (n) => n.dataset && n.dataset.role === 'workref');
const foldButton = (root, id) => nodesWhere(root, (n) => n.tagName === 'BUTTON' && n.dataset && n.dataset.fold === id)[0] || null;
const moreButton = (root) => nodesWhere(root, (n) => n.dataset && n.dataset.role === 'refs-more')[0] || null;
const anchors = (root) => nodesWhere(root, (n) => n.tagName === 'A');
const checkboxes = (root) => nodesWhere(root, (n) => n.tagName === 'INPUT' && n.type === 'checkbox');
// A button whose own text is exactly `label` and which lives inside the refs fold. Filters are the
// only such controls, so this is how a filter is pressed without naming a style class.
const filterButton = (root, label) => buttonsNamed(root, label)[0] || null;
function containsText(root, s) {
  let hit = false;
  walk(root, (n) => {
    if (n._text === null && n.childNodes.some((c) => c._text !== null && c._text.indexOf(s) !== -1)) hit = true;
  });
  return hit;
}
function click(btn, ev) {
  assert.ok(btn, 'the control must exist');
  assert.ok(!btn.disabled, 'the control must be enabled');
  return btn.onclick(ev || { shiftKey: false });
}
const flush = () => new Promise((r) => setTimeout(r, 0));
// The board's own failure sentence. Absent = the render really did complete.
const rendered = (mount) => assert.ok(!containsText(mount, 'radar render failed'), 'the board must paint, not fail');

// ---- boot the real module --------------------------------------------------------------------------

installDom();
require(path.join('..', 'public', 'radar.js'));
const cmuxRadar = global.window.cmuxRadar;
assert.ok(cmuxRadar && typeof cmuxRadar.create === 'function', 'public/radar.js must register window.cmuxRadar');

function boot(state) {
  global.localStorage._m = {};            // fold preferences must never leak between tests
  const mount = makeNode('div');
  const posts = [];
  const api = cmuxRadar.create({
    mount,
    now: () => Date.parse('2026-08-05T12:00:00.000Z'),
    jget: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(state)) }),
    jpost: async (p, body) => {
      posts.push({ path: p, body });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  return { api, mount, posts };
}
async function bootAndRender(state) {
  const b = boot(state);
  await b.api.refresh();
  await flush();
  rendered(b.mount);
  return b;
}
// The section is closed on a resting board, exactly like every other fold, so every test that wants
// to see rows opens it first — and that act is itself asserted in the fold test below.
function openRefs(b) {
  const btn = foldButton(b.mount, 'refs');
  assert.ok(btn, 'the work-refs fold must exist');
  if (btn.getAttribute('aria-expanded') !== 'true') click(btn);
  rendered(b.mount);
}

// ---- synthesised snapshots ---------------------------------------------------------------------------

// A p5-shaped board with nothing on it: the work-refs section is the only thing under test, so the
// attention queue, the epics and the repos are all deliberately empty.
function baseState(over) {
  return Object.assign({
    v: 1,
    generatedAt: '2026-08-05T11:59:00.000Z',
    collectorId: 'machine-a',
    machines: [{ id: 'machine-a', bridge: 'ok', lastSeenAt: '2026-08-05T11:59:00.000Z' }],
    sources: { git: { status: 'ok' }, sessions: { status: 'ok' }, jira: { status: 'ok' } },
    counts: { blocked: 0, decisions: 0, mergeable: 0, orphans: 0, staleWorktrees: 0, handoffsLive: 0 },
    repos: {},
    epics: [],
    sessions: [],
    attention: [],
    handoffs: [],
    handoffRecovery: null,
    role: 'leader',
    jiraDrift: [],
  }, over || {});
}

let seq = 0;
// One WorkRef in the shape radar/workref.js publishes. Every field is overridable, because half of
// these tests are about a field NOT being there.
function ref(o) {
  const i = ++seq;
  const key = (o && o.sourceId) || `PROJ-${100 + i}`;
  return Object.assign({
    urn: `urn:work:jira:${key}`,
    source: 'jira',
    sourceId: key,
    sourceUrl: `https://jira.example.com/browse/${key}`,
    kind: 'issue',
    title: `synthetic work item ${i}`,
    status: { native: 'In Progress', nativeCategory: 'indeterminate', canonical: 'active' },
    cluster: key,
    links: [`urn:work:git:example-web/feature/${key}-thing`],
    selectable: true,
    route: { kind: 'resume', sessionId: 'sess-a', machine: 'machine-a', reason: `idle 612s · epic ${key}` },
  }, o || {});
}
// A board carrying `list`, with the two p11 counters derived from the source list the way derive.js
// derives them. `countsOver` exists so a test can prove the counters are READ rather than recomputed.
function stateWithRefs(list, countsOver) {
  const base = baseState();
  return Object.assign(base, {
    workRefs: list,
    counts: Object.assign(base.counts, {
      workRefs: list.length,
      workRefsSelectable: list.filter((w) => w.selectable).length,
    }, countsOver || {}),
  });
}
const manyRefs = (n, o) => Array.from({ length: n }, () => ref(o));

// ================================================================================================
// the count line
// ================================================================================================

test('the section leads with one count line: the total, and how many of them are selectable', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(9)));
  const fold = foldButton(b.mount, 'refs');
  assert.ok(fold, 'the work-refs section renders as a fold');
  assert.ok(fold.textContent.indexOf('9 refs · 9 selectable') !== -1,
    `the count line must read "<total> refs · <n> selectable", got: ${fold.textContent}`);
});

test('the counts come from counts.workRefs — the SOURCE list — not from the array the fold happens to render', async () => {
  // state.schema.json pins the counters to the source list. A producer that publishes a truncated
  // array must still report the honest total, so the line follows the counters, not `length`.
  const list = manyRefs(3);
  const b = await bootAndRender(stateWithRefs(list, { workRefs: 261, workRefsSelectable: 37 }));
  const fold = foldButton(b.mount, 'refs');
  assert.ok(fold.textContent.indexOf('261 refs · 37 selectable') !== -1, fold.textContent);
});

test('a snapshot whose counts predate p11 still gets a count line — the array lengths are the fallback', async () => {
  const list = [ref(), ref(), ref({ selectable: false })];
  const state = stateWithRefs(list);
  delete state.counts.workRefs;
  delete state.counts.workRefsSelectable;
  const b = await bootAndRender(state);
  const fold = foldButton(b.mount, 'refs');
  assert.ok(fold.textContent.indexOf('3 refs · 2 selectable') !== -1, fold.textContent);
});

// ================================================================================================
// the resting board — p5's whole discipline, applied to the largest list radar carries
// ================================================================================================

test('folded by default: the resting board shows the count line and NOT ONE ref row', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(9)));
  assert.strictEqual(refRows(b.mount).length, 0, 'a resting board renders no ref rows at all');
  assert.strictEqual(foldButton(b.mount, 'refs').getAttribute('aria-expanded'), 'false');
  // and nothing else of the section leaks onto the resting screen either
  assert.strictEqual(moreButton(b.mount), null);
  assert.strictEqual(filterButton(b.mount, 'selectable'), null);
  assert.strictEqual(anchors(b.mount).length, 0);
});

test('ZERO SELECTABLE refs contribute no noise beyond the folded count line', async () => {
  // The rule that keeps the board honest: refs exist, none of them is actionable, so the board says
  // so in one line and spends no other pixel on it.
  const b = await bootAndRender(stateWithRefs(manyRefs(12, { selectable: false, route: null })));
  const fold = foldButton(b.mount, 'refs');
  assert.ok(fold.textContent.indexOf('12 refs · 0 selectable') !== -1, fold.textContent);
  assert.strictEqual(refRows(b.mount).length, 0);
  // The quiet board is still quiet — the section did not steal the "all quiet" verdict.
  assert.ok(containsText(b.mount, 'all quiet'));
});

test('opened on a board with nothing selectable, the section says so in words rather than showing an empty list', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(12, { selectable: false, route: null })));
  openRefs(b);
  assert.strictEqual(refRows(b.mount).length, 0);
  assert.ok(containsText(b.mount, 'nothing here a session could act on'));
});

test('a snapshot with NO workRefs key renders no section at all — a pre-p11 collector leaves the board unchanged', async () => {
  const b = await bootAndRender(baseState());
  assert.strictEqual(foldButton(b.mount, 'refs'), null, 'the fold itself must not exist');
  assert.strictEqual(refRows(b.mount).length, 0);
  assert.ok(containsText(b.mount, 'all quiet'), 'the rest of the board paints exactly as it did');
});

test('an EMPTY workRefs array renders no section either — a permanent "0 refs" line can never become actionable', async () => {
  const b = await bootAndRender(stateWithRefs([]));
  assert.strictEqual(foldButton(b.mount, 'refs'), null);
});

// ================================================================================================
// the rows
// ================================================================================================

test('the fold opens to the top N refs and an expander for the rest; the expander reveals every one', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(9)));
  openRefs(b);
  const first = refRows(b.mount);
  assert.ok(first.length > 0 && first.length < 9, `the open fold shows a head of the list, got ${first.length}`);
  const more = moreButton(b.mount);
  assert.ok(more, 'the remainder is reachable through an expander');
  assert.ok(more.textContent.indexOf('+' + (9 - first.length) + ' more') !== -1,
    `the expander counts what it hides, got: ${more.textContent}`);
  click(more);
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 9, 'expanding reveals the whole filtered list');
  // and it collapses back, like the queue's own overflow
  click(moreButton(b.mount));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, first.length);
});

test('a list that fits shows no expander', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(2)));
  openRefs(b);
  assert.strictEqual(refRows(b.mount).length, 2);
  assert.strictEqual(moreButton(b.mount), null);
});

test('a row carries the key, the title, the kind, and BOTH statuses — the canonical projection AND the source\'s own word', async () => {
  const b = await bootAndRender(stateWithRefs([ref({
    sourceId: 'ALPHA-42', kind: 'epic', title: 'metering hardening',
    status: { native: 'In Review', nativeCategory: 'indeterminate', canonical: 'active' },
  })]));
  openRefs(b);
  const row = refRows(b.mount)[0];
  assert.ok(row, 'the ref renders as a row');
  const text = row.textContent;
  assert.ok(text.indexOf('ALPHA-42') !== -1, text);
  assert.ok(text.indexOf('metering hardening') !== -1, text);
  assert.ok(text.indexOf('epic') !== -1, text);
  assert.ok(text.indexOf('active') !== -1, 'radar\'s canonical projection is on the row');
  assert.ok(text.indexOf('In Review') !== -1, 'the tracker\'s own word is on the row too — it is the authority');
});

test('the CONTESTED case is legible: radar says unknown, the tracker says Done, and both stay on the row', async () => {
  // radar/workref.js projects `unknown` when Jira says done while git still shows live work. Showing
  // only the projection would hide exactly the disagreement the projection exists to report.
  const b = await bootAndRender(stateWithRefs([ref({
    sourceId: 'BETA-7',
    status: { native: 'Done', nativeCategory: 'done', canonical: 'unknown' },
    selectable: false,
  })]));
  openRefs(b);
  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  const text = refRows(b.mount)[0].textContent;
  assert.ok(text.indexOf('unknown') !== -1 && text.indexOf('Done') !== -1, text);
});

test('the route renders as kind plus its reason, VERBATIM — including a refusal, whose kind is null', async () => {
  const b = await bootAndRender(stateWithRefs([
    ref({ sourceId: 'ALPHA-1', route: { kind: 'resume', sessionId: 'sess-a', machine: 'machine-a', reason: 'idle 612s · epic ALPHA-1' } }),
    ref({ sourceId: 'ALPHA-2', route: { kind: 'spawn', sessionId: null, machine: 'machine-a', reason: 'no eligible session · budget not evaluated here' } }),
    ref({ sourceId: 'ALPHA-3', route: { kind: null, sessionId: null, machine: null, reason: 'cluster-running' } }),
  ]));
  openRefs(b);
  const byKey = {};
  for (const r of refRows(b.mount)) byKey[r.dataset.urn] = r.textContent;
  assert.ok(byKey['urn:work:jira:ALPHA-1'].indexOf('resume') !== -1);
  assert.ok(byKey['urn:work:jira:ALPHA-1'].indexOf('idle 612s · epic ALPHA-1') !== -1, 'the reason is not reworded');
  assert.ok(byKey['urn:work:jira:ALPHA-2'].indexOf('no eligible session · budget not evaluated here') !== -1,
    'a reason that disclaims a check it did not make must survive intact');
  // A gated cluster is NOT the same fact as an unresolved route, and the reason names the gate.
  assert.ok(byKey['urn:work:jira:ALPHA-3'].indexOf('cluster-running') !== -1);
  assert.ok(byKey['urn:work:jira:ALPHA-3'].indexOf('resume') === -1, 'a refused route never reads as a resume');
});

test('route: null reads as UNRESOLVED — a different fact from a route whose kind is null', async () => {
  const b = await bootAndRender(stateWithRefs([ref({ sourceId: 'ALPHA-9', route: null })]));
  openRefs(b);
  assert.ok(refRows(b.mount)[0].textContent.indexOf('route unresolved') !== -1);
});

// ================================================================================================
// detail on click
// ================================================================================================

test('clicking a row opens its detail: cluster, links, board and sprint context, and the source URL as a link', async () => {
  const b = await bootAndRender(stateWithRefs([ref({
    sourceId: 'ALPHA-42',
    cluster: 'ALPHA-42',
    links: ['urn:work:git:example-web/feature/ALPHA-42-thing', 'urn:work:git:example-api/feature/ALPHA-42-worker'],
    board: { urn: 'urn:work:jira-board:11', name: 'Alpha delivery' },
    sprint: { urn: 'urn:work:jira-sprint:30', name: 'Sprint 4', endsAt: '2026-08-14T00:00:00.000Z' },
    sourceUrl: 'https://jira.example.com/browse/ALPHA-42',
  })]));
  openRefs(b);
  const row = refRows(b.mount)[0];
  assert.strictEqual(row.getAttribute('aria-expanded'), 'false', 'detail is closed until asked for');
  click(row);
  rendered(b.mount);

  assert.strictEqual(refRows(b.mount)[0].getAttribute('aria-expanded'), 'true');
  assert.ok(containsText(b.mount, 'ALPHA-42'), 'the cluster');
  assert.ok(containsText(b.mount, 'urn:work:git:example-web/feature/ALPHA-42-thing'));
  assert.ok(containsText(b.mount, 'urn:work:git:example-api/feature/ALPHA-42-worker'), 'every link, not just the first');
  assert.ok(containsText(b.mount, 'Alpha delivery'), 'the board');
  assert.ok(containsText(b.mount, 'Sprint 4'), 'the sprint');
  const a = anchors(b.mount)[0];
  assert.ok(a, 'sourceUrl is a real link');
  assert.strictEqual(a.getAttribute('href'), 'https://jira.example.com/browse/ALPHA-42');
  assert.strictEqual(a.getAttribute('rel'), 'noreferrer noopener');

  // and it closes again — the detail is a toggle, not a one-way door
  click(refRows(b.mount)[0]);
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount)[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(anchors(b.mount).length, 0);
});

test('an open detail is keyed on the urn, so it survives a re-fetch and does not move to a neighbour', async () => {
  const b = await bootAndRender(stateWithRefs([ref({ sourceId: 'ALPHA-1' }), ref({ sourceId: 'ALPHA-2' })]));
  openRefs(b);
  const second = refRows(b.mount).find((r) => r.dataset.urn === 'urn:work:jira:ALPHA-2');
  click(second);
  rendered(b.mount);
  await b.api.refresh();
  await flush();
  rendered(b.mount);
  const after = {};
  for (const r of refRows(b.mount)) after[r.dataset.urn] = r.getAttribute('aria-expanded');
  assert.strictEqual(after['urn:work:jira:ALPHA-2'], 'true', 'the same ref is still open after a re-fetch');
  assert.strictEqual(after['urn:work:jira:ALPHA-1'], 'false', 'and the detail did not slide onto its neighbour');
});

// ================================================================================================
// filters
// ================================================================================================

test('the scope toggle starts on `selectable` and `all` widens it to every ref', async () => {
  const b = await bootAndRender(stateWithRefs([
    ref({ sourceId: 'ALPHA-1' }),
    ref({ sourceId: 'ALPHA-2', selectable: false, status: { native: 'Done', nativeCategory: 'done', canonical: 'done' }, route: null }),
    ref({ sourceId: 'ALPHA-3', selectable: false, status: { native: 'Backlog', nativeCategory: 'new', canonical: 'inbox' }, route: null }),
  ]));
  openRefs(b);
  assert.strictEqual(filterButton(b.mount, 'selectable').getAttribute('aria-pressed'), 'true',
    'the section opens on what a session could act on');
  assert.strictEqual(refRows(b.mount).length, 1);

  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 3);
  assert.strictEqual(filterButton(b.mount, 'all').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(filterButton(b.mount, 'selectable').getAttribute('aria-pressed'), 'false');

  click(filterButton(b.mount, 'selectable'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 1, 'and back');
});

test('the kind toggles are the kinds actually present, and each one narrows the list to itself', async () => {
  const b = await bootAndRender(stateWithRefs([
    ref({ sourceId: 'ALPHA-1', kind: 'issue' }),
    ref({ sourceId: 'ALPHA-2', kind: 'epic' }),
    ref({ sourceId: 'ALPHA-3', kind: 'epic' }),
    ref({ sourceId: '11', source: 'jira-board', kind: 'board', urn: 'urn:work:jira-board:11', cluster: 'jira-board:11' }),
  ]));
  openRefs(b);
  assert.ok(filterButton(b.mount, 'any kind'), 'a way back to every kind');
  for (const k of ['issue', 'epic', 'board']) assert.ok(filterButton(b.mount, k), `a toggle for ${k}`);
  assert.strictEqual(filterButton(b.mount, 'sprint'), null, 'and none for a kind this board does not carry');

  click(filterButton(b.mount, 'epic'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 2);
  assert.strictEqual(filterButton(b.mount, 'epic').getAttribute('aria-pressed'), 'true');

  click(filterButton(b.mount, 'board'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 1);
  assert.ok(refRows(b.mount)[0].textContent.indexOf('board') !== -1);

  click(filterButton(b.mount, 'any kind'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 4);
});

test('a board carrying ONE kind renders no kind row — a control with one option filters nothing', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(3, { kind: 'issue' })));
  openRefs(b);
  assert.ok(filterButton(b.mount, 'selectable'), 'the scope toggle is always a real choice');
  assert.strictEqual(filterButton(b.mount, 'any kind'), null);
});

test('the two filters compose, and a combination that matches nothing says so', async () => {
  const b = await bootAndRender(stateWithRefs([
    ref({ sourceId: 'ALPHA-1', kind: 'issue' }),
    ref({ sourceId: 'ALPHA-2', kind: 'epic', selectable: false, route: null }),
  ]));
  openRefs(b);
  click(filterButton(b.mount, 'epic'));
  rendered(b.mount);
  // selectable + epic = nothing on this board
  assert.strictEqual(refRows(b.mount).length, 0);
  assert.ok(containsText(b.mount, 'nothing here a session could act on'));
  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 1, 'widening the scope finds the epic again');
});

// ================================================================================================
// absence tolerance — the schema calls a consumer that assumes presence the defect
// ================================================================================================

test('a ref with nothing but its required fields renders as a row, and the board still paints', async () => {
  const bare = {
    urn: 'urn:work:jira:PROJ-900', source: 'jira', sourceId: 'PROJ-900',
    status: { canonical: 'ready' }, cluster: 'PROJ-900', selectable: true,
  };
  const b = await bootAndRender(stateWithRefs([bare]));
  openRefs(b);
  const row = refRows(b.mount)[0];
  assert.ok(row, 'no title, no kind, no route, no links — still a row');
  assert.ok(row.textContent.indexOf('PROJ-900') !== -1);
  assert.ok(row.textContent.indexOf('ready') !== -1);
  assert.ok(row.textContent.indexOf('route unresolved') !== -1);
  // its detail opens too, on the two facts it has
  click(row);
  rendered(b.mount);
  assert.ok(containsText(b.mount, 'urn:work:jira:PROJ-900'));
  assert.strictEqual(anchors(b.mount).length, 0, 'no sourceUrl means no link, not an empty one');
});

test('every optional field, missing one at a time, is tolerated — and each row still renders', async () => {
  const optional = ['sourceUrl', 'kind', 'title', 'cluster', 'links', 'route', 'board', 'sprint', 'assignee', 'updatedAt', 'selectable'];
  for (const field of optional) {
    const one = ref({ sourceId: 'ALPHA-1', board: { urn: 'urn:work:jira-board:11', name: 'Alpha delivery' }, assignee: 'operator-a', updatedAt: '2026-08-04T09:00:00.000Z' });
    delete one[field];
    const b = await bootAndRender(stateWithRefs([one], { workRefsSelectable: 1 }));
    openRefs(b);
    if (field !== 'selectable') {
      assert.strictEqual(refRows(b.mount).length, 1, `a ref missing ${field} must still render`);
      click(refRows(b.mount)[0]);
      rendered(b.mount);
    }
    rendered(b.mount);
  }
});

test('a malformed ref — no status object, no urn, nothing — degrades to a row instead of taking the board down', async () => {
  const b = await bootAndRender(stateWithRefs([{}, ref({ sourceId: 'ALPHA-1' })], { workRefs: 2, workRefsSelectable: 1 }));
  openRefs(b);
  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 2);
  const junk = refRows(b.mount).find((r) => r.dataset.urn === '?:?');
  assert.ok(junk, 'a ref with no identity still gets a stable key of its own');
  assert.ok(junk.textContent.indexOf('unknown') !== -1, 'an absent status projects as unknown, never as blank');
  click(junk);
  rendered(b.mount);
});

test('a links array with junk in it, and a board given as a bare string, both render', async () => {
  const b = await bootAndRender(stateWithRefs([ref({
    sourceId: 'ALPHA-5',
    links: ['urn:work:git:example-web/feature/ALPHA-5-thing', null, 42],
    board: 'Alpha delivery',
    sprint: { urn: 'urn:work:jira-sprint:30' },
  })]));
  openRefs(b);
  click(refRows(b.mount)[0]);
  rendered(b.mount);
  assert.ok(containsText(b.mount, 'urn:work:git:example-web/feature/ALPHA-5-thing'));
  assert.ok(containsText(b.mount, 'Alpha delivery'), 'a bare string board is read, not printed as an object');
  assert.ok(containsText(b.mount, 'urn:work:jira-sprint:30'), 'a nameless sprint falls back to its urn');
});

// ================================================================================================
// the section is READ-ONLY, and it is not part of select mode
// ================================================================================================

test('nothing in the section posts — not opening it, not filtering, not expanding a row', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(9)));
  openRefs(b);
  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  click(moreButton(b.mount));
  rendered(b.mount);
  for (const row of refRows(b.mount)) { click(row); rendered(b.mount); }
  assert.strictEqual(b.posts.length, 0, 'dispatch is unbuilt: this section reads state and writes nothing');
  // No dispatch affordance exists to be pressed, either.
  assert.strictEqual(buttonsNamed(b.mount, 'dispatch').length, 0);
  assert.strictEqual(buttonsNamed(b.mount, 'resume').length, 0);
  assert.strictEqual(buttonsNamed(b.mount, 'spawn').length, 0);
});

test('select mode does not reach into the section — a ref carries no §6.1 selector and gets no checkbox', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(3)));
  openRefs(b);
  click(buttonsNamed(b.mount, 'select')[0]);
  rendered(b.mount);
  assert.strictEqual(refRows(b.mount).length, 3, 'the rows are still there');
  for (const row of refRows(b.mount)) {
    assert.strictEqual(checkboxes(row).length, 0, 'and none of them is selectable for handoff');
  }
});

test('a VIEWER sees the whole section — §3 withholds write affordances, and this section has none', async () => {
  const b = await bootAndRender(Object.assign(stateWithRefs(manyRefs(3)), { role: 'viewer' }));
  assert.strictEqual(buttonsNamed(b.mount, 'select').length, 0, 'the write affordance is still withheld');
  openRefs(b);
  assert.strictEqual(refRows(b.mount).length, 3, 'but reading the tracker roster is not a write');
  assert.strictEqual(b.posts.length, 0);
});

// ================================================================================================
// the fold preference behaves like every other fold
// ================================================================================================

test('the open/closed choice is remembered, and the filters deliberately are not', async () => {
  const b = await bootAndRender(stateWithRefs(manyRefs(3)));
  openRefs(b);
  click(filterButton(b.mount, 'all'));
  rendered(b.mount);
  const saved = JSON.parse(global.localStorage.getItem('p5radar:folds'));
  assert.strictEqual(saved.refs, true, 'the fold is a preference');
  assert.ok(!('scope' in saved) && !('kind' in saved),
    'a filter is this morning\'s triage, not a preference restored tomorrow');
});
