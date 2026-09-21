'use strict';
// p18 STORY-001 — epoch-bound cmux-shaped ids for the tmux backend (specs.md §5.3).
// Pure: no tmux, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ids = require('../lib/tmux-ids');

// Copied verbatim from bridge.js:40-47 — and the test below proves the bridge still says exactly this.
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const SURFACE_RE = new RegExp(`^(surface:\\d+|${UUID})$`);
const WORKSPACE_RE = new RegExp(`^(workspace:\\d+|${UUID})$`);
const PANE_RE = new RegExp(`^(pane:\\d+|${UUID})$`);

const EPOCH = 1789991468;
const NS = [0, 1, 12, 2147483648];

test('the copied regexes are the ones bridge.js ships', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  assert.ok(src.includes("const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';"));
  assert.ok(src.includes('const SURFACE_RE = new RegExp(`^(surface:\\\\d+|${UUID})$`);'));
  assert.ok(src.includes('const WORKSPACE_RE = new RegExp(`^(workspace:\\\\d+|${UUID})$`);'));
  assert.ok(src.includes('const PANE_RE = new RegExp(`^(pane:\\\\d+|${UUID})$`);'));
});

test('mint -> parse round-trips for every kind and n in {0, 1, 12, 2^31}', () => {
  for (const kind of [1, 2, 3, 4]) {
    for (const n of NS) {
      const id = ids.mint(kind, EPOCH, n);
      assert.equal(id, id.toLowerCase());
      assert.deepEqual(ids.parse(id), { kind, epoch: EPOCH >>> 0, n }, id);
      // also through the name form of the kind
      assert.equal(ids.mint(ids.KIND_NAME[kind], EPOCH, n), id);
    }
  }
});

test('the documented example mints what specs.md §5.3 describes (epoch hex, kind, pane number)', () => {
  const id = ids.mint(4, 1789991468, 12);
  assert.equal(id, `${(1789991468).toString(16)}-0004-4000-8000-00000000000c`);
  assert.equal(id, '6ab11a2c-0004-4000-8000-00000000000c');
});

test('every minted id matches the UUID branch of SURFACE_RE, WORKSPACE_RE and PANE_RE', () => {
  for (const kind of [1, 2, 3, 4]) {
    for (const n of NS) {
      const id = ids.mint(kind, EPOCH, n);
      assert.match(id, SURFACE_RE);
      assert.match(id, WORKSPACE_RE);
      assert.match(id, PANE_RE);
      assert.match(id, new RegExp(`^${UUID}$`));   // the UUID branch, not a ref
    }
  }
});

test('parse refuses a random v4 UUID and a ref', () => {
  assert.equal(ids.parse('9f1c2d3e-5b6a-4c7d-8e9f-0a1b2c3d4e5f'), null);
  for (let i = 0; i < 200; i++) assert.equal(ids.parse(crypto.randomUUID()), null);
  assert.equal(ids.parse('surface:12'), null);
  assert.equal(ids.parse(''), null);
  assert.equal(ids.parse(undefined), null);
});

test('a stale epoch and a wrong kind are detectable from the parsed id', () => {
  const live = EPOCH;
  const stale = ids.parse(ids.mint(4, live - 60, 3));
  assert.equal(ids.sameEpoch(stale.epoch, live), false);
  assert.equal(ids.sameEpoch(ids.parse(ids.mint(4, live, 3)).epoch, live), true);
  assert.equal(ids.parse(ids.mint(3, live, 3)).kind, ids.KIND.pane);
  assert.notEqual(ids.parse(ids.mint(3, live, 3)).kind, ids.KIND.surface);
});

test('ref / parseRef', () => {
  assert.equal(ids.ref(1, 0), 'window:0');
  assert.equal(ids.ref(2, 5), 'workspace:5');
  assert.equal(ids.ref('pane', 7), 'pane:7');
  assert.equal(ids.ref(4, 12), 'surface:12');
  assert.equal(ids.parseRef('surface:12', 4), 12);
  assert.equal(ids.parseRef('surface:12', 'surface'), 12);
  assert.equal(ids.parseRef('pane:12', 4), null);          // right number, wrong kind
  assert.equal(ids.parseRef('surface:x', 4), null);
  assert.equal(ids.parseRef(ids.mint(4, EPOCH, 12), 4), null);
});

test('surfaceFromEnv: TMUX_PANE + CMUX_TMUX_EPOCH (+ a matching server pid) -> the surface id; else ""', () => {
  // review fix 2: the pid in $TMUX must be the one ensure() exported as CMUX_TMUX_PID, so a tmux
  // started inside a pane (which inherits both CMUX_TMUX_* variables) cannot claim the outer ids
  const OK = { TMUX_PANE: '%12', CMUX_TMUX_EPOCH: '1789991468', CMUX_TMUX_PID: '4242', TMUX: '/private/tmp/x/s,4242,0' };
  assert.equal(ids.surfaceFromEnv(OK), ids.mint(4, 1789991468, 12));
  // the story's two-variable form is no longer enough on its own
  assert.equal(ids.surfaceFromEnv({ TMUX_PANE: '%12', CMUX_TMUX_EPOCH: '1789991468' }), '');
  // the AC's malformed TMUX_PANE values; '12' is a well-formed EPOCH, so the epoch list differs
  for (const v of ['12', '%x', 'abc', '%', '%12x']) {
    assert.equal(ids.surfaceFromEnv({ ...OK, TMUX_PANE: v }), '', `TMUX_PANE=${v}`);
  }
  for (const v of ['%x', 'abc', '%12', '1.5', '-1', '']) {
    assert.equal(ids.surfaceFromEnv({ ...OK, CMUX_TMUX_EPOCH: v }), '', `CMUX_TMUX_EPOCH=${v}`);
  }
  // a nested server: its own pid in $TMUX, the outer pid inherited in CMUX_TMUX_PID
  assert.equal(ids.surfaceFromEnv({ ...OK, TMUX: '/private/tmp/x/inner,5151,0' }), '');
  assert.equal(ids.surfaceFromEnv({ ...OK, TMUX: '' }), '');
  assert.equal(ids.surfaceFromEnv({ ...OK, CMUX_TMUX_PID: '' }), '');
  assert.equal(ids.surfaceFromEnv({ ...OK, CMUX_TMUX_PID: 'x' }), '');
  // a socket path containing a comma still reads the pid from the right field
  assert.equal(ids.surfaceFromEnv({ ...OK, TMUX: '/tmp/a,b/s,4242,3' }), ids.mint(4, 1789991468, 12));
  assert.equal(ids.surfaceFromEnv({}), '');
  assert.equal(ids.surfaceFromEnv(undefined), '');
});
