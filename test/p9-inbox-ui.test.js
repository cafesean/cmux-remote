'use strict';
// STORY-008 — `public/inbox.js`: mount into the real app, list, card (spec §5.6).
//
// Four things are proved here, and the first three are proved against the SHIPPED SOURCE rather than
// a re-implementation of it, because the failure they guard against is exactly "the module is
// perfect and nothing ever loads it":
//
//   1. the static route  — a real server.js child answers GET /inbox.js with the module body;
//   2. the mount contract — the versioned tag sits before app.js, and app.js calls the factory
//      defensively with mount/jget/jpost, removing the chip when it fails;
//   3. the sw keys       — BARE /inbox.js precached, PATHNAME in the fetch branch, version bumped,
//      and the `?v=` nowhere but index.html;
//   4. escaping          — inbox.js reaches no HTML sink at all, and a question full of
//      metacharacters renders as TEXT with no element built from it.
//
// The rendering assertions run the REAL public/inbox.js against a minimal DOM stand-in (this repo has
// no jsdom and no dependencies — the stand-in below implements exactly the surface inbox.js consumes
// and nothing else). Everything is synthesised: invented machine ids, invented session ids on the
// reserved `fixture-inbox-N` grammar, invented paths, invented text, invented timestamps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { bootServer } = require('./helpers/server-boot');

const INBOX = require('../public/inbox.js');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SRC = {
  inbox: readSrc('public/inbox.js'),
  app: readSrc('public/app.js'),
  index: readSrc('public/index.html'),
  sw: readSrc('public/sw.js'),
  server: readSrc('server.js'),
};

// A source assertion about what the CODE does must not be satisfiable — or defeated — by prose. The
// escaping assertion below runs against a comment-stripped copy, and the sentinel check underneath
// it proves the stripper did not eat the code along with the commentary.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\/])\/\/[^\n]*/g, '$1');

// `load()` awaits the fetch and then its .json(); a single microtask tick is not enough to see the
// rendered result. setImmediate fires only once the microtask queue is drained.
const flush = () => new Promise((r) => setImmediate(r));

// ---- DOM stand-in ------------------------------------------------------------------------------
// Text nodes are leaves that carry `_text`; elements concatenate their descendants. `appendChild`
// MOVES a node exactly as the real DOM does — that is the behaviour trap 10 is about, so the
// stand-in has to reproduce it or the idempotent-mount test would pass for the wrong reason.

function makeText(doc, value) {
  return { ownerDocument: doc, nodeType: 3, tagName: '#text', childNodes: [], parentNode: null, _text: String(value), get textContent() { return this._text; } };
}

function makeNode(doc, tag) {
  const node = {
    ownerDocument: doc,
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    style: {},
    className: '',
    id: '',
    hidden: false,
    disabled: false,
    value: '',
    rows: 0,
    placeholder: '',
    scrollTop: 0,
    onclick: null,
    oninput: null,
    _text: null,
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
      this.childNodes = [];
      for (const k of kids) this.appendChild(k);
    },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (v !== '' && v != null) this.appendChild(doc.createTextNode(String(v)));
    },
  };
  const classes = new Set();
  node.classList = {
    add(c) { classes.add(c); },
    remove(c) { classes.delete(c); },
    contains(c) { return classes.has(c); },
  };
  return node;
}

function makeDoc() {
  const doc = {};
  doc.createElement = (tag) => makeNode(doc, tag);
  doc.createTextNode = (t) => makeText(doc, t);
  doc.head = makeNode(doc, 'head');
  doc.body = makeNode(doc, 'body');
  doc.getElementById = (id) => walk(doc.head, (n) => n.id === id)[0] || walk(doc.body, (n) => n.id === id)[0] || null;
  return doc;
}

function walk(node, pred, out) {
  const acc = out || [];
  if (node.nodeType === 1 && pred(node)) acc.push(node);
  for (const c of node.childNodes) walk(c, pred, acc);
  return acc;
}
const byClass = (node, cls) => walk(node, (n) => String(n.className || '').split(/\s+/).indexOf(cls) !== -1);
const byTag = (node, tag) => walk(node, (n) => n.tagName === tag.toUpperCase());

// ---- synthesised rows --------------------------------------------------------------------------

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

let seq = 0;
function row(o) {
  const n = ++seq;
  const blockedSince = (o && o.blockedSince) || iso(-600000);
  return Object.assign({
    sessionKey: { machine: 'fixture-machine-a', sessionId: `fixture-inbox-${n}` },
    blockedSince,
    lastStopAt: null,
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn: { blockedSince, assistantTs: iso(-601000) },
    repo: 'fixture-repo',
    worktree: null,
    epic: null,
    question: 'Which branch should this land on?',
    intent: { verdict: 'needs-decision', reason: 'synthetic reason', model: 'fixture-model', at: iso(-60000), inferred: true },
    surface: { workspace: 'fixture-ws', tabRef: 'fixture-tab-ref', tabUuid: 'fixture-tab-uuid-1', via: 'recorded' },
    surfaceReason: null,
    answerable: true,
    actions: [{ kind: 'reply' }],
  }, o || {});
}

// A read-only row: no live join, so the copy vocabulary is what the operator gets instead.
const readOnlyRow = (surfaceReason, extra) => row(Object.assign({
  surface: null, surfaceReason, answerable: false, actions: [],
}, extra || {}));

function mountInbox(payload) {
  const doc = makeDoc();
  const mount = makeNode(doc, 'div');
  doc.body.appendChild(mount);
  const calls = { get: 0, post: [] };
  const jget = async (url) => { calls.get++; calls.lastUrl = url; return { ok: true, status: 200, json: async () => payload }; };
  const jpost = async (url, body) => { calls.post.push({ url, body }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const ui = INBOX.create({ mount, jget, jpost, now: () => NOW });
  return { doc, mount, ui, calls, pane: ui.el };
}

const payloadOf = (items, o) => Object.assign({ items, generatedAt: iso(0), sources: { classifier: 'ok' } }, o || {});

// ================================================================================================
// AC 1 (tier-1) — the static route exists
// ================================================================================================

test('AC1 · a booted server.js answers GET /inbox.js with 200 and the module body', async () => {
  const server = await bootServer({ env: { SERVER_TOKEN: 'fixture-token' } });
  try {
    // Static assets are not behind the token gate (only /api/* is), so this is the browser's exact
    // request — no header, no query.
    const r = await fetch(`${server.base}/inbox.js`);
    assert.equal(r.status, 200, 'GET /inbox.js must be 200 — without the explicit route it 404s and the feature ships dark');
    assert.match(r.headers.get('content-type') || '', /javascript/);
    const body = await r.text();
    assert.match(body, /window\.cmuxInbox|root\.cmuxInbox/, 'the served body must be the inbox module');
    assert.equal(body, SRC.inbox, 'the route must serve public/inbox.js byte-for-byte');
  } finally { await server.stop(); }
});

// ================================================================================================
// AC 2 (tier-1) — THE MOUNT CONTRACT, across all three files
// ================================================================================================

test('AC2 · index.html carries a versioned /inbox.js tag in the feature-script block, BEFORE app.js', () => {
  const tag = /<script src="\/inbox\.js\?v=[^"]+"><\/script>/.exec(SRC.index);
  assert.ok(tag, 'index.html must load /inbox.js with a ?v= cache-busting query');
  const at = SRC.index.indexOf(tag[0]);
  const appAt = SRC.index.search(/<script src="\/app\.js\?v=[^"]+"><\/script>/);
  assert.ok(appAt !== -1, 'the app.js tag must still be there');
  assert.ok(at < appAt, 'the inbox tag must come BEFORE app.js, or window.cmuxInbox is undefined when app boot runs');
  // The feature-script block: the tag sits among the other client modules, not orphaned in <head>.
  const radarAt = SRC.index.search(/<script src="\/radar\.js\?v=[^"]+"><\/script>/);
  assert.ok(radarAt !== -1 && at > radarAt, 'the inbox tag belongs in the feature-script block beside radar.js');
});

test('AC2 · index.html has an inbox control beside Files/Git/Radar', () => {
  assert.match(SRC.index, /id="inboxBtn"/, 'the toolbar needs an inbox chip');
  const inboxAt = SRC.index.indexOf('id="inboxBtn"');
  const radarAt = SRC.index.indexOf('id="radarBtn"');
  const filesAt = SRC.index.indexOf('id="filesBtn"');
  assert.ok(filesAt !== -1 && radarAt !== -1);
  assert.ok(inboxAt > filesAt && inboxAt > radarAt, 'the chip sits in the same toolbar group as Files/Git/Radar');
});

test('AC2 · inbox.js assigns the cmuxInbox factory in the cmuxRadar shape', () => {
  assert.match(SRC.inbox, /root\.cmuxInbox\s*=\s*api/, 'the browser global is assigned through the UMD wrapper');
  assert.equal(typeof INBOX.create, 'function', 'cmuxInbox.create must be a function');
  // The factory shape is a contract: jget/jpost are private to app.js's IIFE, so injection is the
  // ONLY way this module can reach the API.
  assert.match(SRC.inbox, /const\s+jget\s*=\s*o\.jget/, 'create must take jget by injection');
  assert.match(SRC.inbox, /const\s+jpost\s*=\s*o\.jpost/, 'create must take jpost by injection');
  assert.match(SRC.inbox, /const\s+mount\s*=\s*o\.mount/, 'create must take its mount by injection');
  // Nothing may reach around the injection to a global fetch or a bare XHR.
  assert.doesNotMatch(SRC.inbox, /\bXMLHttpRequest\b/, 'no direct XHR — the API is reachable only through the injected helpers');
  assert.doesNotMatch(SRC.inbox, /(^|[^.\w])fetch\s*\(/m, 'no direct fetch — the API is reachable only through the injected helpers');
});

test('AC2 · app.js boots the factory defensively: try/catch, mount+jget+jpost, chip removal on failure', () => {
  const block = /try\s*\{[\s\S]{0,600}?window\.cmuxInbox\s*&&\s*typeof window\.cmuxInbox\.create === 'function'[\s\S]*?\}\s*catch\s*\(([^)]*)\)\s*\{[^}]*inboxUI = null/.exec(SRC.app);
  assert.ok(block, 'the create() call must sit inside a try/catch that nulls inboxUI');
  assert.match(block[0], /inboxUI = window\.cmuxInbox\.create\(\{/, 'app.js calls window.cmuxInbox.create');
  assert.match(block[0], /mount:/, 'create is passed a mount');
  assert.match(block[0], /jget, jpost/, 'create is passed jget and jpost');
  assert.match(SRC.app, /if \(!inboxUI && elInboxBtn && elInboxBtn\.parentNode\) elInboxBtn\.remove\(\);/,
    'a failed or absent module must remove the chip entirely — no dead control');
  // Mutual exclusion with the other full-bleed surfaces.
  assert.match(SRC.app, /function exitInboxMode\(\)/, 'there must be one place that leaves inbox mode');
  assert.match(SRC.app, /state\.tabType = 'inbox';/, 'opening the inbox makes it the active tab type');
  assert.match(SRC.app, /state\.tabType === 'inbox'/, 'leaving is keyed off the same tab type');
  for (const host of ['toggleRadar', 'toggleGit']) {
    const fn = new RegExp(`function ${host}\\(\\)[\\s\\S]*?\\n  \\}`).exec(SRC.app);
    assert.ok(fn, `${host} must still exist`);
    assert.match(fn[0], /exitInboxMode\(\)/, `${host} must close the inbox — two full-bleed surfaces cannot both be active`);
  }
  const setFiles = /function setFilesMode\([\s\S]*?\n  \}/.exec(SRC.app);
  assert.ok(setFiles && /exitInboxMode\(\)/.test(setFiles[0]), 'entering Files must close the inbox');
  const selectTab = /function selectTab\([\s\S]*?\n  \}/.exec(SRC.app);
  assert.ok(selectTab && /exitInboxMode\(\)/.test(selectTab[0]), 'selecting a terminal tab must close the inbox');
  // Opening must stop the terminal mirror — a frozen pane underneath is indistinguishable from a
  // mirror that stopped working.
  const toggle = /function toggleInbox\(\)[\s\S]*?\n  \}/.exec(SRC.app);
  assert.ok(toggle, 'toggleInbox must exist');
  assert.match(toggle[0], /teardownPanes\(\)/, 'opening the inbox must tear down the mirrored panes (terminal polling stops)');
});

test('AC2 · server.js routes /inbox.js beside the other client modules', () => {
  assert.match(SRC.server, /if \(u\.pathname === '\/inbox\.js'\) return serveStatic\(req, res, 'inbox\.js'\);/,
    'the allow-list handler needs an explicit /inbox.js line — there is no fallback route');
});

// ================================================================================================
// AC 3 (tier-1) — SW KEYS AS THEY REALLY ARE
// ================================================================================================

test('AC3 · sw.js precaches the BARE /inbox.js, matches the PATHNAME, and bumps the cache version', () => {
  // The precache entry is unversioned. The fetch branch strips requests to url.pathname and
  // cache-matches by pathname, so a query-bearing key would leave the offline fallback nothing to
  // find and the first offline load would 503.
  const shell = /const SHELL = \[([^\]]*)\]/.exec(SRC.sw);
  assert.ok(shell, 'sw.js must still declare a SHELL precache list');
  const entries = shell[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(entries.includes('/inbox.js'), `the BARE /inbox.js must be precached; got ${JSON.stringify(entries)}`);
  assert.ok(!entries.some((e) => e.indexOf('inbox.js?') !== -1), 'no query-bearing inbox key in the precache list');

  // Precaching alone leaves the file sitting unused in Cache Storage — the fetch branch is the only
  // thing that ever reads it back.
  const branch = /if \(path === '\/app\.js'[^)]*\)\s*\{/.exec(SRC.sw);
  assert.ok(branch, 'the script fetch branch must still exist');
  assert.match(branch[0], /path === '\/inbox\.js'/, "the PATHNAME '/inbox.js' must be in the script fetch branch");

  // Version bumped past the branch base (main ships cmux-shell-v14) — without it the old shell keeps
  // serving an index.html that has never heard of the inbox.
  const cache = /const CACHE = '([^']+)'/.exec(SRC.sw);
  assert.ok(cache, 'sw.js must still declare a CACHE name');
  const n = /^cmux-shell-v(\d+)$/.exec(cache[1]);
  assert.ok(n, `unexpected cache name ${cache[1]}`);
  assert.ok(Number(n[1]) > 14, `the cache version must be bumped past the base v14; got ${cache[1]}`);

  // The ?v= lives in the index.html tag and NOWHERE else.
  assert.ok(SRC.sw.indexOf('inbox.js?') === -1, 'sw.js must never carry a versioned inbox key');
  assert.ok(SRC.server.indexOf('inbox.js?') === -1, 'server.js routes the bare pathname');
  assert.equal((SRC.index.match(/inbox\.js\?v=/g) || []).length, 1, 'exactly one versioned inbox reference, in index.html');
});

// ================================================================================================
// AC 4 (tier-1) — ESCAPING
// ================================================================================================

test('AC4 · inbox.js reaches no HTML sink at all — the strongest form of the escaping guarantee', () => {
  // Proved by ABSENCE rather than by an escaping helper someone can forget to call: every string in
  // this module lands through textContent, so `question` cannot be parsed as markup by construction.
  // There is therefore no interpolation of `question` into an HTML sink, because there is no sink.
  const code = stripComments(SRC.inbox);
  assert.ok(code.indexOf('textContent') !== -1, 'sanity: the stripper must leave the code behind');
  assert.ok(code.indexOf('is no innerHTML') === -1, 'sanity: the stripper must remove the commentary');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'srcdoc']) {
    assert.ok(code.indexOf(sink) === -1, `public/inbox.js must not use ${sink} — question is model-authored transcript text`);
  }
  // And no assignment form slips past under a different spelling.
  assert.doesNotMatch(code, /\[\s*['"](inner|outer)HTML['"]\s*\]/, 'no computed-property route to an HTML sink either');
});

test('AC4 · a question full of HTML metacharacters renders as TEXT, and no element is built from it', async () => {
  const hostile = '<img src=x onerror="boom()"><b>bold</b> & "quoted" \'apostrophe\' </div><script>x</script>';
  const { ui, pane } = mountInbox(payloadOf([row({ question: hostile })]));
  ui.open();
  await flush();
  const rows = byClass(pane, 'irow');
  assert.equal(rows.length, 1);
  const preview = byClass(rows[0], 'iq')[0];
  assert.ok(preview.textContent.indexOf('<img src=x onerror="boom()">') !== -1, 'the metacharacters survive as literal text in the row');
  rows[0].onclick();
  const q = byClass(pane, 'iquestion')[0];
  assert.equal(q.textContent, hostile, 'the card shows the question verbatim, character for character');
  // Nothing was PARSED: no IMG, no B, no SCRIPT node exists anywhere in the pane.
  for (const tag of ['IMG', 'B', 'SCRIPT']) {
    assert.equal(byTag(pane, tag).length, 0, `no <${tag}> element may be created from question text`);
  }
  // And the text lives in text NODES, not in an attribute or a parsed subtree.
  const textNodes = [];
  (function collect(n) { if (n.nodeType === 3) textNodes.push(n._text); for (const c of n.childNodes) collect(c); })(q);
  assert.deepEqual(textNodes, [hostile]);
});

// ================================================================================================
// The pure copy layer (spec §5.6). These sentences are what the SEVEN tier-2 browser ACs assert in
// the DOM; proving the decision layer offline means the browser run is checking wiring, not logic.
// ================================================================================================

test('read-only copy · each of the eight surfaceReason literals gets its own sentence', () => {
  const table = [
    ['recorded-tab-gone', "This session's tab is closed."],
    ['shared-cwd', "Several sessions share this folder, so the tab can't be identified."],
    ['ambiguous-workspace', "More than one terminal matches; the tab can't be identified."],
    ['no-workspace-for-cwd', 'No terminal could be matched to this session.'],
    ['no-cwd', 'No terminal could be matched to this session.'],
    ['no-terminal-tab', 'No terminal could be matched to this session.'],
    ['no-tab-uuid', 'No terminal could be matched to this session.'],
    ['tree-unavailable', "The machine isn't reachable right now."],
  ];
  for (const [reason, copy] of table) {
    assert.equal(INBOX.readOnlyCopy(readOnlyRow(reason)), copy, `wrong copy for ${reason}`);
  }
  // Only ONE value in the whole vocabulary may claim the tab is closed.
  const closed = table.filter(([, c]) => /tab is closed/.test(c)).map(([r]) => r);
  assert.deepEqual(closed, ['recorded-tab-gone']);
});

test('read-only copy · ambiguous-tabs is a VALUE FAMILY — :2 and :4 both reach the ambiguity copy', () => {
  const ambiguity = "More than one terminal matches; the tab can't be identified.";
  for (const v of ['ambiguous-tabs:2', 'ambiguous-tabs:4', 'ambiguous-tabs:17', 'ambiguous-tabs:0']) {
    assert.equal(INBOX.readOnlyCopy(readOnlyRow(v)), ambiguity, `${v} must match the family, never the fallback`);
  }
  // The literal placeholder from the spec table is NOT a value the producer ever emits, and matching
  // it instead of the family is the exact bug this guards.
  assert.equal(INBOX.readOnlyCopy(readOnlyRow('ambiguous-tabs:<n>')), "This session can't be answered from here.");
  assert.equal(INBOX.readOnlyCopy(readOnlyRow('ambiguous-tabs:')), "This session can't be answered from here.");
});

test('read-only copy · an unknown value falls back, including values that shadow Object.prototype', () => {
  const fallback = "This session can't be answered from here.";
  for (const v of ['who-knows', '', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(INBOX.readOnlyCopy(readOnlyRow(v)), fallback, `${JSON.stringify(v)} must fall back`);
  }
  assert.equal(INBOX.readOnlyCopy(readOnlyRow(null)), fallback);
});

test('read-only copy · the heuristic join wins over surfaceReason, byte-for-byte with its em dash', () => {
  const heuristic = 'The tab was matched by folder, not identity — open it directly to answer.';
  // A LIVE tabUuid, joined by cwd: the row is read-only because the join is a guess about which
  // terminal, and the reply route only ever writes through recorded identity.
  const r = row({
    surface: { workspace: 'fixture-ws', tabRef: 'fixture-tab-ref', tabUuid: 'fixture-tab-uuid-9', via: 'cwd' },
    surfaceReason: 'recorded-tab-gone', answerable: false, actions: [],
  });
  assert.equal(INBOX.readOnlyCopy(r), heuristic, 'via:cwd outranks the surfaceReason table');
  const dash = heuristic.indexOf('—');
  assert.ok(dash !== -1 && heuristic.codePointAt(dash) === 0x2014, 'the separator is an em dash (U+2014), not a hyphen');
  assert.ok(heuristic.indexOf(' - ') === -1, 'and not a hyphen-minus with spaces either');
});

test('read-only copy · a permission prompt outranks everything, even a live recorded tab', () => {
  const permission = 'This session is waiting at a permission prompt — open the tab to answer it.';
  for (const t of ['permission_prompt', 'permission_request']) {
    const r = row({ notificationType: t, answerable: false, actions: [], surfaceReason: 'shared-cwd' });
    assert.equal(INBOX.readOnlyCopy(r), permission, `${t} must get the permission copy`);
  }
  // Even with a live, recorded, otherwise-answerable surface — it is waiting on a MENU, not on text.
  assert.equal(INBOX.readOnlyCopy(row({ notificationType: 'permission_request', answerable: false, actions: [] })), permission);
  // The allowlist is an allowlist, not a pattern.
  assert.equal(INBOX.isPermissionType('permission_prompt'), true);
  assert.equal(INBOX.isPermissionType('permission'), false);
  assert.equal(INBOX.isPermissionType('idle_prompt'), false);
  assert.equal(INBOX.isPermissionType(undefined), false);
});

test('pure layer · truncation lives at RENDER, never in the data', () => {
  const long = 'x'.repeat(2000);
  const preview = INBOX.rowQuestion(long);
  assert.ok(preview.length <= INBOX.ROW_QUESTION_MAX + 1, 'the row preview is bounded');
  assert.equal(long.length, 2000, 'the source string is untouched');
  assert.equal(INBOX.rowQuestion('short question'), 'short question', 'a short question is not decorated');
  assert.equal(INBOX.rowQuestion('a\n\nb   c'), 'a b c', 'the row is one line');
  assert.equal(INBOX.rowQuestion(undefined), '');
});

test('pure layer · markers — unknown is unclassified, needs-decision is inferred', () => {
  assert.deepEqual(INBOX.rowMarkers(row({ intent: { verdict: 'unknown' } })).label, 'unclassified');
  assert.deepEqual(INBOX.rowMarkers(row({ intent: { verdict: 'needs-decision' } })).label, 'inferred');
  // A row that reached the client with no intent at all still marks as unclassified rather than
  // silently rendering as a measured verdict.
  assert.equal(INBOX.rowMarkers({}).label, 'unclassified');
});

test('pure layer · the canonical row key is a VALUE, equal across separately-parsed payloads', () => {
  const a = row({});
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(INBOX.rowKey(a), INBOX.rowKey(b));
  assert.notEqual(INBOX.rowKey(a), INBOX.rowKey(row({})));
});

// ================================================================================================
// Rendering, against the real module (the browser ACs assert the same behaviour on a device)
// ================================================================================================

test('render · an empty inbox says "Nothing waiting." with no zero, no badge, no count', async () => {
  const { ui, pane } = mountInbox(payloadOf([]));
  ui.open();
  await flush();
  const list = byClass(pane, 'ilist')[0];
  assert.equal(list.textContent, 'Nothing waiting.');
  assert.equal(byClass(pane, 'irow').length, 0);
  assert.ok(!/\b0\b/.test(pane.textContent), 'no zero anywhere in the pane');
});

test('render · rows appear in the payload order the server pinned — oldest first', async () => {
  const oldest = row({ blockedSince: iso(-3600000), question: 'oldest question' });
  const middle = row({ blockedSince: iso(-600000), question: 'middle question' });
  const newest = row({ blockedSince: iso(-60000), question: 'newest question' });
  const { ui, pane } = mountInbox(payloadOf([oldest, middle, newest]));
  ui.open();
  await flush();
  const rows = byClass(pane, 'irow');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.dataset.key), [oldest, middle, newest].map(INBOX.rowKey));
  assert.deepEqual(rows.map((r) => byClass(r, 'iage')[0].textContent), ['1h', '10m', '1m'],
    'each row shows its own relative age, and the oldest is first');
});

test('render · unknown rows are SHOWN with an unclassified marker; needs-decision shows inferred', async () => {
  const unknown = row({ intent: { verdict: 'unknown', reason: 'no credential', model: null, at: iso(-1000), inferred: true } });
  const decision = row({});
  const { ui, pane } = mountInbox(payloadOf([unknown, decision]));
  ui.open();
  await flush();
  const rows = byClass(pane, 'irow');
  assert.equal(rows.length, 2, 'an unclassified row is never hidden');
  assert.equal(byClass(rows[0], 'imark')[0].textContent, 'unclassified');
  assert.equal(byClass(rows[1], 'imark')[0].textContent, 'inferred');
});

test('render · a 2000-character question is complete in the card, with no ellipsis', async () => {
  const long = 'The deploy touched three services. '.repeat(60).slice(0, 2000);
  assert.equal(long.length, 2000);
  const { ui, pane } = mountInbox(payloadOf([row({ question: long })]));
  ui.open();
  await flush();
  byClass(pane, 'irow')[0].onclick();
  const q = byClass(pane, 'iquestion')[0];
  assert.equal(q.textContent, long, 'the card holds the complete text');
  assert.ok(q.textContent.indexOf('…') === -1, 'no ellipsis in the card');
  // The ROW is the only place shortening happens.
  const preview = INBOX.rowQuestion(long);
  assert.ok(preview.length < long.length && preview.endsWith('…'));
});

test('render · a not-answerable card is read-only: its sentence, and NO action of any kind', async () => {
  const cases = [
    ['recorded-tab-gone', "This session's tab is closed."],
    ['shared-cwd', "Several sessions share this folder, so the tab can't be identified."],
    ['ambiguous-workspace', "More than one terminal matches; the tab can't be identified."],
    ['ambiguous-tabs:2', "More than one terminal matches; the tab can't be identified."],
    ['ambiguous-tabs:4', "More than one terminal matches; the tab can't be identified."],
    ['no-workspace-for-cwd', 'No terminal could be matched to this session.'],
    ['no-cwd', 'No terminal could be matched to this session.'],
    ['no-terminal-tab', 'No terminal could be matched to this session.'],
    ['no-tab-uuid', 'No terminal could be matched to this session.'],
    ['tree-unavailable', "The machine isn't reachable right now."],
    ['a-value-nobody-has-seen', "This session can't be answered from here."],
  ];
  const rows = cases.map(([reason]) => readOnlyRow(reason));
  const { ui, pane } = mountInbox(payloadOf(rows));
  ui.open();
  await flush();
  const listRows = byClass(pane, 'irow');
  assert.equal(listRows.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    listRows[i].onclick();
    const card = byClass(pane, 'icard')[0];
    assert.equal(byClass(card, 'ireadonly')[0].textContent, cases[i][1], `wrong copy for ${cases[i][0]}`);
    assert.equal(byTag(card, 'TEXTAREA').length, 0, `${cases[i][0]}: a read-only card has no reply field`);
    assert.equal(byTag(card, 'BUTTON').length, 0, `${cases[i][0]}: a read-only card offers NO action — there is no dismiss`);
    ui.closeCard();
  }
});

test('render · via:cwd with a LIVE tab, and a permission prompt with a live tab, are both read-only', async () => {
  const heuristic = row({
    surface: { workspace: 'fixture-ws', tabRef: 'fixture-tab-ref', tabUuid: 'fixture-tab-uuid-live', via: 'cwd' },
    surfaceReason: null, answerable: false, actions: [],
  });
  const permission = row({ notificationType: 'permission_request', answerable: false, actions: [] });
  const { ui, pane } = mountInbox(payloadOf([heuristic, permission]));
  ui.open();
  await flush();
  const rows = byClass(pane, 'irow');
  const card = byClass(pane, 'icard')[0];

  rows[0].onclick();
  assert.equal(byClass(card, 'ireadonly')[0].textContent,
    'The tab was matched by folder, not identity — open it directly to answer.');
  assert.equal(byTag(card, 'TEXTAREA').length, 0, 'a guessed tab advertises no Send');
  assert.equal(byTag(card, 'BUTTON').length, 0);
  ui.closeCard();

  rows[1].onclick();
  assert.equal(byClass(card, 'ireadonly')[0].textContent,
    'This session is waiting at a permission prompt — open the tab to answer it.');
  assert.equal(byTag(card, 'TEXTAREA').length, 0, 'a menu is not answered with text');
});

test('render · an answerable card DOES mount a reply field', async () => {
  const { ui, pane } = mountInbox(payloadOf([row({})]));
  ui.open();
  await flush();
  byClass(pane, 'irow')[0].onclick();
  const card = byClass(pane, 'icard')[0];
  assert.equal(byTag(card, 'TEXTAREA').length, 1);
  assert.equal(byClass(card, 'ireadonly')[0].hidden, true, 'no read-only sentence on an answerable card');
});

// ---- trap 10: appendChild MOVES a node, and a move drops focus ---------------------------------

test('trap 10 · a re-render for the SAME surface leaves the reply field node untouched', async () => {
  const r = row({});
  const { ui, pane } = mountInbox(payloadOf([r]));
  ui.open();
  await flush();
  byClass(pane, 'irow')[0].onclick();
  const field = byTag(pane, 'TEXTAREA')[0];
  field.value = 'half a sentence';
  field.oninput();
  // The same row arriving again (a refresh that changed nothing) must not rebuild the field: a
  // rebuild — or even a re-append of the same node — is a move, and a move drops focus mid-word.
  assert.equal(ui.applyOpenCard(JSON.parse(JSON.stringify(r))), true);
  assert.equal(byTag(pane, 'TEXTAREA')[0], field, 'the very same node must still be mounted');
  assert.equal(field.value, 'half a sentence');
});

test('trap 10 · a SURFACE change rebuilds the field and restores the draft verbatim', async () => {
  const r = row({});
  const { ui, pane } = mountInbox(payloadOf([r]));
  ui.open();
  await flush();
  byClass(pane, 'irow')[0].onclick();
  const first = byTag(pane, 'TEXTAREA')[0];
  first.value = 'the same question, moved tabs';
  first.oninput();
  const moved = Object.assign({}, r, { surface: Object.assign({}, r.surface, { tabUuid: 'fixture-tab-uuid-2' }) });
  ui.applyOpenCard(moved);
  const second = byTag(pane, 'TEXTAREA')[0];
  assert.notEqual(second, first, 'a new surface means a new field');
  assert.equal(second.value, 'the same question, moved tabs', 'the draft is re-applied verbatim');
});

test('trap 10 · answerability loss unmounts the field and KEEPS the draft; recovery restores it', async () => {
  const r = row({});
  const { ui, pane } = mountInbox(payloadOf([r]));
  ui.open();
  await flush();
  byClass(pane, 'irow')[0].onclick();
  const field = byTag(pane, 'TEXTAREA')[0];
  field.value = 'typed before the tab went away';
  field.oninput();

  // tree-unavailable on the same turn: the tab is gone, the card goes read-only, the text is not.
  const lost = Object.assign({}, r, { surface: null, surfaceReason: 'tree-unavailable', answerable: false, actions: [] });
  ui.applyOpenCard(lost);
  const card = byClass(pane, 'icard')[0];
  assert.equal(byTag(card, 'TEXTAREA').length, 0, 'a read-only card has no field');
  assert.equal(byClass(card, 'ireadonly')[0].textContent, "The machine isn't reachable right now.");

  ui.applyOpenCard(r);
  const back = byTag(pane, 'TEXTAREA')[0];
  assert.ok(back, 'the field comes back on recovery');
  assert.equal(back.value, 'typed before the tab went away', 'the retained draft is restored verbatim');
});

// ---- the degraded line -------------------------------------------------------------------------

test('render · a degraded classifier is ONE global line, not a per-row warning', async () => {
  const { ui, pane } = mountInbox(payloadOf([row({}), row({})], { sources: { classifier: 'degraded' } }));
  ui.open();
  await flush();
  const notes = byClass(pane, 'inote').filter((n) => !n.hidden);
  assert.equal(notes.length, 1, 'exactly one line');
  assert.equal(notes[0].textContent, 'Some sessions could not be classified.');
  for (const r of byClass(pane, 'irow')) {
    assert.ok(r.textContent.indexOf('classified') === -1, 'the warning is not repeated on any row');
  }
});

// ---- privacy -----------------------------------------------------------------------------------

test('privacy · nothing this story ships carries live-machine identity', () => {
  // Verified with node and a real regex, never the shell grep (a ugrep wrapper that skips gitignored
  // files and produces false all-clears).
  const files = ['public/inbox.js', 'test/p9-inbox-ui.test.js'];
  const banned = [
    [/\/Users\//, 'an absolute home path'],
    [/\/Volumes\//, 'an absolute volume path'],
    [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'a UUID-shaped token'],
  ];
  for (const rel of files) {
    const src = readSrc(rel);
    for (const [re, what] of banned) {
      assert.equal(re.test(src), false, `${rel} must not contain ${what}`);
    }
  }
});

// The `hidden` attribute is the ONLY mechanism this module uses to retract the card, the reply field,
// the notice and the back button. That mechanism is a UA-stylesheet rule (`[hidden]{display:none}`),
// so it is defeated by any author rule that sets `display` on the same element — and the sheet ships
// two of those (`.icard` and `.ifield` are flex columns). The consequence was visible, not academic:
// a card closed after a reply stayed painted, so the previous question sat under "Nothing waiting."
//
// The obvious test — "assert cardEl.hidden === true" — is what let this ship: the attribute was
// always true. So assert the RULE that makes the attribute mean something, and assert it structurally
// so a future `display` rule on a newly hidden element cannot quietly reopen the hole.
test('render · the hidden attribute is enforced against this sheet\'s own display rules', () => {
  const src = SRC.inbox;

  // 1. The reset exists, is scoped to the panel, and is unbeatable by a later `display` rule.
  const reset = /'#inbox \[hidden\]\{display:none !important\}'/.test(src);
  assert.equal(reset, true, 'inbox.js must ship #inbox [hidden]{display:none !important}');

  // 2. Every class retracted via `.hidden` is enumerated from the SOURCE, not restated here — a list
  //    maintained by hand would drift the moment a new hidden element is added.
  const hiddenVars = new Set();
  for (const m of src.matchAll(/(\w+)\.hidden\s*=/g)) hiddenVars.add(m[1]);
  assert.ok(hiddenVars.size >= 5, `expected several hidden-toggled elements, found ${hiddenVars.size}`);

  const classOf = new Map();
  for (const v of hiddenVars) {
    const decl = new RegExp(`(?:const|let|var)\\s+${v}\\s*=\\s*mk\\(\\s*'[^']+'\\s*,\\s*'([^']+)'`).exec(src);
    if (decl) classOf.set(v, decl[1].split(/\s+/)[0]);
  }
  assert.ok(classOf.size >= 5, 'could not resolve the classes of the hidden-toggled elements');

  // 3. Prove the hazard is real for at least one of them — otherwise this test would pass on a sheet
  //    that never had a conflicting rule, and would stop meaning anything.
  const withDisplayRule = [...classOf.values()].filter((cls) =>
    new RegExp(`'#inbox \\.${cls}\\{[^']*display:`).test(src));
  assert.ok(withDisplayRule.length > 0,
    'no hidden-toggled class carries an author display rule — this guard has lost its subject');
});
