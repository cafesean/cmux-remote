'use strict';
// S-010 review hardening — three latent holes in the one path that writes into a live terminal.
//
// None of these was reachable by a caller shipping today, which is exactly why they are worth
// pinning: a latent wrong-pane write is a trapdoor that opens the first time an unrelated component
// changes. Tested the same way S-010 is — a REAL bridge.js child on an ephemeral port, driving a
// synthesised fake cmux through the CMUX_BIN seam, with the fake recording every invocation so a
// "nothing was sent" claim is counted rather than assumed.
//
// 1. THE TARGETING FLAG IS NEVER ADAPTED AWAY. `adaptArgs` drops an unknown flag AND its value and
//    retries. That is right for `--focus`; for `--surface` it turns one rejected send into an
//    UNTARGETED one, and cmux types the text into whatever it considers the default target. Every
//    gate upstream exists to stop exactly that, and a retry would have walked around all of them.
//
// 2. THE PER-SURFACE CHAIN IS KEYED CASE-INSENSITIVELY. SURFACE_RE accepts either casing of a uuid,
//    so two callers spelling one surface differently would serialize on two different chains — and
//    one caller's send could land between the other's check and its write.
//
// 3. THE PROXY REFUSES `expect_seq` RATHER THAN DROPPING IT. server.js re-serializes an allowlisted
//    body, so an unnamed field vanishes silently. A silently dropped precondition is worse than a
//    rejected one: the caller believes the send was guarded when it was not.
//
// Offline: node children and localhost HTTP. No cmux, no network, no live-machine state.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

// Synthetic surface uuids. Nothing on any real machine. LOWER and UPPER are the SAME surface spelled
// two ways — that identity is the point of the serialization test.
const LOWER = '11111111-2222-4333-8444-5555555555aa';
const UPPER = '11111111-2222-4333-8444-5555555555AA';
const TEXT = 'a synthesised reply line';

// A fake cmux that logs every invocation and can be told to reject a named flag the way a cmux build
// too old for it would — on stderr, with a nonzero exit, which is the shape `runSendCommand` matches.
const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
function opOf(a) {
  if (a[0] === 'rpc' && a[1] === 'terminal.replay') return 'grid';
  if (a[0] === 'send') return 'send-text';
  if (a[0] === 'send-key') return 'send-key';
  return a[0] || 'unknown';
}
const op = opOf(args);
let plan = {};
try { plan = JSON.parse(fs.readFileSync(process.env.FAKE_CMUX_PLAN, 'utf8')); } catch (_) {}
const step = plan[op] || {};
function rec(phase) {
  try { fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify({ op: op, phase: phase, args: args }) + '\n'); } catch (_) {}
}
rec('start');
function finish() {
  rec('end');
  // Reject a named flag exactly as an older cmux would: the message adaptArgs matches on, nonzero.
  if (step.rejectFlag && args.indexOf(step.rejectFlag) !== -1) {
    process.stderr.write("unknown flag '" + step.rejectFlag + "'\n");
    return process.exit(1);
  }
  if (op === 'grid') {
    const body = { render_grid: { columns: 3, rows: 1, styles: [], row_spans: [{ row: 0, column: 0, style_id: 0, text: 'abc' }], scrollback_rows: 0, scrollback_spans: [], cursor: null } };
    body.seq = step.seq;
    process.stdout.write(JSON.stringify(body));
    return process.exit(0);
  }
  process.exit(0);
}
function startCount() {
  try {
    return fs.readFileSync(process.env.FAKE_CMUX_LOG, 'utf8').split('\n').filter(Boolean)
      .filter(function (l) { try { return JSON.parse(l).phase === 'start'; } catch (_) { return false; } }).length;
  } catch (_) { return 0; }
}
// Hold until N invocations have STARTED, so a concurrency claim never rests on a stopwatch: if the
// chain is broken the second call starts while the first waits, and both proceed.
if (step.waitForStarts) {
  const deadline = Date.now() + (step.waitMs || 4000);
  (function poll() {
    if (startCount() >= step.waitForStarts || Date.now() >= deadline) return finish();
    setTimeout(poll, 10);
  }());
} else finish();
`;

let dir = null;
let binPath = null;
let planPath = null;
let logPath = null;
let bridge = null;

before(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-send-hard-')));
  binPath = path.join(dir, 'fake-cmux');
  planPath = path.join(dir, 'plan.json');
  logPath = path.join(dir, 'cmux-calls.ndjson');
  await fsp.writeFile(binPath, FAKE_CMUX, { mode: 0o755 });
  await fsp.writeFile(planPath, '{}');
  bridge = await bootBridge({
    env: { CMUX_BIN: binPath, FAKE_CMUX_PLAN: planPath, FAKE_CMUX_LOG: logPath, CMUX_SEND_TIMEOUT_MS: '1500' },
  });
});
after(async () => {
  if (bridge) await bridge.stop();
  if (dir) { try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
});

function plan(p) {
  fs.writeFileSync(planPath, JSON.stringify(p || {}));
  fs.writeFileSync(logPath, '');
}
function log() {
  let raw = '';
  try { raw = fs.readFileSync(logPath, 'utf8'); } catch (_) { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const starts = () => log().filter((e) => e.phase === 'start');

async function post(body) {
  const r = await fetch(bridge.base + '/cmux/send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch (_) { /* keep the text */ }
  return { status: r.status, json, text };
}

// ================================================================================================

test('a rejected --surface is never retried untargeted', async () => {
  plan({ grid: { seq: 5 }, 'send-text': { rejectFlag: '--surface' }, 'send-key': {} });

  const res = await post({ surface: LOWER, text: TEXT, submit: true, expect_seq: 5 });

  // Post-dispatch: the child ran and cmux rejected the flag, so the write cannot be claimed
  // impossible. `send_failed` here would be a lie the route forwards to the operator as
  // "nothing was typed - retry", which is how one reply becomes two.
  assert.equal(res.status, 502);
  assert.equal(res.json.error, 'text_command_unconfirmed');

  // THE ACTUAL CLAIM: exactly one send-text invocation, and it carried the targeting flag. A retry
  // would show a second send-text whose argv has no --surface at all.
  const sends = starts().filter((e) => e.op === 'send-text');
  assert.equal(sends.length, 1, 'the rejected send is not retried');
  assert.ok(sends[0].args.includes('--surface'), 'the one attempt was targeted');
  for (const s of sends) {
    assert.ok(s.args.includes('--surface'), 'no invocation of send ever lacks its targeting flag');
  }
  // And Enter is never attempted after a text-command failure.
  assert.equal(starts().filter((e) => e.op === 'send-key').length, 0, 'no Enter after a failed text command');
});

test('the guard is scoped to targeting flags, and the generic adapt path is untouched', () => {
  // Stated honestly: this cannot be a behavioural test on THIS route. The send argv is
  // `['send', '--surface', <uuid>, '--', <text>]` and `send-key` is the same shape — the only flag
  // either one carries IS the targeting flag, so there is no non-targeting rejection a fake cmux
  // could provoke here. Writing one would mean inventing an argv the route never emits, and a test
  // that passes against a fiction proves nothing. The scope claim is therefore asserted where it
  // actually lives: in the source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');

  const set = src.match(/const TARGETING_FLAGS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'TARGETING_FLAGS is still declared as a literal Set - this assertion has moved');
  const flags = set[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(flags.sort(), ['--pane', '--surface', '--workspace'],
    'exactly the flags that decide WHERE a send lands');

  // Every targeting flag must also be a value-carrying flag, or adaptArgs would drop the flag and
  // leave its uuid behind as a stray positional argument.
  const values = src.match(/const FLAG_VALUES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(values, 'FLAG_VALUES is still declared as a literal Set');
  for (const f of flags) {
    assert.ok(values[1].includes("'" + f + "'"), f + ' must carry a value for adaptArgs to take 2');
  }

  // And the generic adapt-and-retry the rest of the bridge depends on is NOT removed: the guard is
  // a refusal for three flags, never a blanket disabling of flag adaptation.
  assert.ok(/function adaptArgs\(/.test(src), 'adaptArgs still exists');
  assert.ok(/const next = adaptArgs\(args, m\[1\]\);/.test(src), 'the retry path still calls it');
});

test('one surface spelled in two cases serializes on ONE chain', async () => {
  // Each send-text holds until TWO invocations have started. On one chain that can never happen —
  // the second call has not been dispatched yet — so both fall through on the deadline and the log
  // shows no overlap. On two chains they rendezvous immediately and overlap.
  plan({ grid: { seq: 5 }, 'send-text': { waitForStarts: 2, waitMs: 1200 }, 'send-key': {} });

  const [a, b] = await Promise.all([
    post({ surface: LOWER, text: TEXT, submit: true, expect_seq: 5 }),
    post({ surface: UPPER, text: TEXT, submit: true, expect_seq: 5 }),
  ]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);

  let inFlight = 0;
  for (const e of log()) {
    if (e.phase === 'start') {
      assert.equal(inFlight, 0, 'a cmux command started while another was still running - the chain split on casing');
      inFlight += 1;
    } else inFlight -= 1;
  }
});

test('the server proxy refuses expect_seq rather than dropping it', async () => {
  // Verified against the shipped source rather than a booted server: the proxy re-serializes a
  // named allowlist, so the guarantee is that `expect_seq` cannot pass through it unnoticed.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf("p === '/api/cmux/send'");
  assert.ok(at > 0, 'the send proxy is still in server.js - this assertion has moved');
  const block = src.slice(at, at + 1400);
  assert.ok(/hasOwnProperty\.call\(b, 'expect_seq'\)/.test(block), 'presence of expect_seq is detected');
  assert.ok(/expect_seq_unsupported/.test(block), 'and refused with its own code');
  // The relayed body still names exactly the three fields it always did.
  assert.ok(/surface: b\.surface, text: b\.text, submit: b\.submit/.test(block), 'the relayed allowlist is unchanged');
});
