'use strict';
// p8 STORY-006 — public/gitbar.js: the view-model that owns every action, and the thin view.
//
// The whole reason this module is split the way it is: `node --test` cannot see a DOM, and the
// dangerous half of a source-control bar is not its pixels. So every guard, every refusal, every
// sequencing rule and the path-identity gate are exercised HERE, against the model, through its
// injected seams — no browser, no server, no git.
//
// Three properties are on trial, and each one has a failure mode that a naive test passes:
//
//   * THE DISPLAY CACHE IS KEYED BY EXACT DIRECTORY. A cache keyed by containment interval also
//     passes "a revisit is free" — and then names the PARENT repo when the operator descends into a
//     nested child repo. So the cache tests assert the nested descent, not only the revisit.
//   * A STALE RESPONSE MUST NEVER OVERWRITE A NEWER ONE. Path comparison alone passes A→B and
//     fails A1→B→A2, where both A responses match the current path. So the sequencing test is the
//     same-path race, and it asserts the generation check INDEPENDENTLY of the abort by resolving
//     the superseded request anyway.
//   * A HIDDEN BAR IS GONE FROM THE MOUNT. `querySelectorAll(...).length === 0` is satisfied by a
//     bar left attached and merely emptied. So the view tests assert the mount's TEXT, which a
//     stale attached bar cannot fake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB_PATH = path.join(__dirname, '..', 'public', 'gitbar.js');
const LIB = require(LIB_PATH);

// ---- seams ------------------------------------------------------------------------------------

const kindOf = (u) =>
  u.indexOf('/gitread/probe') >= 0 ? 'probe' :
  u.indexOf('/gitread/status') >= 0 ? 'status' :
  u.indexOf('/gitread/command') >= 0 ? 'command' : 'other';

const dirOf = (rec) => {
  if (rec.method === 'POST') return rec.body && rec.body.dir;
  const m = /[?&]dir=([^&]*)/.exec(rec.url);
  return m ? decodeURIComponent(m[1]) : null;
};

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ok = (body) => res(200, body);

// A recording network. A route may answer immediately; returning undefined leaves the request
// PENDING so the test can settle it later, in whatever order it likes.
function makeNet(route) {
  const reqs = [];
  const dispatch = (rec) => {
    reqs.push(rec);
    const p = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
    rec.aborted = false;
    if (rec.signal && typeof rec.signal.addEventListener === 'function') {
      rec.signal.addEventListener('abort', () => { rec.aborted = true; });
    }
    const answer = route ? route(rec) : undefined;
    if (answer !== undefined) rec.resolve(answer);
    return p;
  };
  return {
    reqs,
    jget: (url, o) => dispatch({ method: 'GET', url, opts: o, signal: o && o.signal, kind: kindOf(url) }),
    jpost: (url, body) => dispatch({ method: 'POST', url, body, kind: kindOf(url) }),
    of: (kind) => reqs.filter((r) => r.kind === kind),
  };
}

function mk(route, extra) {
  const e = extra || {};
  const net = makeNet(route);
  const fills = [], leaves = [], opens = [], notes = [], pubs = [];
  let clock = 1000;
  const model = LIB.createGitBarModel({
    jget: net.jget,
    jpost: net.jpost,
    machine: e.machine === undefined ? 'm1' : e.machine,
    nowMs: () => clock,
    fillComposer: (t) => { fills.push(t); return e.fill ? e.fill(t) : { ok: true, kind: 'shell' }; },
    leaveFiles: () => { leaves.push(true); },
    openPanel: (o) => { opens.push(o); },
    note: (t) => { notes.push(t); },
  });
  model.subscribe((v) => pubs.push(v));
  return {
    net, model, fills, leaves, opens, notes, pubs,
    tick: (ms) => { clock += ms; },
    last: () => pubs[pubs.length - 1],
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// A minimal document. It implements exactly what the view is allowed to use — createElement,
// textContent, appendChild/removeChild/replaceChildren — and nothing that parses markup, so a view
// that reached for a markup sink would throw here rather than quietly work.
function fakeDom() {
  const created = [];
  const el = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(),
      children: [],
      _text: '',
      className: '',
      onclick: null,
      get textContent() { return n._text + n.children.map((c) => c.textContent).join(''); },
      set textContent(v) { n._text = String(v); n.children.length = 0; },
      appendChild(c) { n.children.push(c); return c; },
      removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c; },
      replaceChildren() { n.children.length = 0; },
      get firstChild() { return n.children[0] || null; },
    };
    created.push(n);
    return n;
  };
  const mount = el('div');
  return { doc: { createElement: el }, mount, created };
}

const walk = (n, out) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
const controls = (mount) => walk(mount, []).filter((n) => typeof n.onclick === 'function');
const labels = (mount) => controls(mount).map((n) => n.textContent);
const tap = (mount, label) => {
  const b = controls(mount).find((n) => n.textContent === label);
  assert.ok(b, `expected a control labelled ${JSON.stringify(label)}, saw ${JSON.stringify(labels(mount))}`);
  b.onclick();
};

// Canonical fixtures. The browsed directory is deliberately NOT the repo toplevel, so any request
// that carried a cached repo path instead of the browsed dir is visible as a wrong value.
const DIR_A = '/w/alpha/src/lib';
const REPO_A = '/w/alpha';
const DIR_B = '/w/beta/pkg';
const REPO_B = '/w/beta';
const probeA = { repo: REPO_A, name: 'alpha', branch: 'main', state: 'branch' };
const probeB = { repo: REPO_B, name: 'beta', branch: 'trunk', state: 'branch' };
const cleanStatus = (repo) => ({ repo, branch: { head: 'main' }, files: [], counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 }, inProgress: { merge: false, rebase: false }, canWrite: true });

// ---- the module contract ----------------------------------------------------------------------

test('the module is requireable under node, exports exactly the two factories plus the marking wording, and requiring it touches no DOM and issues no network call', () => {
  delete require.cache[require.resolve(LIB_PATH)];
  const savedDoc = global.document, savedFetch = global.fetch, savedXhr = global.XMLHttpRequest;
  const touched = [];
  global.document = new Proxy({}, { get(_t, k) { touched.push('document.' + String(k)); throw new Error('the module touched the DOM at require time'); } });
  global.fetch = () => { touched.push('fetch'); throw new Error('the module issued a network call at require time'); };
  global.XMLHttpRequest = function () { touched.push('XMLHttpRequest'); throw new Error('the module issued a network call at require time'); };
  let mod;
  try {
    mod = require(LIB_PATH);
  } finally {
    global.document = savedDoc; global.fetch = savedFetch; global.XMLHttpRequest = savedXhr;
  }
  assert.deepStrictEqual(touched, []);
  // STORY-010 adds ONE value, not a third factory: the marking wording, exported so a test can
  // hold it against gitread.js's copy instead of re-typing a third spelling that agrees with
  // neither. The list stays exact — a fourth export has to be argued for here.
  assert.deepStrictEqual(Object.keys(mod).sort(),
    ['BROWSED_TEXT_MARK', 'createGitBar', 'createGitBarModel']);
  assert.strictEqual(typeof mod.createGitBarModel, 'function');
  assert.strictEqual(typeof mod.createGitBar, 'function');
});

test('the model exposes exactly at/hide/scopeLost/destroy/current/subscribe/tapPull/tapPush/tapSync/tapPanel', () => {
  const m = LIB.createGitBarModel({});
  assert.deepStrictEqual(Object.keys(m).sort(),
    ['at', 'current', 'destroy', 'hide', 'scopeLost', 'subscribe', 'tapPanel', 'tapPull', 'tapPush', 'tapSync']);
  assert.deepStrictEqual(m.current(), { visible: false }, 'a model that has been nowhere shows nothing');
});

// ---- U9: the display cache ----------------------------------------------------------------------

test('U9 cache: a revisit of the same directory within the TTL issues no second request', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  await h.model.at(DIR_A);
  assert.strictEqual(h.net.of('probe').length, 1);
  h.tick(4999);
  await h.model.at(DIR_A);
  assert.strictEqual(h.net.of('probe').length, 1, 'a revisit inside the TTL must be free');
  assert.strictEqual(h.last().repo, REPO_A);
  assert.strictEqual(h.last().visible, true);
});

test('U9 cache: entering a NESTED child repo within the parent TTL probes fresh and publishes the CHILD identity', async () => {
  // The interval-keyed cache v1.1 proposed passes the revisit test above and FAILS this one by
  // naming the parent — which is the bug, not an inefficiency.
  const nestedDir = REPO_A + '/vendor/inner';
  const nested = { repo: nestedDir, name: 'inner', branch: 'wip', state: 'branch' };
  const h = mk((r) => (r.kind === 'probe' ? ok(dirOf(r) === nestedDir ? nested : probeA) : undefined));
  await h.model.at(DIR_A);
  h.tick(10);
  await h.model.at(nestedDir);
  assert.strictEqual(h.net.of('probe').length, 2, 'each NEW directory costs one probe');
  assert.strictEqual(h.last().repo, nestedDir, 'the bar must name the nested repo, not its container');
  assert.strictEqual(h.last().name, 'inner');
  assert.strictEqual(h.last().branch, 'wip');
});

test('U9 cache: after TTL expiry on the injected clock the same directory re-probes', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  await h.model.at(DIR_A);
  h.tick(5000);
  await h.model.at(DIR_A);
  assert.strictEqual(h.net.of('probe').length, 2, 'the entry expires at the TTL, on the injected clock');
});

// ---- U12: sequencing ----------------------------------------------------------------------------

test('U12 sequencing: A1 -> B -> A2 discards the stale SAME-PATH response, aborts its signal, and passes {signal} on every request', async () => {
  const h = mk();                                    // every request stays pending; we settle by hand
  h.model.at(DIR_A);                                 // A1
  h.model.at(DIR_B);                                 // B
  h.model.at(DIR_A);                                 // A2 — same path as A1, newer generation
  const [a1, b, a2] = h.net.reqs;
  assert.strictEqual(h.net.reqs.length, 3);
  for (const r of h.net.reqs) assert.ok(r.signal, 'the model must pass {signal} to jget on every request');

  assert.ok(a1.aborted, 'at() aborts its predecessor for real, not only by ignoring it');
  assert.ok(b.aborted, 'the B probe is aborted by A2');
  assert.ok(!a2.aborted);

  a2.resolve(ok(probeA));
  await settle();
  const pubsAfterA2 = h.pubs.length;
  assert.strictEqual(h.last().repo, REPO_A);
  assert.strictEqual(h.last().branch, 'main');

  // The superseded request answers ANYWAY, with a branch from before a checkout, and its path
  // matches the current path exactly. Path comparison alone would publish it.
  a1.resolve(ok({ repo: REPO_A, name: 'alpha', branch: 'stale-branch', state: 'branch' }));
  b.resolve(ok(probeB));
  await settle();
  assert.strictEqual(h.pubs.length, pubsAfterA2, 'a stale response publishes nothing at all');
  assert.strictEqual(h.last().branch, 'main', 'the newer response is never overwritten by an older one');
  assert.ok(!h.pubs.some((p) => p.branch === 'stale-branch' || p.repo === REPO_B));
});

// ---- U16: invalidating transitions ----------------------------------------------------------------

test('U16 invalidation: a probe pending across hide() publishes nothing and writes no cache entry', async () => {
  const h = mk();
  h.model.at(DIR_A);
  const p1 = h.net.reqs[0];
  h.model.hide();
  assert.ok(p1.aborted, 'hide() aborts the in-flight controller');
  const before = h.pubs.length;
  p1.resolve(ok(probeA));
  await settle();
  assert.strictEqual(h.pubs.length, before, 'no publication may resurrect a bar into a screen with no directory');
  assert.deepStrictEqual(h.model.current(), { visible: false });

  // The cache write is the second half: if hide() let it through, this re-entry would be a hit.
  h.model.at(DIR_A);
  assert.strictEqual(h.net.of('probe').length, 2, 'a response arriving after hide() must not populate the cache');
});

test('U16 invalidation: destroy() aborts the in-flight request and no subscriber fires afterwards', async () => {
  const h = mk();
  h.model.at(DIR_A);
  const p1 = h.net.reqs[0];
  h.model.destroy();
  assert.ok(p1.aborted, 'destroy() aborts the in-flight controller');
  const before = h.pubs.length;
  p1.resolve(ok(probeA));
  await settle();
  assert.strictEqual(h.pubs.length, before, 'destroy() detaches subscribers; nothing is observable after it');
  h.model.at(DIR_A);
  assert.strictEqual(h.net.reqs.length, 1, 'a destroyed model issues no further requests');
});

// ---- U13: rendering safety ------------------------------------------------------------------------

test('U13 XSS: the source of gitbar.js contains no markup-parsing sink', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  // Assembled so this assertion cannot be satisfied by its own text.
  const sinks = ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document.' + 'write', 'createContextual' + 'Fragment'];
  for (const s of sinks) assert.strictEqual(src.indexOf(s), -1, `gitbar.js must contain no ${s}`);
  assert.ok(src.indexOf('textContent') > 0, 'and it must actually use the safe sink');
});

const HOSTILE_BRANCH = '<img/src=x/onerror=window.p8RepoXss=1>';   // slashes are legal in refs
const HOSTILE_NAME = '<svg onload=window.p8RepoXss=1>';            // no slash: legal as a directory name

test('U13 XSS: hostile repo and branch strings pass through the view-model byte-identical', async () => {
  const hostile = { repo: '/w/' + HOSTILE_NAME, name: HOSTILE_NAME, branch: HOSTILE_BRANCH, state: 'branch' };
  const h = mk((r) => (r.kind === 'probe' ? ok(hostile) : undefined));
  await h.model.at(DIR_A);
  assert.strictEqual(h.last().name, HOSTILE_NAME, 'the model neither escapes nor mangles; it carries the bytes');
  assert.strictEqual(h.last().branch, HOSTILE_BRANCH);
  assert.strictEqual(h.model.current().repo, '/w/' + HOSTILE_NAME);
});

test('U13 XSS: the view renders hostile strings as TEXT, creating no element the payload names', async () => {
  const hostile = { repo: '/w/' + HOSTILE_NAME, name: HOSTILE_NAME, branch: HOSTILE_BRANCH, state: 'branch' };
  const h = mk((r) => (r.kind === 'probe' ? ok(hostile) : undefined));
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  const text = d.mount.textContent;
  assert.ok(text.indexOf(HOSTILE_NAME) >= 0, 'the literal text is shown');
  assert.ok(text.indexOf(HOSTILE_BRANCH) >= 0);
  const tags = d.created.map((n) => n.tagName);
  for (const bad of ['IMG', 'SVG', 'SCRIPT', 'IFRAME']) {
    assert.strictEqual(tags.indexOf(bad), -1, `the payload must not become a ${bad} element`);
  }
  const leaf = walk(d.mount, []).find((n) => n._text === HOSTILE_BRANCH);
  assert.ok(leaf && leaf.children.length === 0, 'the hostile ref lives in one text-only node');
});

// ---- visibility (§7) --------------------------------------------------------------------------------

test("visibility: state 'branch' offers pull, push, sync and the panel door", async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  assert.deepStrictEqual(labels(d.mount), ['↓↻', '↑', '✓', '›']);
  assert.ok(d.mount.textContent.indexOf('alpha') >= 0 && d.mount.textContent.indexOf('main') >= 0);
});

test("visibility: 'unborn' and 'detached' hide pull and push while keeping sync and the door", async () => {
  for (const [state, branch, expectText] of [['unborn', 'main', 'unborn'], ['detached', null, 'detached']]) {
    const h = mk((r) => (r.kind === 'probe' ? ok({ repo: REPO_A, name: 'alpha', branch, state }) : undefined));
    const d = fakeDom();
    LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
    await h.model.at(DIR_A);
    assert.strictEqual(h.last().visible, true, `${state} shows a bar — the first commit is the point`);
    assert.deepStrictEqual(labels(d.mount), ['✓', '›'], `${state} must not offer push or pull`);
    assert.ok(d.mount.textContent.indexOf(expectText) >= 0);
  }
});

test('visibility: tapPull and tapPush issue ZERO requests when the state is not a branch', async () => {
  for (const state of ['unborn', 'detached']) {
    const h = mk((r) => (r.kind === 'probe' ? ok({ repo: REPO_A, name: 'alpha', branch: 'main', state }) : undefined));
    await h.model.at(DIR_A);
    await h.model.tapPull();
    await h.model.tapPush();
    assert.strictEqual(h.net.of('command').length, 0, `${state}: the guard lives in the model, not only in the pixels`);
  }
});

test('visibility: {repo:null} and a 503 probe_busy each hide the bar entirely — its text is GONE from the mount', async () => {
  // The count oracle this replaces: querySelectorAll(...).length === 0 is satisfied by a bar that
  // was left attached and merely emptied. The mount's own text cannot be faked that way.
  for (const answer of [ok({ repo: null }), res(503, { error: 'probe_busy' }), res(500, { error: 'boom' })]) {
    let n = 0;
    const h = mk((r) => (r.kind === 'probe' ? (++n === 1 ? ok(probeA) : answer) : undefined));
    const d = fakeDom();
    LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
    await h.model.at(DIR_A);
    assert.ok(d.mount.textContent.indexOf('alpha') >= 0, 'precondition: the bar was really rendered first');
    h.tick(10);
    await h.model.at(DIR_B);
    assert.strictEqual(h.last().visible, false);
    assert.strictEqual(d.mount.textContent, '', 'a hidden bar leaves no text in the mount');
    assert.deepStrictEqual(controls(d.mount), [], 'and no live control behind it');
  }
});

test('visibility: a NON-OK probe is never rendered, even when its body carries a complete payload', async () => {
  // The status code governs, not the body's shape. A relay or an intermediary that answers 503 with
  // a stale-but-complete payload must not paint a bar; without an explicit r.ok check the body alone
  // looks perfectly renderable, which is exactly how a cached error page becomes a source of truth.
  let n = 0;
  const h = mk((r) => (r.kind === 'probe' ? (++n === 1 ? ok(probeA) : res(503, probeB)) : undefined));
  await h.model.at(DIR_A);
  h.tick(10);
  await h.model.at(DIR_B);
  assert.strictEqual(h.last().visible, false, 'a 503 hides the bar whatever it happens to carry');
  assert.ok(!h.pubs.some((p) => p.repo === REPO_B));
});

test('visibility: a probe failing at the transport hides the bar and never publishes a stale identity', async () => {
  let n = 0;
  const h = mk((r) => { if (r.kind !== 'probe') return undefined; return ++n === 1 ? ok(probeA) : undefined; });
  await h.model.at(DIR_A);
  h.tick(10);
  const p = h.model.at(DIR_B);
  h.net.of('probe')[1].reject(new Error('network down'));
  await p;
  assert.strictEqual(h.last().visible, false, 'a git problem must not degrade browsing, and must not lie either');
});

// ---- every request carries the browsed dir (§5.4) ------------------------------------------------

test('every probe, status and command request carries the CURRENT browsed dir, never a repo path from the cache', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'status') return ok(cleanStatus(REPO_A));
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha commit', repo: REPO_A, name: 'alpha' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  await h.model.tapSync('hello');
  await h.model.tapPanel();
  assert.ok(h.net.reqs.length >= 5);
  for (const r of h.net.reqs) {
    assert.strictEqual(dirOf(r), DIR_A, `${r.kind} must send the browsed dir`);
    assert.notStrictEqual(dirOf(r), REPO_A, 'the display cache is display-only: no action consumes it');
  }
  for (const r of h.net.reqs) {
    assert.ok(r.url.indexOf('machine=m1') >= 0, 'every request is addressed to the machine seam');
    assert.ok(r.url.indexOf('/api/cmux/gitread/') === 0, 'p8 talks only to its own routes');
  }
});

// ---- tapSync: the local refusal and the guard ------------------------------------------------------

test('an empty or whitespace-only commit message is refused locally with NO request and no fill', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  await h.model.at(DIR_A);
  const before = h.net.reqs.length;
  await h.model.tapSync('');
  await h.model.tapSync('   \t\n ');
  assert.strictEqual(h.net.reqs.length, before, 'the courtesy check costs no request');
  assert.strictEqual(h.fills.length, 0);
  assert.ok(h.notes.some((t) => /empty/.test(t)), 'and it says why');
});

test('tapSync fetches status EXACTLY ONCE and refuses on the §6.2 predicate, filling nothing', async () => {
  const blocked = [
    ['unmerged paths', { unmerged: 2 }, { merge: false, rebase: false }],
    ['merge in progress', { unmerged: 0 }, { merge: true, rebase: false }],
    ['rebase in progress', { unmerged: 0 }, { merge: false, rebase: true }],
  ];
  for (const [reason, counts, inProgress] of blocked) {
    const h = mk((r) => {
      if (r.kind === 'probe') return ok(probeA);
      if (r.kind === 'status') return ok(Object.assign(cleanStatus(REPO_A), { counts: Object.assign({ staged: 0, unstaged: 0, untracked: 0 }, counts), inProgress }));
      return undefined;
    });
    await h.model.at(DIR_A);
    await h.model.tapSync('a message');
    assert.strictEqual(h.net.of('status').length, 1, 'exactly one status read per tap');
    assert.strictEqual(h.net.of('command').length, 0, 'a blocked sync issues no /command POST');
    assert.strictEqual(h.fills.length, 0);
    assert.ok(h.notes.some((t) => t.indexOf(reason) >= 0), `the reason must name ${reason}, saw ${JSON.stringify(h.notes)}`);
    assert.strictEqual(h.last().visible, true, 'a refusal is not a failure: the bar stays');
  }
});

test('an unreadable status is a BLOCKED status — add -A && commit is not a thing to do on a guess', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'status') return ok({ repo: REPO_A });          // no counts, no inProgress
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapSync('a message');
  assert.strictEqual(h.net.of('command').length, 0);
  assert.strictEqual(h.fills.length, 0);
  assert.ok(h.notes.some((t) => /unreadable/.test(t)));
});

test('a clean status proceeds to exactly one /command POST carrying verb sync and the message', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'status') return ok(cleanStatus(REPO_A));
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha add -A', repo: REPO_A, name: 'alpha' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapSync('  ship it  ');
  const posts = h.net.of('command');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.verb, 'sync');
  assert.strictEqual(posts[0].body.dir, DIR_A);
  assert.strictEqual(posts[0].body.params.message, '  ship it  ', 'the message is sent as typed; trimming is the server\'s rule');
  assert.deepStrictEqual(h.fills, ['git -C /w/alpha add -A']);
  assert.strictEqual(h.leaves.length, 1);
});

// ---- push / pull -------------------------------------------------------------------------------------

test('push and pull send NO branch param — the ref is derived server-side from HEAD', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha push origin -- main', repo: REPO_A, name: 'alpha' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  await h.model.tapPull();
  const posts = h.net.of('command');
  assert.deepStrictEqual(posts.map((p) => p.body.verb), ['push', 'pull-rebase']);
  for (const p of posts) {
    assert.deepStrictEqual(Object.keys(p.body.params), [], 'a client-supplied branch is a client-supplied option');
    assert.ok(!('branch' in p.body.params));
  }
});

test('a 409 not_on_branch refreshes the bar instead of leaving stale controls armed', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(++probes === 1 ? probeA : { repo: REPO_A, name: 'alpha', branch: null, state: 'detached' });
    if (r.kind === 'command') return res(409, { error: 'not_on_branch' });
    return undefined;
  });
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  assert.deepStrictEqual(labels(d.mount), ['↓↻', '↑', '✓', '›']);
  await h.model.tapPush();
  await settle();
  assert.strictEqual(h.fills.length, 0, 'a refusal fills nothing');
  assert.strictEqual(probes, 2, 'exactly one refresh probe');
  assert.strictEqual(h.last().state, 'detached');
  assert.deepStrictEqual(labels(d.mount), ['✓', '›'], 'the stale push/pull controls are gone');
  assert.ok(h.notes.some((t) => /not_on_branch/.test(t)));
});

// ---- U18 (client, /command): the path-identity gate ----------------------------------------------------

test('U18 /command: a response naming B terminates the action, evicts, and re-renders from EXACTLY ONE fresh probe', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(++probes === 1 ? probeA : probeB);
    if (r.kind === 'command') return ok({ text: 'git -C /w/beta push origin -- trunk', repo: REPO_B, name: 'beta' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  await settle();
  assert.strictEqual(h.fills.length, 0, 'zero fills: the text names a repo the operator is not standing in');
  assert.strictEqual(h.leaves.length, 0);
  assert.strictEqual(h.net.of('command').length, 1, 'the action terminates — no further action request');
  assert.strictEqual(probes, 2, 'exactly one fresh cache-bypassing probe');
  assert.strictEqual(dirOf(h.net.of('probe')[1]), DIR_A, 'the repair probe asks about the browsed dir');
  const v = h.last();
  assert.deepStrictEqual([v.visible, v.repo, v.name, v.branch, v.state], [true, REPO_B, 'beta', 'trunk', 'branch'],
    'the bar renders the probe\'s COMPLETE state');
  assert.ok(v.note && /different repository/.test(v.note));
});

test('U18 /command: the eviction is real — the pre-mismatch entry cannot serve a later revisit', async () => {
  // The oracle: make the REPAIR probe answer {repo:null}, so it writes nothing. If the mismatch had
  // not evicted, the original A entry would still be inside its TTL and the revisit below would be
  // a free cache hit that re-displays a repo the server has already contradicted.
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(++probes === 1 ? probeA : { repo: null });
    if (r.kind === 'command') return ok({ text: 't', repo: REPO_B, name: 'beta' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  await settle();
  assert.strictEqual(probes, 2);
  assert.strictEqual(h.last().visible, false);
  h.tick(1);                                  // still well inside the TTL of the ORIGINAL entry
  await h.model.at(DIR_A);
  assert.strictEqual(probes, 3, 'the evicted entry cannot serve the revisit');
  assert.strictEqual(h.last().visible, false);
});

test('U18 /command: the eviction is not contingent on the repair probe ever landing', async () => {
  // The mismatch itself must evict, at once. If eviction were left to the repair probe's own
  // response handling, a probe that never lands — superseded by the operator navigating away and
  // back — would leave the contradicted entry alive inside its TTL, and the next visit would serve
  // a repo the server has already said is not there, with no request at all.
  const h = mk((r) => {
    if (r.kind === 'probe') return undefined;                 // every probe stays PENDING
    if (r.kind === 'command') return ok({ text: 't', repo: REPO_B, name: 'beta' });
    return undefined;
  });
  h.model.at(DIR_A);
  h.net.of('probe')[0].resolve(ok(probeA));
  await settle();
  assert.strictEqual(h.last().repo, REPO_A);
  h.model.tapPush();                                          // NOT awaited: its repair probe never lands
  await settle();
  assert.strictEqual(h.net.of('probe').length, 2, 'the repair probe was issued');
  h.model.hide();                                             // it is now superseded and will never land
  h.tick(1);                                                  // still deep inside the original TTL
  h.model.at(DIR_A);
  assert.strictEqual(h.net.of('probe').length, 3, 'the contradicted entry is gone: this revisit must probe');
  for (const p of h.net.of('probe')) p.resolve(ok({ repo: null }));   // leave nothing dangling
  await settle();
});

test('U18 /command: a matching response fills exactly once and leaves Files exactly once', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha pull --rebase', repo: REPO_A, name: 'alpha' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapPull();
  assert.deepStrictEqual(h.fills, ['git -C /w/alpha pull --rebase']);
  assert.strictEqual(h.leaves.length, 1, 'a fill the operator cannot see is a fill they will repeat');
  assert.strictEqual(h.net.of('probe').length, 1, 'a match costs no repair probe');
});

test('U18 /command: a fill failure stays in Files, calls leaveFiles ZERO times, and surfaces the reason', async () => {
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha push', repo: REPO_A, name: 'alpha' });
    return undefined;
  }, { fill: () => ({ ok: false, reason: 'that pane is not accepting commands (pager)' }) });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  assert.strictEqual(h.fills.length, 1);
  assert.strictEqual(h.leaves.length, 0, 'fill failure is a real state, not an exception');
  assert.ok(h.notes.some((t) => /pager/.test(t)), JSON.stringify(h.notes));
  assert.strictEqual(h.last().visible, true, 'and the bar stays put');
});

test('U18 /command: a 403 hides the bar, evicts, and issues NO probe', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') { probes++; return ok(probeA); }
    if (r.kind === 'command') return res(403, { error: 'unknown_repo' });
    return undefined;
  });
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  await h.model.tapPush();
  await settle();
  assert.strictEqual(h.last().visible, false, 'the repo left scope; hiding IS the rendering');
  assert.strictEqual(d.mount.textContent, '');
  assert.strictEqual(probes, 1, 'a 403 needs no probe — it would answer {repo:null} and hide it again');
  assert.strictEqual(h.fills.length, 0);
  h.tick(1);
  await h.model.at(DIR_A);
  assert.strictEqual(probes, 2, 'the cache entry was evicted, so the revisit is not free');
});

// ---- U18 (client, tapSync status step) ------------------------------------------------------------

test('U18 tapSync: a status naming B — CLEAN B — yields zero POSTs, zero fills, eviction and one fresh probe', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(++probes === 1 ? probeA : probeB);
    if (r.kind === 'status') return ok(cleanStatus(REPO_B));       // clean: the guard would PASS
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapSync('a message');
  await settle();
  assert.strictEqual(h.net.of('command').length, 0, 'the gate runs BEFORE the guard fields are read');
  assert.strictEqual(h.fills.length, 0);
  assert.strictEqual(probes, 2);
  assert.strictEqual(h.last().repo, REPO_B);
  assert.strictEqual(h.last().state, 'branch');
});

test('U18 tapSync: a status naming B — BLOCKED B — takes the same path, not the guard-refusal path', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(++probes === 1 ? probeA : probeB);
    if (r.kind === 'status') return ok(Object.assign(cleanStatus(REPO_B), { counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 3 } }));
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapSync('a message');
  await settle();
  assert.strictEqual(h.net.of('command').length, 0);
  assert.strictEqual(h.fills.length, 0);
  assert.strictEqual(probes, 2, 'the identity repair happens, not a guard refusal on another repo\'s counts');
  assert.strictEqual(h.last().repo, REPO_B);
  assert.ok(h.notes.some((t) => /different repository/.test(t)), JSON.stringify(h.notes));
  assert.ok(!h.notes.some((t) => /unmerged/.test(t)), 'B\'s counts are never interpreted');
});

test('U18 tapSync: a 403 at the status fetch hides and evicts with no probe', async () => {
  let probes = 0;
  const h = mk((r) => {
    if (r.kind === 'probe') { probes++; return ok(probeA); }
    if (r.kind === 'status') return res(403, { error: 'unknown_repo' });
    return undefined;
  });
  await h.model.at(DIR_A);
  await h.model.tapSync('a message');
  await settle();
  assert.strictEqual(h.last().visible, false);
  assert.strictEqual(probes, 1);
  assert.strictEqual(h.net.of('command').length, 0);
  assert.strictEqual(h.fills.length, 0);
});

// ---- U18 (client, tapPanel) -----------------------------------------------------------------------

test('U18 tapPanel: the door probes fresh even when the display cache is WARM', async () => {
  let probes = 0;
  const h = mk((r) => (r.kind === 'probe' ? (probes++, ok(probeA)) : undefined));
  await h.model.at(DIR_A);
  h.tick(1);
  await h.model.at(DIR_A);                    // warm: no probe
  assert.strictEqual(probes, 1);
  await h.model.tapPanel();
  assert.strictEqual(probes, 2, 'the panel door never trusts the display cache');
  assert.strictEqual(dirOf(h.net.of('probe')[1]), DIR_A);
  assert.strictEqual(h.opens.length, 1);
});

test('U18 tapPanel: a probe naming B opens nothing and renders from THAT probe with no second request', async () => {
  let probes = 0;
  const h = mk((r) => (r.kind === 'probe' ? ok(++probes === 1 ? probeA : probeB) : undefined));
  await h.model.at(DIR_A);
  await h.model.tapPanel();
  await settle();
  assert.strictEqual(h.opens.length, 0, 'the panel must never open on an identity the server did not just confirm');
  assert.strictEqual(probes, 2, 'the door\'s own probe IS the render source — no second request');
  const v = h.last();
  assert.deepStrictEqual([v.repo, v.name, v.branch, v.state], [REPO_B, 'beta', 'trunk', 'branch']);
  assert.ok(v.note && /did not open/.test(v.note));
});

test('U18 tapPanel: a matching probe opens the panel exactly once with the RESPONSE identity, not the cached one', async () => {
  // The cached name is deliberately stale: the response's name is what must reach openPanel.
  let probes = 0;
  const h = mk((r) => (r.kind === 'probe' ? ok(++probes === 1
    ? { repo: REPO_A, name: 'stale-name', branch: 'main', state: 'branch' }
    : { repo: REPO_A, name: 'fresh-name', branch: 'main', state: 'branch' }) : undefined));
  await h.model.at(DIR_A);
  assert.strictEqual(h.last().name, 'stale-name');
  await h.model.tapPanel();
  assert.deepStrictEqual(h.opens, [{ repo: REPO_A, name: 'fresh-name', src: 'read' }]);
  assert.strictEqual(h.last().name, 'fresh-name', 'and the bar adopts what the server just resolved');
});

test('U18 tapPanel: a 503 probe_busy opens nothing, KEEPS the bar, and says why', async () => {
  let probes = 0;
  const h = mk((r) => (r.kind === 'probe' ? (++probes === 1 ? ok(probeA) : res(503, { error: 'probe_busy' })) : undefined));
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  await h.model.tapPanel();
  await settle();
  assert.strictEqual(h.opens.length, 0);
  assert.strictEqual(h.last().visible, true, 'best-effort display degrades to no panel, not to no bar');
  assert.ok(d.mount.textContent.indexOf('alpha') >= 0);
  assert.strictEqual(probes, 2, 'and it does not retry');
  assert.ok(h.notes.some((t) => /probe_busy/.test(t)), JSON.stringify(h.notes));
});

test('U18 tapPanel: a probe answering {repo:null} hides the bar and opens nothing', async () => {
  let probes = 0;
  const h = mk((r) => (r.kind === 'probe' ? ok(++probes === 1 ? probeA : { repo: null }) : undefined));
  await h.model.at(DIR_A);
  await h.model.tapPanel();
  await settle();
  assert.strictEqual(h.opens.length, 0);
  assert.strictEqual(h.last().visible, false);
  assert.strictEqual(probes, 2, 'the door\'s probe is the render source here too');
});

// ---- actions are inert without a visible bar ---------------------------------------------------------

test('no action issues a request while the bar is hidden', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok({ repo: null }) : undefined));
  await h.model.at(DIR_A);
  assert.strictEqual(h.last().visible, false);
  const before = h.net.reqs.length;
  await h.model.tapPull();
  await h.model.tapPush();
  await h.model.tapSync('x');
  await h.model.tapPanel();
  assert.strictEqual(h.net.reqs.length, before, 'there is no identity to act on');
  assert.strictEqual(h.fills.length, 0);
  assert.strictEqual(h.opens.length, 0);
});

// ---- the view --------------------------------------------------------------------------------------

test('the view is thin: it subscribes, renders and wires taps — and it holds no state the model owns', async () => {
  const seen = [];
  const h = mk((r) => {
    if (r.kind === 'probe') return ok(probeA);
    if (r.kind === 'status') return ok(cleanStatus(REPO_A));
    if (r.kind === 'command') return ok({ text: 'git -C /w/alpha add -A && git -C /w/alpha commit -m x', repo: REPO_A, name: 'alpha' });
    return undefined;
  });
  const d = fakeDom();
  const view = LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);

  tap(d.mount, '✓');                                   // opens the commit row — model state, not view state
  assert.strictEqual(h.model.current().syncOpen, true);
  const input = walk(d.mount, []).find((n) => n.tagName === 'INPUT');
  assert.ok(input, 'the commit row carries a message field');
  input.value = 'a real message';
  tap(d.mount, 'Commit');
  await settle();
  assert.deepStrictEqual(h.net.of('command').map((p) => p.body.params.message), ['a real message']);
  assert.strictEqual(h.model.current().syncOpen, false, 'a successful fill closes the row');
  seen.push(1);

  view.destroy();
  assert.strictEqual(d.mount.textContent, '', 'destroying the view empties its mount');
  const before = h.pubs.length;
  await h.model.at(DIR_B);
  assert.ok(h.pubs.length > before, 'the model still lives; only this view stopped listening');
  assert.strictEqual(d.mount.textContent, '', 'and nothing repaints into the detached mount');
  assert.deepStrictEqual(seen, [1]);
});

test('the × control closes the commit row without issuing a request', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  tap(d.mount, '✓');
  const before = h.net.reqs.length;
  assert.ok(labels(d.mount).indexOf('Commit') >= 0);
  tap(d.mount, '×');
  assert.strictEqual(h.model.current().syncOpen, false);
  assert.strictEqual(labels(d.mount).indexOf('Commit'), -1, 'the row is gone');
  assert.strictEqual(h.net.reqs.length, before, 'closing a row is not a network event');
});

test('navigating to a new directory closes the commit row and drops the previous note', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(dirOf(r) === DIR_B ? probeB : probeA) : undefined));
  await h.model.at(DIR_A);
  await h.model.tapSync('');                          // sets a note, opens nothing
  await h.model.tapSync();                            // opens the row
  assert.strictEqual(h.model.current().syncOpen, true);
  h.tick(10);
  await h.model.at(DIR_B);
  assert.strictEqual(h.model.current().syncOpen, false);
  assert.strictEqual(h.model.current().note, null, 'a note belongs to the directory that produced it');
});

test('the view preserves a half-typed commit message across an unrelated republication', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  const d = fakeDom();
  LIB.createGitBar({ model: h.model, doc: d.doc, mount: d.mount });
  await h.model.at(DIR_A);
  tap(d.mount, '✓');
  walk(d.mount, []).find((n) => n.tagName === 'INPUT').value = 'half typed';
  await h.model.tapPanel();                           // republishes (fresh probe, same identity)
  await settle();
  const input = walk(d.mount, []).find((n) => n.tagName === 'INPUT');
  assert.ok(input, 'the row is still open');
  assert.strictEqual(input.value, 'half typed', 'a repaint must not eat the draft');
});

test('subscribe delivers the current state immediately and returns a working unsubscribe', async () => {
  const h = mk((r) => (r.kind === 'probe' ? ok(probeA) : undefined));
  const got = [];
  const off = h.model.subscribe((v) => got.push(v));
  assert.deepStrictEqual(got, [{ visible: false }], 'a late subscriber is not left blank until the next event');
  await h.model.at(DIR_A);
  assert.ok(got.length > 1);
  const n = got.length;
  off();
  h.tick(10);
  await h.model.at(DIR_B);
  assert.strictEqual(got.length, n);
});
