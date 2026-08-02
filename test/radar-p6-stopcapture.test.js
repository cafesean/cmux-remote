'use strict';
// p6 S-001 — stop-capture: quiet-after-Stop observation ledger + capture cursor (spec §M1).
//
// The traps these tests exist to catch, each one hit for real elsewhere:
//  * trap 13 — mapCwd().worktree is the trimmed cwd STRING, not a worktrees[] record. The decoy
//    fixtures make a build that reads it FAIL its assertions, not merely differ.
//  * write order — observation line FIRST, cursor SECOND. The crash between them is simulated by
//    seeding the exact post-crash disk and asserting the line duplicates rather than vanishes.
//  * unpushed null is UNKNOWN and must never become 0; dirtyCount is all three counters, so a
//    single-field read is caught by three distinct non-zero values.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../radar/store.js');
const sc = require('../radar/stop-capture.js');

const QUIET = 600000;                                   // captureQuietMs default, spec §4.7
const NOW = Date.parse('2026-08-01T18:15:36.498Z');
const STOP_TS = NOW - QUIET;                            // exactly on the >= boundary — must capture

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p6-stopcap-'));

// ---- fixture builders ---------------------------------------------------------------------------
// Every path lives under a mkdtemp dir handed to sweepStopCapture explicitly; the real ~/.radar is
// never touched, and RADAR_DIR is never set (env leakage into parallel test files is a real bug).

function radarDir() {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  return dir;
}

function writeEvents(dir, events) {
  fs.writeFileSync(
    path.join(dir, 'events', '2026-08-01.ndjson'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function writeTranscript(records) {
  const f = path.join(tmpdir(), 'transcript.jsonl');
  fs.writeFileSync(f, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return f;
}

const ev = (over) => Object.assign(
  { sessionId: 'sess-1', event: 'Stop', ts: STOP_TS, cwd: '/x/repo' }, over);

const CONFIG = {
  collectorId: 'mac-test',
  captureQuietMs: QUIET,
  repos: [{ id: 'repoA', path: '/x/repo' }],
};

// Minimal snapshot slice: stop-capture reads only path/branch/head/dirty off a worktree record
// and name/unpushed off a branch record.
const wtRoot = (over) => Object.assign(
  { path: '/x/repo', branch: 'feature/z', head: 'abc123', dirty: { staged: 1, unstaged: 2, untracked: 4 } }, over);

function makeState(repoOver) {
  return {
    repos: {
      repoA: Object.assign({
        path: '/x/repo',
        branches: [{ name: 'feature/z', unpushed: 5 }],
        worktrees: [wtRoot()],
      }, repoOver),
    },
  };
}

function sweep(dir, over) {
  return sc.sweepStopCapture(Object.assign({
    now: NOW, machine: 'mac-test', config: CONFIG, aliases: {}, state: makeState(), radarDir: dir,
  }, over));
}

const obsPath = (dir) => path.join(dir, 'observations.jsonl');
const cursorPath = (dir) => path.join(dir, 'handoffs', 'capture-cursor.json');
const readObs = (dir) => (fs.existsSync(obsPath(dir))
  ? fs.readFileSync(obsPath(dir), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  : []);
const readCursor = (dir) => JSON.parse(fs.readFileSync(cursorPath(dir), 'utf8'));

// ---- the capture-due predicate — §M1's three conjuncts, exactly ---------------------------------

test('S-001: Stop-then-quiet captures once; a second sweep over unchanged input writes no second line', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);                        // ts is exactly now - quietMs: >= must fire
  await sweep(dir);
  let obs = readObs(dir);
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].stopTs, STOP_TS);
  // §4.4's cursor shape, byte-for-byte, keyed "<machine> <sessionId>"
  assert.deepStrictEqual(readCursor(dir), { v: 1, captured: { 'mac-test sess-1': STOP_TS } });

  await sweep(dir);                                  // unchanged input
  obs = readObs(dir);
  assert.strictEqual(obs.length, 1, 'conjunct 3: the cursor holds this stopTs');
});

test('S-001: Stop-then-UserPromptSubmit does not capture — the NEWEST event is the whole cancellation rule', async () => {
  const dir = radarDir();
  writeEvents(dir, [
    ev({ ts: STOP_TS - 60000 }),
    ev({ event: 'UserPromptSubmit', ts: STOP_TS }),
  ]);
  const r = await sweep(dir);
  assert.strictEqual(r.captured.length, 0);
  assert.strictEqual(fs.existsSync(obsPath(dir)), false, 'no line');
  assert.strictEqual(fs.existsSync(cursorPath(dir)), false, 'a captureless sweep writes nothing at all');
});

test('S-001: a Stop that has not been quiet for captureQuietMs is not captured yet', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({ ts: STOP_TS + 1 })]);       // one ms short of the quiet window
  await sweep(dir);
  assert.strictEqual(readObs(dir).length, 0);
});

test('S-001: two Stops in one session capture only the newer', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({ ts: NOW - 2 * QUIET }), ev({ ts: STOP_TS })]);
  await sweep(dir);
  const obs = readObs(dir);
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].stopTs, STOP_TS, 'the newer Stop; the older is not a separate capture');
});

// ---- conjunct 1 as amended: only Stop/UserPromptSubmit are DECISIVE (the U5 measurement) --------
// A real session emits Notification{idle_prompt} ~a minute after its Stop, then goes silent. If
// any trailing event cancelled, real ended-and-left sessions would never capture — while every
// idealised fixture passed. Only "someone came back" (UserPromptSubmit) or a superseding Stop
// cancels; "time passed" (a notification) strengthens the case.

test('S-001: Stop then idle_prompt still captures — stopTs is the STOP and the quiet clock runs from it', async () => {
  const dir = radarDir();
  writeEvents(dir, [
    ev({}),                                                              // Stop, exactly quiet
    // The notification is RECENT (5 s ago): under the old rule it would cancel outright, and a
    // build measuring quiet from the newest event would call the session not-yet-settled. Both
    // wrong readings fail here.
    ev({ event: 'Notification', notificationType: 'idle_prompt', ts: NOW - 5000 }),
  ]);
  await sweep(dir);
  let obs = readObs(dir);
  assert.strictEqual(obs.length, 1, 'a trailing idle_prompt must not cancel the capture');
  assert.strictEqual(obs[0].stopTs, STOP_TS, 'stopTs is the Stop, never the trailing notification');

  await sweep(dir);                                                      // dedupe unchanged
  assert.strictEqual(readObs(dir).length, 1, 'the cursor still holds the Stop ts');
});

test('S-001: Stop, idle_prompt, then UserPromptSubmit does not capture — someone came back', async () => {
  const dir = radarDir();
  writeEvents(dir, [
    ev({ ts: STOP_TS - 2000 }),
    ev({ event: 'Notification', notificationType: 'idle_prompt', ts: STOP_TS - 1000 }),
    ev({ event: 'UserPromptSubmit', ts: STOP_TS }),
  ]);
  await sweep(dir);
  assert.strictEqual(readObs(dir).length, 0);
});

test('S-001: Stop, idle_prompt, second Stop captures the SECOND Stop', async () => {
  const dir = radarDir();
  writeEvents(dir, [
    ev({ ts: NOW - 2 * QUIET }),
    ev({ event: 'Notification', notificationType: 'idle_prompt', ts: NOW - 2 * QUIET + 63000 }),
    ev({ ts: STOP_TS }),
  ]);
  await sweep(dir);
  const obs = readObs(dir);
  assert.strictEqual(obs.length, 1);
  assert.strictEqual(obs[0].stopTs, STOP_TS, 'a newer Stop supersedes');
});

// ---- ordering: readEvents' ascending ts, ties broken by file offset — no re-sort ----------------

test('S-001: identical ts in one file — the event appended second is the newest', async () => {
  // Stop written second: it wins the tie, so capture is due.
  const a = radarDir();
  writeEvents(a, [ev({ event: 'UserPromptSubmit', ts: STOP_TS }), ev({ ts: STOP_TS })]);
  await sweep(a);
  assert.strictEqual(readObs(a).length, 1, 'Stop appended second is newest');

  // Stop written first: the same-ms UserPromptSubmit wins, so no capture. A build that re-sorts
  // (or prefers Stops) flips one of these two.
  const b = radarDir();
  writeEvents(b, [ev({ ts: STOP_TS }), ev({ event: 'UserPromptSubmit', ts: STOP_TS })]);
  await sweep(b);
  assert.strictEqual(readObs(b).length, 0, 'UserPromptSubmit appended second cancels');
});

// ---- the line: §4.5's fields, written by the QUEUED appendLine ----------------------------------

test('S-001: the line carries exactly §4.5\'s fields, via store.appendLine, appended before the cursor write', async () => {
  const dir = radarDir();
  const transcript = writeTranscript([
    { type: 'custom-title', customTitle: 'first-title' },
    { type: 'summary', text: 'noise' },
    { type: 'custom-title', customTitle: 'second-title' },
  ]);
  writeEvents(dir, [ev({ transcriptPath: transcript })]);

  // Spy on the store NAMESPACE: appendLine must be the QUEUED form (M1 owns no queue slot), the
  // unqueued export must never be called by this module, and the append must precede the cursor
  // write. appendLine's own internal delegation is lexical inside store.js, so a patched
  // appendLineUnqueued export counts only DIRECT calls from stop-capture — which is the assertion.
  const seq = [];
  const real = { appendLine: store.appendLine, appendLineUnqueued: store.appendLineUnqueued, writeJsonAtomic: store.writeJsonAtomic };
  store.appendLine = (f, o) => { seq.push(['appendLine', f]); return real.appendLine(f, o); };
  store.appendLineUnqueued = (f, o) => { seq.push(['appendLineUnqueued', f]); return real.appendLineUnqueued(f, o); };
  store.writeJsonAtomic = (f, v) => { seq.push(['writeJsonAtomic', f]); return real.writeJsonAtomic(f, v); };
  try {
    await sweep(dir);
  } finally {
    Object.assign(store, real);
  }

  assert.deepStrictEqual(seq.map((s) => s[0]), ['appendLine', 'writeJsonAtomic'],
    'queued append, then queued cursor write, and never the unqueued export');
  assert.strictEqual(seq[0][1], obsPath(dir));
  assert.strictEqual(seq[1][1], cursorPath(dir));

  const obs = readObs(dir);
  assert.strictEqual(obs.length, 1);
  assert.deepStrictEqual(Object.keys(obs[0]), [
    'machine', 'sessionId', 'stopTs', 'at', 'repo', 'branch', 'headSha',
    'dirtyCount', 'unpushed', 'transcriptPath', 'customTitle',
  ]);
  assert.deepStrictEqual(obs[0], {
    machine: 'mac-test',
    sessionId: 'sess-1',
    stopTs: STOP_TS,
    at: new Date(NOW).toISOString(),
    repo: 'repoA',
    branch: 'feature/z',
    headSha: 'abc123',
    dirtyCount: 7,                    // 1 + 2 + 4: three DISTINCT counters — a one-field read fails
    unpushed: 5,
    transcriptPath: transcript,
    customTitle: 'second-title',      // the LAST custom-title record wins
  });
});

// ---- §M1's field table: one fixture per null rule -----------------------------------------------

test('S-001: cwd maps to no configured repo -> repo null and all four git fields null', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({ cwd: '/elsewhere/app' })]);
  await sweep(dir);
  const [o] = readObs(dir);
  assert.strictEqual(o.repo, null);
  assert.strictEqual(o.branch, null);
  assert.strictEqual(o.headSha, null);
  assert.strictEqual(o.dirtyCount, null);
  assert.strictEqual(o.unpushed, null);
});

test('S-001: repo mapped but no worktree covers the cwd (mapped worktree removed) -> repo kept, four nulls', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  await sweep(dir, { state: makeState({ worktrees: [] }) });
  const [o] = readObs(dir);
  assert.strictEqual(o.repo, 'repoA', 'repo keeps its mapped value');
  assert.strictEqual(o.branch, null);
  assert.strictEqual(o.headSha, null);
  assert.strictEqual(o.dirtyCount, null);
  assert.strictEqual(o.unpushed, null);
});

test('S-001: detached-HEAD worktree -> branch null, headSha present', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  await sweep(dir, { state: makeState({ worktrees: [wtRoot({ branch: null })] }) });
  const [o] = readObs(dir);
  assert.strictEqual(o.branch, null);
  assert.strictEqual(o.headSha, 'abc123');
  assert.strictEqual(o.dirtyCount, 7, 'dirty is still readable on a detached worktree');
  assert.strictEqual(o.unpushed, null, 'no branch -> no branch record to read');
});

test('S-001: dirty === null -> dirtyCount null (the other fields unaffected)', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  await sweep(dir, { state: makeState({ worktrees: [wtRoot({ dirty: null })] }) });
  const [o] = readObs(dir);
  assert.strictEqual(o.dirtyCount, null);
  assert.strictEqual(o.branch, 'feature/z');
  assert.strictEqual(o.unpushed, 5);
});

test('S-001: unpushed null is UNKNOWN and never becomes 0; a recorded 0 stays 0; no entry -> null', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  await sweep(dir, { state: makeState({ branches: [{ name: 'feature/z', unpushed: null }] }) });
  let [o] = readObs(dir);
  assert.strictEqual(o.unpushed, null, 'p5 recorded null -> null, NEVER 0');

  const dir2 = radarDir();
  writeEvents(dir2, [ev({})]);
  await sweep(dir2, { state: makeState({ branches: [{ name: 'feature/z', unpushed: 0 }] }) });
  [o] = readObs(dir2);
  assert.strictEqual(o.unpushed, 0, 'a measured 0 is a fact, not an unknown');

  const dir3 = radarDir();
  writeEvents(dir3, [ev({})]);
  await sweep(dir3, { state: makeState({ branches: [{ name: 'some-other-branch', unpushed: 9 }] }) });
  [o] = readObs(dir3);
  assert.strictEqual(o.unpushed, null, 'no matching branches[] entry -> null');
});

// ---- worktree choice: longest prefix on a segment boundary --------------------------------------

test('S-001: longest path prefix wins on a segment boundary; p5 never claims p51', async () => {
  const worktrees = [
    wtRoot(),
    { path: '/x/repo/.claude/worktrees/p5', branch: 'feature/p5', head: 'def456', dirty: { staged: 0, unstaged: 1, untracked: 0 } },
  ];
  const deep = sc.findWorktree(worktrees, '/x/repo/.claude/worktrees/p5');
  assert.strictEqual(deep.branch, 'feature/p5', 'both cover it; the longer prefix wins');
  const boundary = sc.findWorktree(worktrees, '/x/repo/.claude/worktrees/p51');
  assert.strictEqual(boundary.branch, 'feature/z', 'p5 + separator is not a prefix of p51 -> root record');
  assert.strictEqual(sc.findWorktree(worktrees, '/y/unrelated'), null);
});

// ---- trap 13: the mapCwd().worktree decoy -------------------------------------------------------

test('S-001: trap 13 — a build reading mapCwd().worktree fails these fixtures', async () => {
  // Fixture A: the cwd IS the repo root, and a worktree RECORD covers it. mapCwd().worktree is
  // the cwd STRING; a build treating that string as the record reads undefined branch/head/dirty
  // and nulls every field below.
  const dir = radarDir();
  writeEvents(dir, [ev({ cwd: '/x/repo' })]);
  await sweep(dir);
  const [a] = readObs(dir);
  assert.strictEqual(a.branch, 'feature/z');
  assert.strictEqual(a.headSha, 'abc123');
  assert.strictEqual(a.dirtyCount, 7);
  assert.strictEqual(a.unpushed, 5);

  // Fixture B: the cwd sits BELOW the worktree. mapCwd().worktree is the deep cwd string, so even
  // the "find a record whose path equals it" repair of the same bug finds nothing; only the
  // longest-prefix scan over worktrees[] lands on the record.
  const dir2 = radarDir();
  writeEvents(dir2, [ev({ cwd: '/x/repo/.claude/worktrees/p5/packages/app' })]);
  await sweep(dir2, {
    state: makeState({
      worktrees: [{ path: '/x/repo/.claude/worktrees/p5', branch: 'feature/p5', head: 'def456', dirty: { staged: 3, unstaged: 5, untracked: 9 } }],
      branches: [{ name: 'feature/p5', unpushed: 2 }],
    }),
  });
  const [b] = readObs(dir2);
  assert.strictEqual(b.branch, 'feature/p5');
  assert.strictEqual(b.headSha, 'def456');
  assert.strictEqual(b.dirtyCount, 17);
  assert.strictEqual(b.unpushed, 2);
});

// ---- customTitle --------------------------------------------------------------------------------

test('S-001: customTitle is the LAST custom-title record with a string value', async () => {
  const two = writeTranscript([
    { type: 'custom-title', customTitle: 'first' },
    { type: 'custom-title', customTitle: 'second' },
  ]);
  assert.strictEqual(await sc.readCustomTitle(two), 'second');

  // A later record failing either condition does not unseat the last qualifying one.
  const mixed = writeTranscript([
    { type: 'custom-title', customTitle: 'good' },
    { type: 'custom-title', customTitle: 42 },
    'not json at all {{{',
  ]);
  assert.strictEqual(await sc.readCustomTitle(mixed), 'good');

  const none = writeTranscript([{ type: 'summary', text: 'x' }]);
  assert.strictEqual(await sc.readCustomTitle(none), null);
  assert.strictEqual(await sc.readCustomTitle(null), null);
});

test('S-001: an unreadable transcript still writes the line, customTitle null — asserted by line COUNT', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({ transcriptPath: path.join(tmpdir(), 'gone.jsonl') })]);
  await sweep(dir);
  const obs = readObs(dir);
  assert.strictEqual(obs.length, 1, 'the line count is the assertion, not the absence of a throw');
  assert.strictEqual(obs[0].customTitle, null);
  assert.notStrictEqual(obs[0].transcriptPath, null, 'the path the session reported is still recorded');
});

// ---- the crash boundary: line first, cursor second ----------------------------------------------

test('S-001: a crash between the two writes repeats the line on the next sweep — never loses it', async () => {
  // Seed the exact post-crash disk: the observation landed, the cursor write did not. (The cursor
  // file EXISTS without this key — a wholly missing cursor is the rebuild case below, which would
  // mask the duplicate.)
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  fs.writeFileSync(obsPath(dir), JSON.stringify({
    machine: 'mac-test', sessionId: 'sess-1', stopTs: STOP_TS, at: new Date(NOW).toISOString(),
    repo: 'repoA', branch: 'feature/z', headSha: 'abc123', dirtyCount: 7, unpushed: 5,
    transcriptPath: null, customTitle: null,
  }) + '\n');
  fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true });
  fs.writeFileSync(cursorPath(dir), JSON.stringify({ v: 1, captured: {} }) + '\n');

  await sweep(dir);
  const obs = readObs(dir);
  assert.strictEqual(obs.length, 2, 'duplicated — the recoverable direction of the crash boundary');
  assert.strictEqual(obs[0].stopTs, obs[1].stopTs);
  assert.deepStrictEqual(readCursor(dir), { v: 1, captured: { 'mac-test sess-1': STOP_TS } });
});

test('S-001: a failed append advances nothing — the next sweep captures from scratch', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  const real = store.appendLine;
  store.appendLine = () => Promise.reject(new Error('disk full'));
  let r;
  try {
    r = await sweep(dir);
  } finally {
    store.appendLine = real;
  }
  assert.strictEqual(r.captured.length, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /disk full/);
  assert.strictEqual(fs.existsSync(cursorPath(dir)), false, 'the cursor must not claim an unappended line');

  await sweep(dir);
  assert.strictEqual(readObs(dir).length, 1, 'retried cleanly once the store recovered');
});

// ---- cursor rebuild -----------------------------------------------------------------------------

test('S-001: a lost cursor rebuilds from observations.jsonl by MAX stopTs — no re-capture', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  // Newer line FIRST, older SECOND: a last-line-wins rebuild lands on the older ts and
  // re-captures; max does not.
  const base = { machine: 'mac-test', sessionId: 'sess-1', at: new Date(NOW).toISOString(), repo: 'repoA', branch: 'feature/z', headSha: 'abc123', dirtyCount: 7, unpushed: 5, transcriptPath: null, customTitle: null };
  fs.writeFileSync(obsPath(dir), [
    JSON.stringify(Object.assign({}, base, { stopTs: STOP_TS })),
    JSON.stringify(Object.assign({}, base, { stopTs: NOW - 2 * QUIET })),
  ].join('\n') + '\n');
  assert.strictEqual(fs.existsSync(cursorPath(dir)), false);

  await sweep(dir);
  assert.strictEqual(readObs(dir).length, 2, 'already-captured Stop is not re-captured');

  const rebuilt = await sc.rebuildCursor(obsPath(dir));
  assert.deepStrictEqual(rebuilt, { v: 1, captured: { 'mac-test sess-1': STOP_TS } });
});

test('S-001: rebuild does not suppress a NEWER Stop than anything in the ledger', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);                        // newest Stop at STOP_TS
  fs.writeFileSync(obsPath(dir), JSON.stringify({
    machine: 'mac-test', sessionId: 'sess-1', stopTs: NOW - 2 * QUIET, at: new Date(NOW - QUIET).toISOString(),
    repo: 'repoA', branch: 'feature/z', headSha: 'abc123', dirtyCount: 7, unpushed: 5,
    transcriptPath: null, customTitle: null,
  }) + '\n');

  await sweep(dir);
  const obs = readObs(dir);
  assert.strictEqual(obs.length, 2, 'the newer Stop is a new capture');
  assert.strictEqual(obs[1].stopTs, STOP_TS);
});

// ---- multiple sessions, one sweep ---------------------------------------------------------------

test('S-001: independent sessions capture independently under "<machine> <sessionId>" keys', async () => {
  const dir = radarDir();
  writeEvents(dir, [
    ev({}),
    ev({ sessionId: 'sess-2', ts: STOP_TS - 1000 }),
    ev({ sessionId: 'sess-3', event: 'UserPromptSubmit' }),   // not due
  ]);
  const r = await sweep(dir);
  assert.strictEqual(r.captured.length, 2);
  const cur = readCursor(dir);
  assert.deepStrictEqual(Object.keys(cur.captured).sort(), ['mac-test sess-1', 'mac-test sess-2']);
});

// ---- snapshot off disk when not handed in -------------------------------------------------------

test('S-001: with no state in opts, the published snapshot is read from <dir>/state.json', async () => {
  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(makeState()) + '\n');
  await sweep(dir, { state: undefined });
  const [o] = readObs(dir);
  assert.strictEqual(o.branch, 'feature/z');
  assert.strictEqual(o.headSha, 'abc123');
});

// ---- naming + no side effects outside ~/.radar --------------------------------------------------

test('S-001: the relation is lastObservedBy — the module source never contains the o-word', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'radar', 'stop-capture.js'), 'utf8');
  assert.ok(src.includes('lastObservedBy'));
  assert.ok(!/origin/.test(src), 'zero matches, including as a substring of longer words');
  // The acceptance oracle is an ABSOLUTE grep (the interactive shell's grep is a ugrep wrapper
  // that silently skips files — spec §9 trap 10); mirror it exactly where the binary exists.
  if (fs.existsSync('/usr/bin/grep')) {
    const r = spawnSync('/usr/bin/grep', ['-n', 'origin', path.join(__dirname, '..', 'radar', 'stop-capture.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, 'grep exits 1 on zero matches');
    assert.strictEqual(r.stdout, '');
  }
});

test('S-001: a capture sweep touches neither ~/.claude/settings.json nor radar/hook-receiver.js', async () => {
  const receiver = path.join(__dirname, '..', 'radar', 'hook-receiver.js');
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const receiverBefore = sha(receiver);
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  const settingsBefore = fs.existsSync(settings) ? fs.statSync(settings).mtimeMs : null;

  const dir = radarDir();
  writeEvents(dir, [ev({})]);
  await sweep(dir);
  assert.strictEqual(readObs(dir).length, 1, 'the sweep really captured');

  assert.strictEqual(sha(receiver), receiverBefore, 'hook-receiver.js byte-identical');
  const settingsAfter = fs.existsSync(settings) ? fs.statSync(settings).mtimeMs : null;
  assert.strictEqual(settingsAfter, settingsBefore, '~/.claude/settings.json mtime unchanged');
});
