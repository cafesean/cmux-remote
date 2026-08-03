'use strict';
// p6 S-002 / S-006(renderer) / S-007(contract) / S-010 — the CLI half of the handoff feature.
//
// S-002  buildBrief renders `last seen by session …` / `origin unknown` per selected epic (§6.5).
// S-006  buildBrief is widened to the four kind-prefixed selector forms (§6.8's table) — this file
//        owns the RENDERER assertions; the protocol (preview/commit/routes) is radar/handoff.js's.
// S-007  the seed contract numbers (116-byte line, 117-byte join, 12171 max override) and the
//        SAFETY_NOTICE constant — asserted lazily, because radar/handoff.js owns the constant and
//        may land after this file.
// S-010  `radar handoff` as an HTTP client with §M5's exact exit codes, proven against a stub
//        server on an EPHEMERAL port — never 8080, never the real ~/.radar.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main, buildBrief, lastObservedLine } = require('../radar/radar-cli');
const { keysForSelector } = require('../radar/handoff-keys');

// ---- fixtures ------------------------------------------------------------------------------------

const LADDER_OK = { spec: 'done', pushed: 'current', mergedDevelop: 'todo', deployedDev: 'todo', prod: 'todo', flags: 'todo' };

// The one board every rendering test reads: PROJ-900 has one branch with two git facts, one
// worktree with both worktree facts, and one ladder signal — so `epic:PROJ-900` resolves to exactly
// five fact keys and every §6.8 line shape appears once.
function mkState(over) {
  return Object.assign({
    v: 1,
    generatedAt: '2026-08-01T10:00:00.000Z',
    collectorId: 'mac-test',
    machines: [],
    sources: { config: { status: 'ok' }, git: { status: 'ok' } },
    counts: {},
    repos: {
      fxa: {
        branches: [
          { name: 'feature/x', epic: 'PROJ-900', unpushed: 3, mergedIntoDevelop: false, mergedIntoMain: null },
          { name: 'fix:1', epic: null, unpushed: 2, mergedIntoDevelop: null, mergedIntoMain: null },
          { name: 'stray', epic: null, unpushed: 0, mergedIntoDevelop: null, mergedIntoMain: null },
          { name: 'clean', epic: 'PROJ-901', unpushed: 0, mergedIntoDevelop: true, mergedIntoMain: true },
        ],
        worktrees: [
          { path: '/tmp/wt-x', branch: 'feature/x', isMain: false, stale: true, staleReason: 'merged',
            cleanupCommand: "/usr/bin/git -C '/r/fxa' worktree remove '/tmp/wt-x'",
            dirty: { staged: 1, unstaged: 2, untracked: 0 } },
        ],
      },
      fxb: {
        branches: [{ name: 'feature/y', epic: 'PROJ-902', unpushed: 5, mergedIntoDevelop: false, mergedIntoMain: null }],
        worktrees: [],
      },
    },
    epics: [
      { key: 'PROJ-900', phrase: 'metering hardening', zone: 'active', ladder: LADDER_OK,
        signals: ['merged-not-deployed'], repos: ['fxa'], lastActivityAt: '2026-07-30T00:00:00.000Z' },
      { key: 'PROJ-902', phrase: 'other epic', zone: 'active', ladder: LADDER_OK,
        signals: [], repos: ['fxb'], lastActivityAt: null },
    ],
    sessions: [],
    attention: [{ type: 'orphan', repo: 'fxa', branch: 'stray', actions: [{ kind: 'tag' }] }],
  }, over || {});
}

const obs = (repo, branch, at, customTitle) => ({
  machine: 'mac-test', sessionId: 's1', stopTs: Date.parse(at), at,
  repo, branch, headSha: 'abc', dirtyCount: 0, unpushed: 1, transcriptPath: null,
  customTitle: customTitle === undefined ? null : customTitle,
});

function capture(stdinText) {
  const out = [];
  const err = [];
  const stdin = new Readable({ read() {} });
  stdin.push(Buffer.from(stdinText == null ? '' : stdinText));
  stdin.push(null);
  return {
    out, err,
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, stdin },
    stdout: () => out.join(''), stderr: () => err.join(''),
  };
}

// ---- S-002: lastObservedBy — never a causal claim (§6.5) -----------------------------------------

test('epic reduction: the single newest observation across ALL (repo, branch) pairs — one line, never per branch', () => {
  const state = mkState();
  // PROJ-900 spans only fxa:feature/x here; widen it across two repos through the branch records.
  state.repos.fxb.branches.push({ name: 'feature/z', epic: 'PROJ-900', unpushed: 1, mergedIntoDevelop: null, mergedIntoMain: null });
  const observations = [
    obs('fxa', 'feature/x', '2026-08-01T00:00:01.000Z', 't-first-repo'),
    obs('fxb', 'feature/z', '2026-08-01T00:00:02.000Z', 't-second-repo'),
  ];
  const line = lastObservedLine(state, 'PROJ-900', observations);
  assert.strictEqual(line, 'last seen by session "t-second-repo" · 2026-08-01T00:00:02.000Z',
    'the newest sits on the SECOND repo and must win');
  const b = buildBrief(state, ['PROJ-900'], { observations });
  assert.strictEqual((b.text.match(/last seen by session/g) || []).length, 1, 'one line per epic, never one per branch');
});

test('greatest `at` wins; a 1 ms gap is a decided race', () => {
  const state = mkState();
  const observations = [
    obs('fxa', 'feature/x', '2026-08-01T00:00:00.001Z', 'later'),
    obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 'earlier'),
  ];
  assert.match(lastObservedLine(state, 'PROJ-900', observations), /"later"/);
});

test('an identical `at` breaks the tie by LATER FILE OFFSET', () => {
  const state = mkState();
  const observations = [
    obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 'appended-first'),
    obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 'appended-second'),
  ];
  assert.match(lastObservedLine(state, 'PROJ-900', observations), /"appended-second"/);
});

test('a null customTitle on the WINNING line renders `origin unknown` — the winner is picked first, then downgraded', () => {
  const state = mkState();
  const observations = [
    obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 'older-titled'),
    obs('fxa', 'feature/x', '2026-08-01T00:00:05.000Z', null),
  ];
  // The older observation HAS a title; using it would be exactly the fuzzier join §6.5 forbids.
  assert.strictEqual(lastObservedLine(state, 'PROJ-900', observations), 'origin unknown');
});

test('no fuzzy join ever produces the line: title-text match, cwd match, same-branch-other-repo all stay unknown', () => {
  const state = mkState();
  const titleMatch = Object.assign(obs('fxa', 'not-an-epic-branch', '2026-08-01T00:00:00.000Z', 'PROJ-900 work'), { cwd: '/r/fxa' });
  const cwdMatch = Object.assign(obs('fxa', 'other', '2026-08-01T00:00:01.000Z', 'x'), { cwd: '/tmp/wt-x' });
  const wrongRepo = obs('fxb', 'feature/x', '2026-08-01T00:00:02.000Z', 'x'); // branch name matches, repo does not
  for (const o of [[titleMatch], [cwdMatch], [wrongRepo], [titleMatch, cwdMatch, wrongRepo]]) {
    assert.strictEqual(lastObservedLine(state, 'PROJ-900', o), 'origin unknown');
  }
});

test('one ORIGIN line per selected epic: a two-epic selection renders exactly two', () => {
  const b = buildBrief(mkState(), ['PROJ-900', 'PROJ-902'], { observations: [] });
  assert.strictEqual((b.text.match(/origin unknown/g) || []).length, 2);
});

test('no observation still yields a complete brief, byte-identical FACTS to the no-observation baseline', () => {
  const state = mkState();
  const baseline = buildBrief(state, ['PROJ-900'], { observations: [] });
  const unrelated = buildBrief(state, ['PROJ-900'], { observations: [obs('fxa', 'not-a-pair', '2026-08-01T00:00:00.000Z', 't')] });
  assert.strictEqual(unrelated.text, baseline.text);
  assert.match(baseline.text, /origin unknown/);
  assert.strictEqual(baseline.unknown.length, 0);
});

test('the word `origin` appears ONLY inside the literal `origin unknown`', () => {
  const state = mkState();
  // Unresolved relation: every `origin` must sit inside the literal.
  const unresolvedText = buildBrief(state, ['PROJ-900', 'PROJ-902'], { observations: [] }).text;
  assert.ok(!/origin/.test(unresolvedText.replace(/origin unknown/g, '')));
  // Resolved relation: the word must not appear at all.
  const resolvedText = buildBrief(state, ['PROJ-900'], {
    observations: [obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 'x-sess')],
  }).text;
  assert.match(resolvedText, /last seen by session "x-sess" · 2026-08-01T00:00:00\.000Z/);
  assert.ok(!/origin/.test(resolvedText));
});

test('the bare-epic block is the shipped five lines plus exactly the one ORIGIN line', () => {
  const b = buildBrief(mkState(), ['PROJ-900'], { observations: [] });
  assert.ok(b.text.includes([
    '  1. SHIP-OR-PARK  epic PROJ-900 — metering hardening',
    '       repos      fxa',
    '       ladder     spec=done · pushed=current · merged=todo · dev=todo · prod=todo · flag=todo',
    '       signals    merged-not-deployed',
    '       last work  2026-07-30T00:00:00.000Z',
    '       origin unknown',
  ].join('\n')), b.text);
});

// ---- S-006 renderer: the §6.8 widening -----------------------------------------------------------

test('epic:<K> renders a FINISH block — ladder position, then one line per fact key, then the ORIGIN line', () => {
  const state = mkState();
  const b = buildBrief(state, ['epic:PROJ-900'], { observations: [] });
  assert.ok(b.text.includes([
    '  1. FINISH  epic PROJ-900 — metering hardening',
    '       ladder     spec=done · pushed=current · merged=todo · dev=todo · prod=todo · flag=todo',
    '       fxa:feature/x — 3 unpushed',
    '       fxa:feature/x — unmerged-develop',
    '       /tmp/wt-x — stale (merged)',
    '       /tmp/wt-x — dirty (1 staged, 2 unstaged, 0 untracked)',
    '       signal merged-not-deployed',
    '       origin unknown',
  ].join('\n')), b.text);
  // Line-for-key parity: the block carries exactly as many fact lines as the selector has keys.
  assert.strictEqual(keysForSelector(state, 'epic:PROJ-900').length, 5);
  assert.strictEqual(b.unknown.length, 0);
});

test('branch:<repo>:<branch> renders a PUSH block — one line per fact key the selector resolved', () => {
  const b = buildBrief(mkState(), ['branch:fxa:feature/x'], { observations: [] });
  assert.ok(b.text.includes([
    '  1. PUSH  fxa · feature/x · 3 unpushed',
    '       unmerged-develop',
  ].join('\n')), b.text);
  // mergedIntoMain is null — UNKNOWN mints no key (§6.2) and must not render a line.
  assert.ok(!/unmerged-main/.test(b.text));
});

test('wt:<absPath> renders a CLEAN block — path, staleReason, dirty counts, cleanupCommand', () => {
  const b = buildBrief(mkState(), ['wt:/tmp/wt-x'], { observations: [] });
  assert.ok(b.text.includes([
    '  1. CLEAN  /tmp/wt-x',
    '       stale (merged)',
    '       dirty (1 staged, 2 unstaged, 0 untracked)',
    "       /usr/bin/git -C '/r/fxa' worktree remove '/tmp/wt-x'",
  ].join('\n')), b.text);
});

test('orphan:<repo>:<branch> renders a TAG block and contributes no /recall — an orphan HAS no epic', () => {
  const b = buildBrief(mkState(), ['orphan:fxa:stray'], { observations: [] });
  assert.ok(b.text.includes('  1. TAG  fxa · stray — untagged branch; alias it to its epic'), b.text);
  assert.ok(!/\/recall/.test(b.text));
  assert.strictEqual(b.unknown.length, 0);
});

test('the literal `worktrees` and `orphans` selectors are byte-unchanged from the shipped behaviour', () => {
  const w = buildBrief(mkState(), ['worktrees'], { observations: [] });
  assert.ok(w.text.includes([
    '  1. CLEAN  1 merged worktree(s), commands verified by radar:',
    "       /usr/bin/git -C '/r/fxa' worktree remove '/tmp/wt-x'   # merged",
  ].join('\n')), w.text);
  const o = buildBrief(mkState(), ['orphans'], { observations: [] });
  assert.ok(o.text.includes([
    '  1. TAG  1 untagged branch(es) — alias each to its epic:',
    '       fxa:stray',
  ].join('\n')), o.text);
  // Neither shipped form gains an ORIGIN line: §6.5 is per selected EPIC.
  assert.ok(!/origin unknown|last seen by/.test(w.text + o.text));
});

test('percent-encoded segments decode single-pass: a branch literally named fix:1 travels as fix%3A1', () => {
  const b = buildBrief(mkState(), ['branch:fxa:fix%3A1'], { observations: [] });
  assert.ok(b.text.includes('  1. PUSH  fxa · fix:1 · 2 unpushed'), b.text);
  assert.strictEqual(b.unknown.length, 0);
});

test('CONTEXT emits ONE /recall per epic named by ANY selector — row-level selectors join through the branch record', () => {
  const b = buildBrief(mkState(), ['branch:fxa:feature/x', 'wt:/tmp/wt-x', 'epic:PROJ-900'], { observations: [] });
  assert.strictEqual((b.text.match(/\/recall /g) || []).length, 1);
  assert.match(b.text, /\/recall PROJ-900/);
  // The shipped bare-key vocabulary is the same code path, not a second rule.
  const bare = buildBrief(mkState(), ['PROJ-900'], { observations: [] });
  assert.strictEqual((bare.text.match(/\/recall PROJ-900/g) || []).length, 1);
});

test('worktree -> epic goes through the BRANCH record, never w.epic (§9 trap 2)', () => {
  const state = mkState();
  // Plant the decoy: a `w.epic` field naming a DIFFERENT epic. The branch record says PROJ-900.
  state.repos.fxa.worktrees[0].epic = 'WRONG-1';
  const b = buildBrief(state, ['wt:/tmp/wt-x'], { observations: [] });
  assert.match(b.text, /\/recall PROJ-900/);
  assert.ok(!/WRONG-1/.test(b.text));
});

test('a selector resolving to ZERO fact keys is UNRESOLVED — never a partial block (§6.1, §9 trap 9)', () => {
  const state = mkState();
  for (const sel of [
    'branch:fxa:nope',    // no such branch
    'branch:fxa:clean',   // exists, but merged everywhere and 0 unpushed: zero keys
    'epic:PROJ-901',       // its only branch has zero facts
    'wt:/nope',           // well-formed, matches no worktree
    'wt:nope',            // malformed: relative path
    'bogus:x',            // unknown kind
    'branch:fxa',         // wrong arity
  ]) {
    const b = buildBrief(state, [sel], { observations: [] });
    assert.deepStrictEqual(b.unknown, [sel], sel);
    assert.strictEqual(b.items, 0, sel);
    assert.match(b.text, /UNRESOLVED SELECTORS/);
  }
});

test('a fully resolved selection renders no UNRESOLVED SELECTORS line (S-007: the branch is unreachable from p6)', () => {
  const b = buildBrief(mkState(), ['epic:PROJ-900', 'branch:fxa:feature/x', 'wt:/tmp/wt-x', 'orphan:fxa:stray'], { observations: [] });
  assert.strictEqual(b.unknown.length, 0);
  assert.ok(!/UNRESOLVED SELECTORS/.test(b.text));
});

// ---- S-002 real wiring: `radar brief` reads observations.jsonl from the radar dir ----------------

test('radar brief joins observations.jsonl and tolerates a truncated final line', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p6-brief-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, repos: [] }));
  await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify(mkState()));
  await fsp.writeFile(path.join(dir, 'observations.jsonl'),
    JSON.stringify(obs('fxa', 'feature/x', '2026-08-01T00:00:00.000Z', 't1')) + '\n' +
    JSON.stringify(obs('fxa', 'feature/x', '2026-08-01T00:00:09.000Z', 't2')) + '\n' +
    '{"truncated');
  const c = capture();
  assert.strictEqual(await main(['--dir', dir, 'brief', 'PROJ-900'], c.io), 0);
  assert.match(c.stdout(), /last seen by session "t2" · 2026-08-01T00:00:09\.000Z/);

  // An absent observations.jsonl is not an error — the relation is simply null (§6.5).
  await fsp.rm(path.join(dir, 'observations.jsonl'));
  const c2 = capture();
  assert.strictEqual(await main(['--dir', dir, 'brief', 'PROJ-900'], c2.io), 0);
  assert.match(c2.stdout(), /origin unknown/);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ---- S-007: the seed contract numbers and the SAFETY_NOTICE constant -----------------------------

const FIRST_TURN = 'FIRST TURN: inspect and plan only. Do not modify, commit, push, merge or delete anything until the operator replies.';

test('§6.8 seed contract: the appended line is 116 bytes, the join costs 117, the largest legal override is 12171', () => {
  assert.strictEqual(Buffer.byteLength(FIRST_TURN, 'utf8'), 116);
  assert.strictEqual(Buffer.byteLength('\n' + FIRST_TURN, 'utf8'), 117);
  const seedMaxBytes = 12288;                    // the §4.7 default the cap is stated against
  assert.strictEqual(seedMaxBytes - 117, 12171);
  assert.strictEqual(Buffer.byteLength('a'.repeat(12171) + '\n' + FIRST_TURN, 'utf8'), seedMaxBytes);
  assert.ok(Buffer.byteLength('a'.repeat(12172) + '\n' + FIRST_TURN, 'utf8') > seedMaxBytes,
    'one more override byte must blow the cap — a 12288-byte override is never acceptable');
});

// §7.2's sentence, byte-for-byte. radar/handoff.js OWNS the constant; this story asserts it, so
// the assertion activates the moment that file lands and skips (visibly) until then.
//
// The constant is the PLAIN TEXT of the sentence — 334 UTF-8 bytes. The `**` and the backticks in
// the spec document are its markdown emphasis, not part of the string (§7.2 pins the count so the
// two readings can never be confused again): no asterisks, no backticks, ASCII apostrophe in
// Claude's, em dash retained.
const SAFETY_NOTICE_LITERAL = 'The session is instructed to inspect and plan only on its first turn, and to ask before modifying, committing, pushing, merging or deleting anything. It runs without --dangerously-skip-permissions, so Claude\'s own permission prompts still apply — but your existing allowlists may already permit some commands. This is not a sandbox.';

test('§7.2 SAFETY_NOTICE is byte-equal to the spec sentence (plain text, 334 bytes)', (t) => {
  assert.strictEqual(Buffer.byteLength(SAFETY_NOTICE_LITERAL, 'utf8'), 334, 'the literal itself must match the §7.2 pin');
  const handoffPath = path.join(__dirname, '..', 'radar', 'handoff.js');
  if (!fs.existsSync(handoffPath)) { t.skip('radar/handoff.js has not landed yet — S-006 owns the file; this assertion activates with it'); return; }
  const mod = require(handoffPath);
  assert.strictEqual(typeof mod.SAFETY_NOTICE, 'string', 'radar/handoff.js must export SAFETY_NOTICE');
  assert.strictEqual(mod.SAFETY_NOTICE, SAFETY_NOTICE_LITERAL);
});

// ---- S-010: `radar handoff` — an HTTP client with §M5's exact exit codes -------------------------

const TOKEN_REF = 'RADAR_P6_TEST_TOKEN';
before(() => { process.env[TOKEN_REF] = 'tok-123'; });
after(() => { delete process.env[TOKEN_REF]; });

// A stub server on an EPHEMERAL port. Every request is recorded so a test can assert what the CLI
// sent — headers, URL shape, body — not just what it printed.
async function withServer(handler, fn) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      reqs.push(rec);
      handler(rec, res);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn(base, reqs);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

async function cliDir(base) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p6-cli-'));
  await fsp.writeFile(path.join(dir, 'config.json'),
    JSON.stringify({ configVersion: 1, serverBaseUrl: base, serverTokenRef: TOKEN_REF, repos: [] }));
  return dir;
}

const reply = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(s);
};

const PREVIEW_OK = { v: 1, plan: { previewId: 'p-1', handoffId: 'h-1', sessionUuid: 'u-1', seedText: 'seed' }, hash: 'h'.repeat(64) };

test('--dry posts preview ONLY: bearer header, no query string, plan printed, exit 0, nothing written', async () => {
  await withServer((req, res) => reply(res, 200, PREVIEW_OK), async (base, reqs) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900', 'worktrees', '--dry'], c.io), 0);
    assert.strictEqual(reqs.length, 1, 'preview only — never a commit under --dry');
    assert.strictEqual(reqs[0].method, 'POST');
    assert.strictEqual(reqs[0].url, '/api/radar/handoff/preview');
    assert.ok(!reqs[0].url.includes('?'), 'a token in the URL is a leak (§7.1)');
    assert.strictEqual(reqs[0].headers.authorization, 'Bearer tok-123');
    assert.deepStrictEqual(reqs[0].body, { selectors: ['PROJ-900', 'worktrees'] });
    assert.match(c.stdout(), /p-1/);
    // The CLI wrote NOTHING: config.json is still the only file in the radar dir (principle 8).
    assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['config.json']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('a typed `y` posts exactly one commit carrying {previewId, hash, idempotencyKey}', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/radar/handoff/preview') return reply(res, 200, PREVIEW_OK);
    return reply(res, 201, { handoffId: 'h-1', status: 'active', sessionId: 'u-1', factKeys: [] });
  }, async (base, reqs) => {
    const dir = await cliDir(base);
    const c = capture('y\n');
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 0);
    assert.strictEqual(reqs.length, 2);
    assert.strictEqual(reqs[1].url, '/api/radar/handoff');
    assert.strictEqual(reqs[1].body.previewId, 'p-1');
    assert.strictEqual(reqs[1].body.hash, 'h'.repeat(64));
    assert.match(reqs[1].body.idempotencyKey, /^[A-Za-z0-9_-]{1,128}$/, 'the §7.1 key grammar');
    assert.match(reqs[1].body.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'minted fresh, uuid v4');
    assert.match(c.stdout(), /h-1/);
    assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['config.json'], 'the CLI writes no p6 state');
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('any answer but `y` declines: exit 1, nothing further posted', async () => {
  await withServer((req, res) => reply(res, 200, PREVIEW_OK), async (base, reqs) => {
    const dir = await cliDir(base);
    const c = capture('n\n');
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 1);
    assert.strictEqual(reqs.length, 1, 'the commit was never posted');
    assert.match(c.stderr(), /declined/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('a 202 is a success: the dispatch is unconfirmed, not failed — exit 0', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/radar/handoff/preview') return reply(res, 200, PREVIEW_OK);
    return reply(res, 202, { handoffId: 'h-1', status: 'unconfirmed', sessionId: 'u-1', factKeys: [] });
  }, async (base) => {
    const dir = await cliDir(base);
    const c = capture('y\n');
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 0);
    assert.match(c.stdout(), /unconfirmed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('server unreachable: the §M5 message names the base URL, exit 3, nothing was changed', async () => {
  // Take a port the OS just proved free, then close it, so the connect is refused.
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  await new Promise((r) => srv.close(r));
  const dir = await cliDir(base);
  const c = capture();
  assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 3);
  assert.ok(c.stderr().includes(`radar: the radar server at ${base} is not reachable (`), c.stderr());
  assert.match(c.stderr(), /p6 state is written only by the server; nothing was changed\./);
  assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['config.json']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a 401 answers exactly like unreachable: exit 3 with the changed-nothing message', async () => {
  await withServer((req, res) => reply(res, 401, { error: 'unauthorized' }), async (base) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 3);
    assert.match(c.stderr(), /HTTP 401/);
    assert.match(c.stderr(), /nothing was changed/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('409 viewer_readonly: exit 3, the body is surfaced naming leaderBaseUrl, nothing written', async () => {
  await withServer((req, res) => reply(res, 409, { error: 'viewer_readonly', message: 'this server is a viewer', leaderBaseUrl: 'http://leader:8080' }), async (base) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 3);
    assert.match(c.stderr(), /viewer_readonly/);
    assert.match(c.stderr(), /http:\/\/leader:8080/);
    assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['config.json']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('any other non-2xx exits 5 and prints error + message + incidentId as bare lines — never a list (§7.3)', async () => {
  await withServer((req, res) => reply(res, 422, { error: 'selector_unresolved', message: 'a selector resolved to nothing', incidentId: 'inc-1' }), async (base) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'nope:x'], c.io), 5);
    assert.strictEqual(c.stderr(), 'selector_unresolved\na selector resolved to nothing\ninc-1\n',
      'exactly three lines — no selector list, no expansion');
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('a body without incidentId prints exactly two lines (§7.1: the id is optional, per code)', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/radar/handoff/preview') return reply(res, 200, PREVIEW_OK);
    return reply(res, 409, { error: 'preview_expired', message: 'the plan expired' });
  }, async (base) => {
    const dir = await cliDir(base);
    const c = capture('y\n');
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'PROJ-900'], c.io), 5);
    assert.strictEqual(c.stderr(), 'preview_expired\nthe plan expired\n');
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('handoff show GETs one id and prints the Handoff projection as one block', async () => {
  const HANDOFF = { id: 'h-123', status: 'active', selectors: ['epic:PROJ-900'], factKeys: [], sessionId: 'u-1', machine: 'mac-test', pid: 1, psStartedAt: null, bridgeSessionId: null, logPath: '/l', transcriptPath: '/t', dispatchedAt: 'd', confirmedAt: null, unconfirmedAt: null, terminalAt: null };
  await withServer((req, res) => reply(res, 200, HANDOFF), async (base, reqs) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'show', 'h-123'], c.io), 0);
    assert.strictEqual(reqs[0].method, 'GET');
    assert.strictEqual(reqs[0].url, '/api/radar/handoff/h-123');
    assert.strictEqual(reqs[0].headers.authorization, 'Bearer tok-123');
    assert.strictEqual(JSON.parse(c.stdout()).id, 'h-123');
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('handoff show: an unknown id prints the 404 body and exits 4', async () => {
  await withServer((req, res) => reply(res, 404, { error: 'handoff_not_found', message: 'no such handoff' }), async (base) => {
    const dir = await cliDir(base);
    const c = capture();
    assert.strictEqual(await main(['--dir', dir, 'handoff', 'show', 'h-nope'], c.io), 4);
    assert.match(c.stderr(), /handoff_not_found/);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

test('usage is exit 1, and there is NO LISTING COMMAND of any kind (§M5, §8)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p6-usage-'));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 1, repos: [] }));

  let c = capture();
  assert.strictEqual(await main(['--dir', dir, 'handoff'], c.io), 1, 'no selectors is usage');
  assert.match(c.stderr(), /usage: radar handoff/);

  c = capture();
  assert.strictEqual(await main(['--dir', dir, 'handoff', 'show'], c.io), 1, 'show with no id is usage');

  c = capture();
  assert.strictEqual(await main(['--dir', dir, 'handoff', 'show', 'h-1', 'h-2'], c.io), 1, 'show takes exactly one id');

  // The plural is not a command: it falls through to unknown-command, and no request is made.
  c = capture();
  const plural = 'handoff' + 's';
  assert.notStrictEqual(await main(['--dir', dir, plural], c.io), 0);
  await fsp.rm(dir, { recursive: true, force: true });
});
