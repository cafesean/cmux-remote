'use strict';
// S-010 — `bridge.js :: cmuxSend` v2: the seq precondition, full-surface serialization, and the
// three-way write-phase split.
//
// Tested against a REAL bridge.js child (the shipped file, ephemeral port) rather than a
// re-implementation, exactly as test/radar-bridge-events.test.js does. The cmux command runner and
// the grid reader are stubbed through the seam that already exists for that purpose — `CMUX_BIN` —
// pointed at a synthesised fake cmux that:
//
//   * appends a `start` and an `end` record per invocation to a log file, which is what makes the
//     serialization claim measurable rather than asserted;
//   * reads a PLAN file on every run, so one bridge child serves every scenario;
//   * can answer `rpc terminal.replay` with any envelope seq, refuse it, or hang past the timeout.
//
// The two PRE-DISPATCH cases are produced by mutating that binary on disk — deleting it (ENOENT)
// and dropping its execute bits (EACCES) — because a spawn failure is a property of the executable,
// not of the arguments. Both are restored in `finally`.
//
// Offline: one node child and localhost HTTP. No cmux, no network, no live-machine state.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

// The code this story deletes from the route. ASSEMBLED, never written as one literal: this file
// asserts that literal's absence from every /cmux/send caller, and it is a caller itself — spelling
// it out here would make the assertion fail on its own assertion.
const GONE_CODE = 'cmux' + '_failed';

// A synthetic surface uuid. Nothing on any real machine.
const SURFACE = '11111111-2222-4333-8444-555555555555';
const OTHER_SURFACE = '99999999-8888-4777-8666-555555555555';
const TEXT = 'a synthesised reply line';

// The fake cmux. `String.raw` keeps every backslash escape literal, so the source below is written
// exactly as it lands on disk.
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
function opOf(a) {
  if (a[0] === 'rpc' && a[1] === 'terminal.replay') return 'grid';
  if (a[0] === 'read-screen') return 'read-screen';
  if (a[0] === 'send') return 'send-text';
  if (a[0] === 'send-key') return 'send-key';
  return a[0] || 'unknown';
}
const op = opOf(args);
let plan = {};
try { plan = JSON.parse(fs.readFileSync(process.env.FAKE_CMUX_PLAN, 'utf8')); } catch (_) {}
const step = plan[op] || {};
function rec(phase) {
  try { fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify({ op, phase, at: Date.now(), args: args }) + '\n'); } catch (_) {}
}
rec('start');
function finish() {
  rec('end');
  if (step.mode === 'fail') { process.stderr.write('fake cmux refused\n'); return process.exit(1); }
  if (op === 'grid') {
    const body = { render_grid: { columns: 3, rows: 1, styles: [], row_spans: [{ row: 0, column: 0, style_id: 0, text: 'abc' }], scrollback_rows: 0, scrollback_spans: [], cursor: null } };
    if (step.mode !== 'no-seq') body.seq = step.seq;
    process.stdout.write(JSON.stringify(body));
    return process.exit(0);
  }
  if (op === 'read-screen') { process.stdout.write('a plain screen line\n'); return process.exit(0); }
  process.exit(0);
}
// A rendezvous, so a concurrency claim never rests on a stopwatch: hold until the log shows N
// invocations have STARTED, then finish. Give up after waitMs so a serialized bridge still answers.
function startCount() {
  try {
    return fs.readFileSync(process.env.FAKE_CMUX_LOG, 'utf8').split('\n').filter(Boolean)
      .filter(function (l) { try { return JSON.parse(l).phase === 'start'; } catch (_) { return false; } }).length;
  } catch (_) { return 0; }
}
if (step.mode === 'hang') setInterval(function () {}, 60000);   // never exits: execFile's timeout kills it
else if (step.waitForStarts) {
  const deadline = Date.now() + (step.waitMs || 5000);
  (function poll() {
    if (startCount() >= step.waitForStarts || Date.now() >= deadline) return finish();
    setTimeout(poll, 10);
  }());
} else if (step.delayMs) setTimeout(finish, step.delayMs);
else finish();
`;

let dir = null;      // holds the fake binary, the plan file and the invocation log
let binPath = null;
let planPath = null;
let logPath = null;
let bridge = null;

const REPO = path.join(__dirname, '..');

before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-send-')));
  binPath = path.join(dir, 'fake-cmux');
  planPath = path.join(dir, 'plan.json');
  logPath = path.join(dir, 'cmux-calls.ndjson');
  await fsp.writeFile(binPath, FAKE_CMUX, { mode: 0o755 });
  await fsp.writeFile(planPath, '{}');
  bridge = await bootBridge({
    env: {
      CMUX_BIN: binPath,
      FAKE_CMUX_PLAN: planPath,
      FAKE_CMUX_LOG: logPath,
      // The private override on the route's own command timeout, so the post-dispatch TIMEOUT
      // branch costs a second instead of the production eight.
      CMUX_SEND_TIMEOUT_MS: '1200',
    },
  });
});

after(async () => { if (bridge) await bridge.stop(); });

// ---- harness ------------------------------------------------------------------------------------

// The scenario switch. Ops: grid | read-screen | send-text | send-key.
// Modes: ok (default) | fail (exit 1) | hang (never exits) | no-seq (grid: omit the envelope seq).
function plan(p) {
  fs.writeFileSync(planPath, JSON.stringify(p || {}));
  fs.writeFileSync(logPath, '');
}

function log() {
  let raw = '';
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch (_) { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const started = () => log().filter((e) => e.phase === 'start').map((e) => e.op);
const sendCommands = () => started().filter((o) => o === 'send-text' || o === 'send-key');

// No cmux command for this surface may begin while another is still running — the whole claim of
// the per-surface chain, measured from the subprocesses themselves rather than from the handler.
function assertNoOverlap(msg) {
  let inFlight = 0;
  for (const e of log()) {
    if (e.phase === 'start') {
      assert.equal(inFlight, 0, msg + ' — a cmux command started while another was still running');
      inFlight += 1;
    } else { inFlight -= 1; }
  }
}

async function post(body, raw) {
  const r = await fetch(bridge.base + '/cmux/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep the text */ }
  return { status: r.status, json, text };
}

const OK_PLAN = { grid: { mode: 'ok', seq: 7 }, 'send-text': {}, 'send-key': {} };

// ---- the seq precondition ------------------------------------------------------------------------

test('AC1 — expect_seq matching the envelope seq sends text then Enter and answers 200 {ok:true}', async () => {
  plan(OK_PLAN);
  const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(started(), ['grid', 'send-text', 'send-key'], 'the check precedes both writes');
  const write = log().find((e) => e.op === 'send-text');
  assert.deepEqual(write.args, ['send', '--surface', SURFACE, '--', TEXT], 'byte-exact text, argv, no shell');
});

test('AC1 — expect_seq 0 is a real precondition, not an absent one', async () => {
  plan({ grid: { mode: 'ok', seq: 0 }, 'send-text': {}, 'send-key': {} });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(started(), ['grid', 'send-text', 'send-key'], 'a falsy seq is still checked');
});

test('AC2 — a differing envelope seq is 409 seq_changed carrying the CURRENT seq, and nothing is sent', async () => {
  plan(OK_PLAN);
  const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 9 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'seq_changed', seq: 7 }, 'the body carries the seq the caller must re-read against');
  assert.deepEqual(started(), ['grid'], 'the grid was read');
  assert.deepEqual(sendCommands(), [], 'ZERO cmux send commands');
});

test('AC3 — FAIL CLOSED: gridPayload null is 409 seq_unavailable with zero cmux send commands', async () => {
  // Both gridPayload branches refuse: `rpc terminal.replay` fails AND the read-screen fallback
  // fails, which is the only way it answers null.
  plan({ grid: { mode: 'fail' }, 'read-screen': { mode: 'fail' }, 'send-text': {}, 'send-key': {} });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'seq_unavailable' });
  assert.deepEqual(sendCommands(), [], 'ZERO cmux send commands');
});

test('AC3 — FAIL CLOSED: the plain-text FALLBACK object carries no envelope seq → 409 seq_unavailable, zero sends', async () => {
  // `rpc terminal.replay` fails, read-screen succeeds: gridPayload returns {grid:{…plain:true}} with
  // no `seq` key at all. A precondition that cannot be verified must not be waved through.
  plan({ grid: { mode: 'fail' }, 'read-screen': {}, 'send-text': {}, 'send-key': {} });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'seq_unavailable' });
  assert.deepEqual(started(), ['grid', 'read-screen'], 'the fallback path really was taken');
  assert.deepEqual(sendCommands(), [], 'ZERO cmux send commands');
});

test('AC3 — FAIL CLOSED: a NON-NUMERIC envelope seq is 409 seq_unavailable, zero sends', async () => {
  for (const seq of ['7', null, true]) {
    plan({ grid: { mode: 'ok', seq }, 'read-screen': {}, 'send-text': {}, 'send-key': {} });
    const r = await post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 });
    assert.equal(r.status, 409, 'seq ' + JSON.stringify(seq));
    assert.deepEqual(r.json, { error: 'seq_unavailable' }, 'seq ' + JSON.stringify(seq));
    assert.deepEqual(sendCommands(), [], 'ZERO cmux send commands for seq ' + JSON.stringify(seq));
  }
});

// ---- expect_seq admission -------------------------------------------------------------------------

test('AC6 — INVALID-PRESENT expect_seq is 400 bad_json before any grid read and before the queue', async () => {
  // Own-property presence semantics: each of these is PRESENT and unusable. Treating one as absent
  // would silently bypass the precondition; comparing one would fabricate a seq_changed.
  const bodies = [
    ['string', JSON.stringify({ surface: SURFACE, text: TEXT, submit: true, expect_seq: '7' })],
    ['null', JSON.stringify({ surface: SURFACE, text: TEXT, submit: true, expect_seq: null })],
    ['object', JSON.stringify({ surface: SURFACE, text: TEXT, submit: true, expect_seq: { seq: 7 } })],
    ['array', JSON.stringify({ surface: SURFACE, text: TEXT, submit: true, expect_seq: [7] })],
    // JSON.parse turns a 1e999 literal into Infinity — the one non-finite number that reaches a
    // JSON body, so it is reachable and it is rejected.
    ['infinity', '{"surface":"' + SURFACE + '","text":"' + TEXT + '","submit":true,"expect_seq":1e999}'],
  ];
  for (const [label, body] of bodies) {
    plan(OK_PLAN);
    const r = await post(null, body);
    assert.equal(r.status, 400, label);
    assert.deepEqual(r.json, { error: 'bad_json' }, label);
    assert.deepEqual(started(), [], 'ZERO grid reads and ZERO cmux commands for ' + label);
  }
});

test('AC5 — with NO expect_seq own-property there is no grid read, and the send still runs', async () => {
  plan(OK_PLAN);
  const r = await post({ surface: SURFACE, text: TEXT, submit: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(started(), ['send-text', 'send-key'], 'no grid read occurred');
});

// ---- full-surface serialization --------------------------------------------------------------------

test('AC4 — two concurrent PRECONDITIONED sends for one surface record check, send, check, send', async () => {
  // Without the chain the two grid reads would both start before either write, because each op
  // holds for 120 ms.
  plan({ grid: { mode: 'ok', seq: 7, delayMs: 120 }, 'send-text': { delayMs: 120 }, 'send-key': {} });
  const body = { surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 };
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(started(), ['grid', 'send-text', 'send-key', 'grid', 'send-text', 'send-key'],
    'strictly check-send, check-send — never check, check, send, send');
  assertNoOverlap('two preconditioned sends');
});

test('AC4 — a LEGACY send cannot interleave a preconditioned send\'s check/write on the same surface', async () => {
  plan({ grid: { mode: 'ok', seq: 7, delayMs: 120 }, 'send-text': { delayMs: 120 }, 'send-key': {} });
  const [a, b] = await Promise.all([
    post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 }),
    post({ surface: SURFACE, text: TEXT, submit: true }),          // no expect_seq — the legacy caller
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // Whichever entered the chain first, the legacy send is never allowed between the check and its
  // write. Both admissible orders are spelled out; nothing else is.
  const seen = started();
  const preconditionedFirst = ['grid', 'send-text', 'send-key', 'send-text', 'send-key'];
  const legacyFirst = ['send-text', 'send-key', 'grid', 'send-text', 'send-key'];
  assert.ok(
    JSON.stringify(seen) === JSON.stringify(preconditionedFirst) || JSON.stringify(seen) === JSON.stringify(legacyFirst),
    'legacy send interleaved the preconditioned check/write: ' + JSON.stringify(seen),
  );
  assertNoOverlap('mixed preconditioned/legacy pair');
});

test('AC4 — the chain is PER SURFACE: two surfaces make progress concurrently', async () => {
  // A rendezvous, not a stopwatch — a wall-clock budget is exactly the assertion that goes flaky
  // when the suite runs its files in parallel. Each surface's grid read refuses to finish until it
  // can SEE the other surface's grid read has started, so under a per-surface chain the two must
  // overlap; under one global lock the first would wait out its whole window alone and the log
  // would show no overlap at all. The verdict is read off the subprocesses, not off a timer.
  plan({ grid: { mode: 'ok', seq: 7, waitForStarts: 2, waitMs: 5000 }, 'send-text': {}, 'send-key': {} });
  const [a, b] = await Promise.all([
    post({ surface: SURFACE, text: TEXT, submit: true, expect_seq: 7 }),
    post({ surface: OTHER_SURFACE, text: TEXT, submit: true, expect_seq: 7 }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(started().length, 6);
  let inFlight = 0;
  let overlapped = false;
  for (const e of log()) {
    if (e.phase === 'start') { if (inFlight > 0) overlapped = true; inFlight += 1; } else { inFlight -= 1; }
  }
  assert.ok(overlapped, 'the two surfaces never overlapped — the queue is global, not per-surface');
});

// ---- the three-way write-phase split -----------------------------------------------------------

test('AC7 — PRE-DISPATCH spawn failure (ENOENT: the binary is gone) is 502 send_failed, Enter never attempted', async () => {
  plan(OK_PLAN);
  await fsp.rename(binPath, binPath + '.parked');
  try {
    const r = await post({ surface: SURFACE, text: TEXT, submit: true });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'send_failed', 'the child never started — this is the one provable case');
    assert.deepEqual(started(), [], 'no cmux process ran at all, so Enter was never attempted');
  } finally {
    await fsp.rename(binPath + '.parked', binPath);
  }
});

test('AC7 — PRE-DISPATCH spawn failure (EACCES: no execute bit) is 502 send_failed, Enter never attempted', async () => {
  plan(OK_PLAN);
  await fsp.chmod(binPath, 0o644);
  try {
    const r = await post({ surface: SURFACE, text: TEXT, submit: true });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'send_failed');
    assert.deepEqual(started(), [], 'no cmux process ran at all, so Enter was never attempted');
  } finally {
    await fsp.chmod(binPath, 0o755);
  }
});

test('AC7 — POST-DISPATCH text-command TIMEOUT is 502 text_command_unconfirmed, never send_failed', async () => {
  plan({ 'send-text': { mode: 'hang' }, 'send-key': {} });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'text_command_unconfirmed',
    'the child started, so the terminal write cannot be proved not to have landed');
  assert.deepEqual(started(), ['send-text'], 'Enter was never attempted');
});

test('AC7 — POST-DISPATCH late NONZERO EXIT is 502 text_command_unconfirmed, never send_failed', async () => {
  plan({ 'send-text': { mode: 'fail', delayMs: 40 }, 'send-key': {} });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'text_command_unconfirmed');
  assert.deepEqual(started(), ['send-text'], 'Enter was never attempted');
});

test('AC7 — text SUCCEEDS then Enter fails is 502 submit_failed_text_inserted', async () => {
  plan({ 'send-text': {}, 'send-key': { mode: 'fail' } });
  const r = await post({ surface: SURFACE, text: TEXT, submit: true });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'submit_failed_text_inserted');
  assert.deepEqual(started(), ['send-text', 'send-key'], 'the text really did land first');
});

test('AC7 — ' + GONE_CODE + ' is not answerable by this route on any write-phase failure', async () => {
  for (const p of [
    { 'send-text': { mode: 'fail' }, 'send-key': {} },
    { 'send-text': {}, 'send-key': { mode: 'fail' } },
  ]) {
    plan(p);
    const r = await post({ surface: SURFACE, text: TEXT, submit: true });
    assert.equal(r.status, 502);
    assert.notEqual(r.json.error, GONE_CODE);
    assert.ok(/^(send_failed|text_command_unconfirmed|submit_failed_text_inserted)$/.test(r.json.error), r.json.error);
  }
});

// ---- pre-queue rejections survive ------------------------------------------------------------------

test('the pre-handler rejections are unchanged: bad_json and bad_surface still precede everything', async () => {
  plan(OK_PLAN);
  const bad = await post(null, '{not json');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'bad_json' });
  const surf = await post({ surface: 'not-a-surface', text: TEXT, submit: true, expect_seq: 7 });
  assert.equal(surf.status, 400);
  assert.deepEqual(surf.json, { error: 'bad_surface' });
  assert.deepEqual(started(), [], 'neither reached the grid read or the queue');
});

// ---- AC8: the rename blast radius, asserted against the source -------------------------------------

test('AC8 — no /cmux/send caller in the repo string-matches ' + GONE_CODE, () => {
  // Done with node + a real regex, deliberately: the shell `grep` on this machine is a ugrep
  // wrapper that skips ignored files and can produce a false all-clear.
  const skip = new Set(['node_modules', '.git', '.claude', 'coverage']);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|json|html|md|sh)$/.test(e.name)) files.push(p);
    }
  }(REPO));

  const callers = files.filter((p) => {
    if (path.resolve(p) === path.resolve(REPO, 'bridge.js')) return false;   // the route itself, not a caller
    return /(^|[^\w])\/(api\/)?cmux\/send\b/.test(fs.readFileSync(p, 'utf8'));
  });
  assert.ok(callers.length >= 2, 'the caller set was found at all: ' + JSON.stringify(callers.map((p) => path.relative(REPO, p))));

  for (const p of callers) {
    const hits = (fs.readFileSync(p, 'utf8').match(new RegExp(GONE_CODE, 'g')) || []).length;
    assert.equal(hits, 0, path.relative(REPO, p) + ' string-matches ' + GONE_CODE);
  }

  // …and the code it disappeared from: the handler itself no longer answers it.
  const src = fs.readFileSync(path.join(REPO, 'bridge.js'), 'utf8');
  const start = src.indexOf('function cmuxSend(');
  assert.ok(start > 0, 'cmuxSend located by symbol');
  const end = src.indexOf('\nfunction cmuxKey(', start);
  assert.ok(end > start, 'cmuxSend body bounded');
  const handler = src.slice(start, end);
  assert.equal((handler.match(new RegExp(GONE_CODE, 'g')) || []).length, 0, GONE_CODE + ' is gone from cmuxSend');
  for (const code of ['seq_changed', 'seq_unavailable', 'send_failed', 'text_command_unconfirmed', 'submit_failed_text_inserted']) {
    assert.ok(handler.includes(code), 'cmuxSend answers ' + code);
  }
});
