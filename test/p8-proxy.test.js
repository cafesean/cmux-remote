'use strict';
// p8 STORY-001 — the additive /api/cmux/gitread/ proxy block, proven against a REAL server.js
// child and a recording stub bridge. Two contracts are on trial here:
//
//   * the p8 block's own: dir-keyed reads, key-by-key command rebuild, unknown subs 404 at the
//     proxy, and the probe relay propagating a genuine client disconnect upstream — observed on
//     `res` with !writableEnded, never on `req` (a completed bodyless GET fires req 'close' with
//     the response still pending, and a relay wired there would abort every normal probe);
//   * the p7 block's, byte-identical in behaviour: its query keys, its body rebuilds.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootServer, call } = require('./helpers/server-boot');
const { bootBridge } = require('./helpers/bridge-child');
const { g } = require('./helpers/git-fixture');

// A recording upstream that plays the bridge. Every request is logged {method, path, body};
// paths matching `hold` are left OPEN (no response) and expose abort observation.
function bootStub() {
  const seen = [];
  const held = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rec = { method: req.method, path: req.url, body: body || null, aborted: false };
      seen.push(rec);
      if (held.some((h) => req.url.startsWith(h))) {
        // Held open: the test watches for the proxy-side abort arriving as a SOCKET close before
        // any response was written. Not req 'close' — that fires here the moment the bodyless GET's
        // message completes (the very Node ≥16 semantics this feature exists to avoid), which would
        // mark every held request aborted while its caller is still connected.
        req.socket.once('close', () => { rec.aborted = true; });
        return; // never respond
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: req.url }));
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => {
      resolve({
        stub,
        seen,
        hold: (prefix) => held.push(prefix),
        unhold: () => { held.length = 0; },
        base: `http://127.0.0.1:${stub.address().port}`,
        close: () => new Promise((r) => { stub.closeAllConnections(); stub.close(() => r()); }),
      });
    });
  });
}

const waitFor = async (fn, ms = 5000, step = 25) => {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, step));
  }
};

test('p8 proxy: the additive /api/cmux/gitread/ block', async (t) => {
  const up = await bootStub();
  const srv = await bootServer({ env: { CMUX_MACHINE_URL: up.base, CMUX_MACHINE_SECRET: 's3', CMUX_MACHINE_LABEL: 'stub' } });
  t.after(async () => { await srv.stop(); await up.close(); });

  await t.test('GET reads reach the stub dir-keyed; diff carries dir, path and staged', async () => {
    for (const sub of ['probe', 'status', 'branches', 'worktrees']) {
      up.seen.length = 0;
      const r = await call(srv.base, 'GET', `/api/cmux/gitread/${sub}?machine=default&dir=%2Ftmp%2Frepo`);
      assert.equal(r.status, 200, `${sub} relays`);
      assert.equal(up.seen.length, 1, `${sub} reached the stub once`);
      assert.equal(up.seen[0].path, `/cmux/gitread/${sub}?dir=%2Ftmp%2Frepo`);
    }
    up.seen.length = 0;
    const r = await call(srv.base, 'GET', '/api/cmux/gitread/diff?machine=default&dir=%2Ftmp%2Frepo&path=a.txt&staged=1');
    assert.equal(r.status, 200);
    assert.equal(up.seen[0].path, '/cmux/gitread/diff?dir=%2Ftmp%2Frepo&path=a.txt&staged=1');
  });

  await t.test('unknown gitread sub 404s at the proxy without contacting the stub', async () => {
    up.seen.length = 0;
    const r = await call(srv.base, 'GET', '/api/cmux/gitread/repos?machine=default');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not_found' });
    const w = await call(srv.base, 'POST', '/api/cmux/gitread/stage?machine=default', { body: { repo: 'x', paths: ['a'] } });
    assert.equal(w.status, 404, 'no p8 write route exists');
    assert.equal(up.seen.length, 0, 'the stub never heard about either');
  });

  await t.test('POST command is rebuilt key by key, dir included, nothing extra', async () => {
    up.seen.length = 0;
    const r = await call(srv.base, 'POST', '/api/cmux/gitread/command?machine=default',
      { body: { verb: 'sync', dir: '/tmp/repo', params: { message: 'm' }, evil: 'smuggled', repo: '/x' } });
    assert.equal(r.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].path, '/cmux/gitread/command');
    assert.deepEqual(JSON.parse(up.seen[0].body), { verb: 'sync', dir: '/tmp/repo', params: { message: 'm' } },
      'exactly {verb, dir, params} — no spread, no smuggled keys');
  });

  await t.test('probe abort propagation: a genuine client disconnect reaches the stub; a connected caller does not abort', async () => {
    up.hold('/cmux/gitread/probe');

    // Control first: a CONNECTED caller's upstream request must stay open. If the relay had been
    // wired to req 'close' — which a completed GET fires immediately — this window would abort.
    up.seen.length = 0;
    const ctrlConnected = new AbortController();
    const pending = fetch(`${srv.base}/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fheld`,
      { signal: ctrlConnected.signal }).catch(() => null);
    assert.ok(await waitFor(() => up.seen.length === 1), 'held probe reached the stub');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(up.seen[0].aborted, false, 'connected caller: upstream still open after the request message completed');

    // Now the genuine disconnect: the client leaves, the upstream must observe the abort.
    ctrlConnected.abort();
    assert.ok(await waitFor(() => up.seen[0].aborted === true), 'disconnect propagated upstream');
    await pending;
    up.unhold();
  });

  await t.test('settlement symmetry: normal completions retain nothing observable', async () => {
    // The relay's `finally` removes the res listener and clears the timer on every settlement.
    // From outside the child that is observable as: repeated normal probes all answer, and the
    // child emits no listener-leak warning on stderr.
    up.seen.length = 0;
    for (let i = 0; i < 5; i++) {
      const r = await call(srv.base, 'GET', `/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fok${i}`);
      assert.equal(r.status, 200);
    }
    assert.ok(!/MaxListenersExceededWarning/.test(srv.stderr()), 'no listener accumulation across settlements');
  });

  await t.test('upstream failure: probe answers exactly one 502 bridge_unreachable', async () => {
    const dead = await bootServer({ env: { CMUX_MACHINE_URL: 'http://127.0.0.1:9', CMUX_MACHINE_SECRET: 's3' } });
    try {
      const r = await call(dead.base, 'GET', '/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fx');
      assert.equal(r.status, 502);
      assert.deepEqual(r.json, { error: 'bridge_unreachable' });
      assert.ok(dead.alive(), 'one clean 502 — the server did not die on the rejection');
    } finally { await dead.stop(); }
  });

  await t.test('timeout settlement (v3.3): the timeout-fired abort runs for real through the env seam', async () => {
    const up2 = await bootStub();
    up2.hold('/cmux/gitread/probe');
    const short = await bootServer({ env: {
      CMUX_MACHINE_URL: up2.base, CMUX_MACHINE_SECRET: 's3', GITREAD_PROBE_TIMEOUT_MS: '400',
    } });
    try {
      const t0 = Date.now();
      const r = await call(short.base, 'GET', '/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fheld');
      assert.equal(r.status, 502, 'exactly one 502 on the timeout settlement');
      assert.deepEqual(r.json, { error: 'bridge_unreachable' });
      assert.ok(Date.now() - t0 < 5000, 'the short env-seam timeout fired, not the 25s default');
      assert.ok(await waitFor(() => up2.seen[0] && up2.seen[0].aborted === true), 'the stub observed the upstream socket close');
      assert.ok(short.alive(), 'the child keeps serving');
      const ok = await call(short.base, 'GET', '/api/cmux/machines');
      assert.equal(ok.status, 200);
    } finally { await short.stop(); await up2.close(); }
  });

  await t.test('a NON-NUMERIC timeout knob falls back to the default instead of aborting every probe', async () => {
    // `Number('fast')` is NaN and `setTimeout(fn, NaN)` fires on the NEXT TICK, so an unvalidated
    // knob turns a typo in the env into a 502 on every probe — the failure mode of a debugging aid
    // that only ever bites in production. Each arm boots its own child, because the knob is read
    // per request from that child's env.
    for (const bad of ['fast', '', '0', '-1', 'NaN', '25s']) {
      const up3 = await bootStub();
      const child = await bootServer({ env: {
        CMUX_MACHINE_URL: up3.base, CMUX_MACHINE_SECRET: 's3', GITREAD_PROBE_TIMEOUT_MS: bad,
      } });
      try {
        const t0 = Date.now();
        const r = await call(child.base, 'GET', '/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fx');
        assert.equal(r.status, 200, `knob ${JSON.stringify(bad)}: the probe relays normally`);
        assert.equal(up3.seen.length, 1, `knob ${JSON.stringify(bad)}: it really reached the stub`);
        assert.ok(Date.now() - t0 < 5000, `knob ${JSON.stringify(bad)}: and it was not aborted`);
      } finally { await child.stop(); await up3.close(); }
    }
    // Non-vacuous: a VALID knob is still honoured — the fallback did not swallow the seam. Proven
    // by the held-request arm above, and again here on the value the timeout test uses.
    const up4 = await bootStub();
    up4.hold('/cmux/gitread/probe');
    const short = await bootServer({ env: {
      CMUX_MACHINE_URL: up4.base, CMUX_MACHINE_SECRET: 's3', GITREAD_PROBE_TIMEOUT_MS: '400',
    } });
    try {
      const t0 = Date.now();
      const r = await call(short.base, 'GET', '/api/cmux/gitread/probe?machine=default&dir=%2Ftmp%2Fheld');
      assert.equal(r.status, 502, 'a valid short knob still fires');
      assert.ok(Date.now() - t0 < 5000, 'and fires at ITS bound, not the 25 s default');
    } finally { await short.stop(); await up4.close(); }
  });

  await t.test('source-structure (v3.3): the probe relay names its close handler and cleans up in finally', async () => {
    const src = await require('fs/promises').readFile(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const block = src.slice(src.indexOf("'/api/cmux/gitread/'"));
    assert.ok(/const onResClose = /.test(block), 'a NAMED close handler');
    assert.ok(/res\.on\('close', onResClose\)/.test(block), 'wired to res, never req');
    const fin = block.slice(block.indexOf('finally'), block.indexOf('finally') + 200);
    assert.ok(/clearTimeout\(timer\)/.test(fin), 'finally clears the timer');
    assert.ok(/res\.removeListener\('close', onResClose\)/.test(fin), 'finally removes the listener');
    assert.ok(!/req\.on\('close'/.test(block.slice(0, block.indexOf('POST'))), 'no req-close wiring in the probe relay');
  });

  await t.test('p7 block regression: query keys and body rebuilds are untouched', async () => {
    for (const sub of ['repos', 'status', 'branches', 'worktrees']) {
      up.seen.length = 0;
      const r = await call(srv.base, 'GET', `/api/cmux/git/${sub}?machine=default&repo=%2Ftmp%2Frepo&dir=%2Fsmuggle`);
      assert.equal(r.status, 200);
      const q = up.seen[0].path.split('?')[1] || '';
      assert.equal(q, sub === 'repos' ? 'repo=%2Ftmp%2Frepo' : 'repo=%2Ftmp%2Frepo', `${sub}: p7 forwards repo, never dir`);
      assert.ok(!q.includes('dir='), `${sub}: dir does not leak through the p7 block`);
    }
    up.seen.length = 0;
    await call(srv.base, 'GET', '/api/cmux/git/diff?machine=default&repo=%2Fr&path=a&staged=1');
    assert.equal(up.seen[0].path, '/cmux/git/diff?repo=%2Fr&path=a&staged=1');

    up.seen.length = 0;
    await call(srv.base, 'POST', '/api/cmux/git/command?machine=default', { body: { verb: 'push', params: { branch: 'b' }, dir: '/smuggle' } });
    assert.deepEqual(JSON.parse(up.seen[0].body), { verb: 'push', params: { branch: 'b' } }, 'p7 command still forwards exactly {verb, params}');

    up.seen.length = 0;
    await call(srv.base, 'POST', '/api/cmux/git/stage?machine=default', { body: { repo: '/r', paths: ['a', 'b'] } });
    assert.deepEqual(JSON.parse(up.seen[0].body), { repo: '/r', paths: ['a', 'b'] }, 'p7 stage still forwards exactly {repo, paths}');
  });
});

// ---- STORY-003: the probe REACHES gitread through real children ---------------------------------
// Every test above plays the bridge with a stub, which proves the proxy's own contract and nothing
// about whether a probe can actually be answered. R8 found exactly that gap: server.js relayed
// /api/cmux/gitread/probe, gitread.js implemented probe(), and the two were not connected — the
// factory did not export it and bridge.js 404'd it. This test is the one that would have caught it:
// a REAL server.js child in front of a REAL bridge.js child, over a REAL git repo.
test('p8 STORY-003: GET /api/cmux/gitread/probe answers { repo, name, branch, state } through real server + bridge children', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-probe-')));
  const repo = path.join(base, 'workshop');
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);

  // The cmux shim answers the exact two calls bridge.js:104-118 makes, so the bridge's workspace
  // enumeration resolves to this repo without a real cmux on the box.
  const shim = path.join(base, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\ncase "$*" in\n'
    + '  *list-windows*) echo \'[{"id":"w1"}]\' ;;\n'
    + '  *"workspace list"*) printf %s "$WS_JSON" ;;\n'
    + '  *) echo \'{}\' ;;\nesac\n', { mode: 0o755 });

  const br = await bootBridge({ env: {
    CMUX_BIN: shim,
    WS_JSON: JSON.stringify({ workspaces: [{ current_directory: repo, ref: 'r1' }] }),
    GIT_PANEL_ENABLED: '1',
    BRIDGE_SECRET: 'p8probe',
  } });
  const srv = await bootServer({ env: {
    CMUX_MACHINE_URL: br.base, CMUX_MACHINE_SECRET: 'p8probe', CMUX_MACHINE_LABEL: 'p8',
  } });
  t.after(async () => {
    await srv.stop();
    await br.stop();
    await fsp.rm(base, { recursive: true, force: true });
  });

  const probe = (dir) => call(srv.base, 'GET', `/api/cmux/gitread/probe?machine=default&dir=${encodeURIComponent(dir)}`);

  const r = await probe(repo);
  assert.equal(r.status, 200, `probe reached gitread (body: ${r.text})`);
  assert.deepEqual(r.json, { repo, name: 'workshop', branch: 'main', state: 'branch' },
    'the bar\'s first response, server-derived name included, end to end');

  // The same route's refusals travel the same way — 200 with { repo: null }, never a 404 or a
  // distinguishable 4xx that would work as an existence oracle.
  const notRepo = await probe(base);
  assert.equal(notRepo.status, 200);
  assert.deepEqual(notRepo.json, { repo: null }, 'a non-repo directory');

  const missing = await probe(path.join(base, 'no-such-dir'));
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.json, { repo: null }, 'a path that does not exist answers identically');

  // STORY-010: the probe's shape is UNCHANGED — provenance rides the generated text and the status
  // read, never the bar's display response. The three deepEquals above are the assertion (an extra
  // key fails them); this states on the raw bytes why, so a later addition has to argue with a
  // sentence rather than slip past a shape test whose point was something else.
  for (const [label, r2] of [['a repo', r], ['a non-repo', notRepo], ['a missing path', missing]]) {
    assert.ok(!/provenance/.test(r2.text), `probe carries no provenance for ${label}`);
  }

  // And the bridge really did dispatch it — a sub it does NOT know still 404s at the proxy.
  const unknown = await call(srv.base, 'GET', '/api/cmux/gitread/probe2?machine=default&dir=%2Ftmp');
  assert.equal(unknown.status, 404);
});

// ---- STORY-004: POST command REACHES gitread, and a refusal does not take the bridge down -------
// The hazard this route exists to avoid is not hypothetical: p7's handler is
// `send(res, 200, { text: gitPanel.command(...) })`, synchronous. Point that shape at an ASYNC
// command() and a refusal — now the normal case, because every generation re-runs the read gate —
// becomes an unhandled rejection, fatal on Node ≥ 15, and the operator loses the MIRROR, not just
// source control (specs.md §4.1). So the assertion that matters is the one after the 403: the
// bridge child is still answering. Stub bridges cannot prove that; this runs real children.
test('p8 STORY-004: POST /api/cmux/gitread/command through real server + bridge children', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-command-')));
  const repo = path.join(base, 'workshop');
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);

  const shim = path.join(base, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\ncase "$*" in\n'
    + '  *list-windows*) echo \'[{"id":"w1"}]\' ;;\n'
    + '  *"workspace list"*) printf %s "$WS_JSON" ;;\n'
    + '  *) echo \'{}\' ;;\nesac\n', { mode: 0o755 });

  const br = await bootBridge({ env: {
    CMUX_BIN: shim,
    WS_JSON: JSON.stringify({ workspaces: [{ current_directory: repo, ref: 'r1' }] }),
    GIT_PANEL_ENABLED: '1',
    BRIDGE_SECRET: 'p8cmd',
  } });
  const srv = await bootServer({ env: {
    CMUX_MACHINE_URL: br.base, CMUX_MACHINE_SECRET: 'p8cmd', CMUX_MACHINE_LABEL: 'p8',
  } });
  t.after(async () => {
    await srv.stop();
    await br.stop();
    await fsp.rm(base, { recursive: true, force: true });
  });

  const cmd = (body) => call(srv.base, 'POST', '/api/cmux/gitread/command?machine=default', { body });

  // Success: { text, repo, name, provenance } — the resolved identity AND (STORY-010) the door the
  // gate admitted it through both ride WITH the text. `repo` here IS the workspace cwd the shim
  // reports, so this is the equality door end to end, through real children.
  const ok = await cmd({ verb: 'push', dir: repo, params: {} });
  assert.equal(ok.status, 200, `command reached gitread (body: ${ok.text})`);
  assert.equal(typeof ok.json.text, 'string', 'text is a STRING, never a serialised Promise');
  assert.deepEqual(ok.json,
    { text: `git -C '${repo}' push origin -- 'main'`, repo, name: 'workshop', provenance: 'workspace' });

  // The p7 shape's failure mode, asserted directly: a Promise serialises to {} and would arrive
  // as {"text":{}}. Nothing on this route may ever look like that.
  assert.notDeepEqual(ok.json.text, {});
  assert.ok(!/"text"\s*:\s*\{/.test(ok.text), 'no object where the text belongs');

  // STORY-010, the OTHER door — and the measurement that says it cannot be reached from here.
  // A repo nested inside the workspace is the containment case, which is what `provenance:
  // 'browsed'` describes. Through REAL children it is REFUSED, and correctly: these children run
  // the real `PLATFORM_DENY`, `os.tmpdir()` resolves under `/private`, and §3.4 classifies a
  // deny-listed subtree BROAD — a broad anchor admits its own toplevel by equality and nothing
  // under it. So the browsed class is unreachable in this harness by design, not by omission.
  // It is proven instead where `platformDeny` is injectable (test/p8-provenance.test.js, both
  // doors × 13 verbs) and by the home-rooted browser proof. What IS asserted here is that the
  // refusal is the shared one and carries no provenance either.
  const nested = path.join(repo, 'nested');
  await g(base, ['init', '-q', '-b', 'main', nested]);
  await fsp.writeFile(path.join(nested, 'n.txt'), 'n\n');
  await g(nested, ['add', '-A']);
  await g(nested, ['commit', '-q', '-m', 'nested root']);
  const nestedProbe = await call(srv.base, 'GET', `/api/cmux/gitread/probe?machine=default&dir=${encodeURIComponent(nested)}`);
  assert.equal(nestedProbe.status, 200);
  assert.deepEqual(nestedProbe.json, { repo: null },
    'PRECONDITION: a deny-listed root makes the anchor broad, so containment is closed end to end');
  const nestedCmd = await cmd({ verb: 'fetch', dir: nested, params: {} });
  assert.equal(nestedCmd.status, 403);
  assert.deepEqual(nestedCmd.json, { error: 'unknown_repo' });
  assert.ok(!/provenance/.test(nestedCmd.text), 'and the refusal carries no provenance field');

  // The refusal: an unknown dir is a 403 with a JSON error body, through the promise chain.
  const bad = await cmd({ verb: 'push', dir: path.join(base, 'not-a-repo'), params: {} });
  assert.equal(bad.status, 403);
  assert.deepEqual(bad.json, { error: 'unknown_repo' });
  assert.ok(!/"text"/.test(bad.text), 'a refusal carries no text field at all');
  // STORY-010's no-oracle half, asserted on the WIRE: a repo p8 refuses carries no provenance
  // either. The bit is a fact about a repo already authorized for reading; if a refusal carried it
  // — even as `null` — the shared refusal shape would have gained a field to read.
  assert.ok(!/provenance/.test(bad.text), 'a refusal carries no provenance field at all');

  // THE POINT: the bridge is still alive after the rejection travelled.
  const after = await cmd({ verb: 'fetch', dir: repo, params: {} });
  assert.equal(after.status, 200, 'the bridge child still answers after a refusal');
  assert.equal(after.json.text, `git -C '${repo}' fetch --all --prune`);
  const probeAfter = await call(srv.base, 'GET', `/api/cmux/gitread/probe?machine=default&dir=${encodeURIComponent(repo)}`);
  assert.equal(probeAfter.status, 200, 'and so do its other routes');
  assert.ok(srv.alive(), 'the server child is up too');

  // The other refusal shapes travel the same way, and each is followed by a live route.
  for (const [body, status, code] of [
    [{ verb: 'checkout', dir: repo, params: { branch: '--detach' } }, 400, 'bad_ref'],
    [{ verb: 'rm-rf', dir: repo, params: {} }, 400, 'unknown_command'],
    [{ verb: 'push', dir: '', params: {} }, 403, 'unknown_repo'],
  ]) {
    const r = await cmd(body);
    assert.equal(r.status, status, `${body.verb}: ${code}`);
    assert.deepEqual(r.json, { error: code });
    const live = await cmd({ verb: 'stash', dir: repo, params: {} });
    assert.equal(live.status, 200, `bridge alive after ${code}`);
  }

  // A body the proxy cannot parse never reaches the bridge as a request it must guess at.
  const noBody = await call(srv.base, 'POST', '/api/cmux/gitread/command?machine=default', { body: 'not json' });
  assert.equal(noBody.status, 400);

  // And the p7 route beside it is byte-identically what it was: {verb, params} -> {text}, no dir,
  // no repo, no name — the shape p7 clients depend on.
  const p7 = await fetch(`${br.base}/cmux/git/command`, {
    method: 'POST',
    headers: { 'x-bridge-secret': 'p8cmd', 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'commit', params: { message: 'hi' } }),
  });
  assert.equal(p7.status, 200);
  assert.deepEqual(await p7.json(), { text: "git commit -m 'hi'" },
    'p7 command: unscoped, synchronous, exactly {text} — unchanged');
});

// ---- STORY-005: the sync guard's refusals reach the CLIENT, and the bridge survives them --------
// The 409 is a NEW status on this route and the 400 is a new code, and both are raised from inside
// an async handler after a real git read. A refusal that arrives as a 500, or as a dead bridge, is
// the same defect §4.1 exists to prevent — so this runs real children and keeps asking afterwards.
test('p8 STORY-005: sync_blocked/409 and empty_message/400 through real server + bridge children', async (t) => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p8-sync-')));
  const repo = path.join(base, 'workshop');
  await g(base, ['init', '-q', '-b', 'main', repo]);
  await fsp.writeFile(path.join(repo, 'root.txt'), 'root\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'root']);

  const shim = path.join(base, 'cmux');
  await fsp.writeFile(shim, '#!/bin/sh\ncase "$*" in\n'
    + '  *list-windows*) echo \'[{"id":"w1"}]\' ;;\n'
    + '  *"workspace list"*) printf %s "$WS_JSON" ;;\n'
    + '  *) echo \'{}\' ;;\nesac\n', { mode: 0o755 });

  const br = await bootBridge({ env: {
    CMUX_BIN: shim,
    WS_JSON: JSON.stringify({ workspaces: [{ current_directory: repo, ref: 'r1' }] }),
    GIT_PANEL_ENABLED: '1',
    BRIDGE_SECRET: 'p8sync',
  } });
  const srv = await bootServer({ env: {
    CMUX_MACHINE_URL: br.base, CMUX_MACHINE_SECRET: 'p8sync', CMUX_MACHINE_LABEL: 'p8',
  } });
  t.after(async () => {
    await srv.stop();
    await br.stop();
    await fsp.rm(base, { recursive: true, force: true });
  });

  const cmd = (body) => call(srv.base, 'POST', '/api/cmux/gitread/command?machine=default', { body });
  const alive = async (label) => {
    const r = await cmd({ verb: 'fetch', dir: repo, params: {} });
    assert.equal(r.status, 200, `the bridge child still answers after ${label}`);
  };

  // Clean: the guarded subshell arrives as one string, with the identity riding beside it.
  await fsp.writeFile(path.join(repo, 'work.txt'), 'work\n');
  const ok = await cmd({ verb: 'sync', dir: repo, params: { message: 'a real message' } });
  assert.equal(ok.status, 200, `sync reached gitread (body: ${ok.text})`);
  assert.equal(typeof ok.json.text, 'string', 'text is a STRING, never a serialised Promise');
  assert.equal(ok.json.repo, repo);
  assert.equal(ok.json.name, 'workshop');
  assert.ok(ok.json.text.startsWith(`( R='${repo}' && `), `the §6.2 subshell: ${ok.json.text}`);
  // The chain still ENDS with the commit; NEW-I4 appends a failure report after the subshell so a
  // blocked run is not silent, so the commit is the end of the chain rather than of the string.
  assert.ok(ok.json.text.includes("&& git -C \"$R\" commit -m 'a real message' )"), ok.json.text);
  assert.ok(ok.json.text.endsWith("|| { echo 'sync blocked: repo state changed' >&2; false; }"),
    `and the report rides through the relay intact: ${ok.json.text}`);

  // An EMPTY message is refused before anything is read — a direct POST past the UI gets no text.
  for (const message of ['', '   ', '\n\t']) {
    const r = await cmd({ verb: 'sync', dir: repo, params: { message } });
    assert.equal(r.status, 400, `empty message ${JSON.stringify(message)}`);
    assert.deepEqual(r.json, { error: 'empty_message' });
    assert.ok(!/"text"/.test(r.text), 'and carries no text field at all');
  }
  await alive('empty_message');

  // Now the repo moves into a state where `add -A` would misfire — a MARKERLESS `merge --no-commit`
  // of disjoint files: clean tree, zero unmerged, no marker anywhere, MERGE_HEAD set. The bar's own
  // eyes cannot see a problem here; the server can.
  await g(repo, ['checkout', '-q', '-b', 'side']);
  await fsp.writeFile(path.join(repo, 'side.txt'), 's\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'side']);
  await g(repo, ['checkout', '-q', 'main']);
  await fsp.writeFile(path.join(repo, 'main.txt'), 'm\n');
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-q', '-m', 'main']);
  await g(repo, ['merge', '--no-commit', '--no-ff', 'side']);
  assert.equal((await g(repo, ['ls-files', '-u'])), '', 'PRECONDITION: nothing unmerged — the markerless case');

  const blocked = await cmd({ verb: 'sync', dir: repo, params: { message: 'a real message' } });
  assert.equal(blocked.status, 409, `sync is refused (body: ${blocked.text})`);
  assert.deepEqual(blocked.json, { error: 'sync_blocked' });
  assert.ok(!/"text"/.test(blocked.text), 'a refusal carries no text field at all');
  await alive('sync_blocked');

  // THE POINT, again: every other route is untouched by the refusal travelling.
  const probeAfter = await call(srv.base, 'GET', `/api/cmux/gitread/probe?machine=default&dir=${encodeURIComponent(repo)}`);
  assert.equal(probeAfter.status, 200, 'probe still answers');
  const statusAfter = await call(srv.base, 'GET', `/api/cmux/gitread/status?machine=default&dir=${encodeURIComponent(repo)}`);
  assert.equal(statusAfter.status, 200, 'status still answers');
  assert.equal(statusAfter.json.inProgress.merge, true, 'and it reports the merge the guard refused on');
  assert.ok(srv.alive(), 'the server child is up too');

  // The untouched p7 route beside it is untouched in both directions. Measured here rather than
  // assumed: p7 has ELEVEN templates and `sync` is not one of them, so the guarded verb is p8's
  // alone — adding it to gitread neither armed nor disarmed anything on the ⎇ door (§2.2, §9).
  const p7Post = (body) => fetch(`${br.base}/cmux/git/command`, {
    method: 'POST',
    headers: { 'x-bridge-secret': 'p8sync', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const p7Sync = await p7Post({ verb: 'sync', params: { message: 'hi' } });
  assert.equal(p7Sync.status, 400, 'p7 has no sync verb, before or after this story');
  assert.deepEqual(await p7Sync.json(), { error: 'unknown_command' });
  const p7Commit = await p7Post({ verb: 'commit', params: { message: 'hi' } });
  assert.equal(p7Commit.status, 200);
  assert.deepEqual(await p7Commit.json(), { text: "git commit -m 'hi'" },
    'p7 command: unscoped, synchronous, exactly {text} — unchanged');
});
