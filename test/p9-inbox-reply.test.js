'use strict';
// p9 S-007 — the lease's release condition, which `test/p9-reply-gates.test.js` proves for the two
// cases §5.5 names and this file proves for the third it does not.
//
// §5.5 step 4 says the `send_unconfirmed` and `text_inserted_submit_failed` leases NEVER
// time-expire, and that "their only release is a complete fold showing a NEW turn". Three things can
// come back from the re-read, not two:
//
//   * a complete fold, same turn  -> 409 already_answered   (covered there)
//   * a complete fold, new turn   -> release, proceed        (covered there)
//   * a COMPLETE READ WITH NO FOLD AT ALL -> this file
//
// The third is not a fold showing a new turn, so it may not release anything. It is also not
// hypothetical: the retained window is a moving 48-hour boundary over day files, so a session can
// stop appearing in a perfectly healthy read — a prune, the boundary passing the last event, a
// bridge whose day file rolled between two requests. Nothing about that read says the operator's
// question was answered.
//
// What the bug costs is the whole point of the story. §6.1 marks both outcomes NOT RETRYABLE
// because the text may already be sitting in the pane; the lease is the only thing enforcing that.
// Release it on a momentary gap and the next request with the SAME turn token runs the entire
// pipeline again — gate 1 passes, because the turn really is unchanged — and types the same reply
// into the same tab a second time. The regression below drives exactly that sequence and asserts
// the bridge sees one send, not two.
//
// Every fixture is synthesised: invented ids on the reserved `fixture-inbox-N` grammar, invented
// machine, tab and workspace names, invented text and timestamps.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createRadar } = require('../radar-server');

const MACHINE = 'fixture-remote';
const BASE = 'http://fixture-remote.invalid:8799';
const SESSION = 'fixture-inbox-1';
const TAB = 'fixture-tab-uuid-1';
const SEQ = 41;
const REPLY_TEXT = 'Option A.';

const NOW = Date.parse('2026-01-02T03:05:00.000Z');
const T_STOP = Date.parse('2026-01-02T02:58:57.000Z');
const T_BLOCK = Date.parse('2026-01-02T03:00:00.000Z');
const ASSISTANT_TS = '2026-01-02T02:58:57.000Z';
const TURN = { blockedSince: new Date(T_BLOCK).toISOString(), assistantTs: ASSISTANT_TS };
// §5.5 step 4's `ok` window. Used here only to step past it, proving a release came from a new turn
// rather than from a timer; the boundary itself is pinned in test/p9-reply-gates.test.js.
const REPLY_LEASE_WINDOW = 120000;

// A grid whose OWN evidence proves `agent`: the boxed prompt sits below the shell prompt that
// launched it. Gate 3 reads nothing else — status is never consulted.
const STYLES = [
  { id: 0, background: '#000000', foreground: '#999999' },
  { id: 1, background: '#1A1A1A', foreground: '#FFFFFF' },
];
const AGENT_GRID = {
  active_screen: 'primary', styles: STYLES,
  row_spans: [
    { row: 0, column: 0, style_id: 1, text: ' demo@fixture  ~ ' },
    { row: 2, column: 0, style_id: 0, text: '────────────────' },
    { row: 3, column: 0, style_id: 0, text: '❯ ' },
    { row: 4, column: 0, style_id: 0, text: '────────────────' },
  ],
};
const TREE = {
  workspaces: [{
    ref: 'fixture-workspace',
    title: 'fixture-workspace',
    tabs: [{ id: TAB, ref: 'tab-2', type: 'terminal', status: '', statusCovered: true }],
  }],
};

// A REMOTE bridge, because the gap is easiest to state honestly there: the events arrive as a page
// the test controls outright, and `{events: [], more: false, skipped: 0}` is an unambiguously
// COMPLETE read that simply does not carry this session. The same fact reaches a local bridge
// through the retention boundary; the route cannot tell the two apart, which is the point.
async function harness(over) {
  const o = over || {};
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-reply-lease-')));
  const tp = path.join(dir, 'transcript.jsonl');
  await fsp.writeFile(tp, `${JSON.stringify({
    type: 'assistant', timestamp: ASSISTANT_TS, message: { content: [{ type: 'text', text: 'A or B?' }] },
  })}\n`);
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({
    configVersion: 1,
    role: 'leader',
    // Pinned so the implicit local bridge can never be this machine's real hostname: the repository
    // is public and a test's fixtures are shipped bytes.
    collectorId: 'fixture-box',
    repos: [],
    timeouts: { bridgeMs: 8000 },
    bridges: [{ id: MACHINE, baseUrl: BASE }],
  }, null, 2));

  const blocked = [
    { ts: T_STOP, sessionId: SESSION, event: 'Stop', transcriptPath: tp },
    {
      ts: T_BLOCK, sessionId: SESSION, event: 'Notification', notificationType: 'idle_prompt',
      transcriptPath: tp, surfaceId: TAB,
    },
  ];

  const state = { events: blocked, sendAnswer: o.sendAnswer };
  const calls = [];
  const stub = async (url, opts) => {
    const kind = /session-events/.test(url) ? 'events'
      : /\/cmux\/tree/.test(url) ? 'tree'
        : /\/cmux\/grid/.test(url) ? 'grid' : 'send';
    calls.push({ kind, body: (opts || {}).body });
    if (kind === 'events') {
      return { ok: true, status: 200, json: { events: state.events, more: state.more === true, skipped: state.skipped || 0 } };
    }
    if (kind === 'tree') return { ok: true, status: 200, json: TREE };
    if (kind === 'grid') return { ok: true, status: 200, json: { seq: SEQ, grid: AGENT_GRID } };
    return state.sendAnswer;
  };

  const radar = createRadar({
    radarDir: dir,
    scanOnStart: false,
    log: () => {},
    env: { SERVER_TOKEN: 'fixture-token' },
    now: () => state.now || NOW,
    // No real timer may exist in a test that never fires one.
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    bridgeHttp: stub,
    inboxLog: () => {},
  });

  // The body is fed after handle() is called: readJsonBody attaches its listeners on the way in.
  const post = async () => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = {};
    req.destroy = () => {};
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.headersSent = false;
    res.writeHead = (c) => { res.status = c; res.headersSent = true; return res; };
    res.end = (b) => { res.writableEnded = true; res.raw = b; };
    const p = radar.handle(req, res, new URL('http://x/api/radar/inbox/reply'));
    req.emit('data', Buffer.from(JSON.stringify({
      machine: MACHINE, sessionId: SESSION, text: REPLY_TEXT, turn: TURN,
    }), 'utf8'));
    req.emit('end');
    await p;
    return { status: res.status, body: res.raw === undefined ? null : JSON.parse(res.raw) };
  };

  return {
    dir,
    post,
    state,
    blocked,
    sends: () => calls.filter((c) => c.kind === 'send'),
    countOf: (kind) => calls.filter((c) => c.kind === kind).length,
    cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); },
  };
}

// The two uncertain writes, driven identically. Both are §6.1 rows marked NOT RETRYABLE, and both
// leases exist for the same reason: the text may already be in the pane.
const UNCERTAIN = [
  ['send_unconfirmed', { ok: false, status: 502, json: { error: 'text_command_unconfirmed' } }],
  ['text_inserted_submit_failed', { ok: false, status: 502, json: { error: 'submit_failed_text_inserted' } }],
];

test('a complete read carrying NO fold does not release an uncertain-write lease — and the same reply is never typed twice', async () => {
  for (const [code, answer] of UNCERTAIN) {
    const h = await harness({ sendAnswer: answer });
    try {
      // 1. The uncertain write. Its side effect is unproved, so §6.1 refuses to call it retryable
      //    and the lease is what makes that refusal real.
      const first = await h.post();
      assert.strictEqual(first.body.code, code);
      assert.strictEqual(h.sends().length, 1, `${code}: one send so far`);

      // 2. The lease works while the session is visible: same turn, refused, pane untouched.
      const held = await h.post();
      assert.strictEqual(held.body.code, 'already_answered', `${code}: the lease refuses a same-turn retry`);
      assert.strictEqual(h.sends().length, 1);

      // 3. THE GAP. A complete, error-free, untruncated read that simply no longer carries this
      //    session. It is not a fold showing a new turn — it is no fold at all, and it proves
      //    nothing about whether the question was answered.
      h.state.events = [];
      const gap = await h.post();
      assert.strictEqual(gap.body.code, 'session_not_found',
        `${code}: with no fold the request falls through to gate 1, which refuses without typing`);
      assert.strictEqual(h.sends().length, 1, `${code}: the gap itself must never reach the bridge`);

      // 4. The session comes back, carrying THE SAME TURN — byte for byte the blockedSince the
      //    lease recorded. Gate 1 would happily pass it, because the turn genuinely has not moved:
      //    the lease is the only thing standing between this request and a second blind write.
      h.state.events = h.blocked;
      const after = await h.post();
      assert.strictEqual(after.body.code, 'already_answered',
        `${code}: a lease §6.1 marks not-retryable survives a momentary gap in the retained events`);
      assert.strictEqual(h.sends().length, 1,
        `${code}: the same reply must never be typed into the same pane twice`);
      const texts = h.sends().map((c) => JSON.parse(c.body).text);
      assert.deepStrictEqual(texts, [REPLY_TEXT]);
    } finally { await h.cleanup(); }
  }
});

test('the gap does not weaken the ONE release either: a genuinely new turn still releases the lease and proceeds', async () => {
  // The guard above must not become "the lease is permanent". §5.5's single release condition still
  // has to work after a gap, or a session that really did move on would be frozen out of the inbox.
  for (const [code, answer] of UNCERTAIN) {
    const h = await harness({ sendAnswer: answer });
    try {
      assert.strictEqual((await h.post()).body.code, code);
      h.state.events = [];
      assert.strictEqual((await h.post()).body.code, 'session_not_found');

      // Past the `ok` lease window, so the release below is provably the NEW TURN and not the
      // clock. Deliberately NOT a day: `sessionStatusOf` flips a session to `abandoned` after
      // ABANDON_MS (4 h), and an abandoned session answers `already_answered` at gate 1 — which
      // would make this test pass for the wrong reason and prove nothing about the lease.
      h.state.now = NOW + REPLY_LEASE_WINDOW + 10000;
      h.state.events = h.blocked.map((e) => (e.event === 'Notification' ? Object.assign({}, e, { ts: T_BLOCK + 90000 }) : e));
      const stillHeld = await h.post();
      assert.strictEqual(stillHeld.body.code, 'question_changed',
        'the lease released on the new turn, and gate 1 then refused the STALE token the client sent');
      // The release is real — the request reached gate 1 rather than being short-circuited — and it
      // still never reached the pane, because the token the client held was the old one.
      assert.strictEqual(h.sends().length, 1, `${code}: gate 1 refuses a stale token without typing`);
    } finally { await h.cleanup(); }
  }
});

test('a lease is never released by an unreadable re-read either — the two failure directions are distinct', async () => {
  // The sibling rule, kept beside the one above because they are easy to conflate: an INCOMPLETE
  // read is 502 events_unavailable with the lease retained, while a COMPLETE read with no fold is
  // session_not_found with the lease retained. Different codes, same guard, neither one a release.
  const h = await harness({ sendAnswer: UNCERTAIN[0][1] });
  try {
    assert.strictEqual((await h.post()).body.code, 'send_unconfirmed');

    // INCOMPLETE, two ways. The page was truncated, or a file could not be parsed: either way the
    // history is not authoritative and the read may not be allowed to decide anything.
    for (const [why, patch] of [['more', { more: true }], ['skipped', { skipped: 1 }]]) {
      h.state.events = [];
      Object.assign(h.state, patch);
      const bad = await h.post();
      assert.strictEqual(bad.body.code, 'events_unavailable', `${why}: fail closed`);
      assert.strictEqual(h.sends().length, 1, `${why}: nothing typed`);
      h.state.more = false;
      h.state.skipped = 0;
    }

    // COMPLETE but carrying no fold: a different code, the same retained guard.
    h.state.events = [];
    assert.strictEqual((await h.post()).body.code, 'session_not_found');
    assert.strictEqual(h.sends().length, 1);

    // And the lease is still standing at the end of all of it.
    h.state.events = h.blocked;
    assert.strictEqual((await h.post()).body.code, 'already_answered');
    assert.strictEqual(h.sends().length, 1, 'four re-reads, zero extra sends');
  } finally { await h.cleanup(); }
});
