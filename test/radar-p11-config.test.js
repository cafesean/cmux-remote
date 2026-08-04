'use strict';
// p11 S-001 — the operator config knobs, and the two ways this file has already been observed to
// go wrong in its p5/p6 ancestors.
//
// 1. THE WHITELIST IS THE TRAP. normalizeConfig builds an explicit object literal, so a key added
//    to DEFAULTS but forgotten in that literal is DROPPED and reads as its default forever — and
//    a test that only checks "the default is right" passes against exactly that bug, because the
//    dropped key's value IS the default. So every knob here is asserted with a NON-DEFAULT value
//    that must survive the round trip. That is the arm the forgotten-in-the-literal bug fails.
//
// 2. NESTED DEFAULTS ARE SHARED BY REFERENCE. Two paths in normalizeConfig hand DEFAULTS straight
//    back (root-not-an-object, unknown configVersion). `timeouts` was copied inline at both sites;
//    p11 adds two more nested blocks, so the inline form becomes a bug waiting for whoever adds a
//    fourth and copies three. The isolation arm below mutates what it is given and then re-reads a
//    FRESH config — if the blocks were shared, the second read carries the first read's mutation.
//
// 3. `dispatch.enabled` IS THE AUTONOMY SWITCH (§8.1) and is the one key in this file where a
//    permissive coercion is a safety defect rather than a papercut: a config saying "false" (the
//    STRING) must not read as true, and a config saying 1 must not read as true either. Strict
//    boolean-only is asserted against both, in both directions.
//
// House rule under test throughout: a bad value SILENTLY CLAMPS or falls to its default and pushes
// NO issue (radar/config.js:104-106). This file asserts the silence explicitly — a future author
// who "improves" one knob into pushing an issue will fail here and read why.
const test = require('node:test');
const assert = require('node:assert');

const { DEFAULTS, normalizeConfig, CONFIG_VERSION } = require('../radar/config.js');

const base = (over) => Object.assign({ configVersion: CONFIG_VERSION }, over);

test('p11 config: defaults are exactly the specified values', () => {
  const { config } = normalizeConfig(base({}));
  assert.deepStrictEqual(config.resume, { minIdleSec: 90, maxIdleHours: 24, requireSurface: true });
  assert.deepStrictEqual(config.dispatch, { enabled: false, authorityTokenRef: 'RADAR_OPERATOR_TOKEN' });
});

test('p11 config: dispatch is OFF by default — autonomy is opt-in', () => {
  const { config } = normalizeConfig(base({}));
  assert.strictEqual(config.dispatch.enabled, false);
});

// The whitelist arm: non-default values must survive. A key present in DEFAULTS but missing from
// normalizeConfig's literal silently returns the default and would pass a defaults-only test.
test('p11 config: non-default values survive the whitelist round trip', () => {
  const { config } = normalizeConfig(base({
    resume: { minIdleSec: 30, maxIdleHours: 6, requireSurface: false },
    dispatch: { enabled: true, authorityTokenRef: 'SOME_OTHER_TOKEN_REF' },
  }));
  assert.deepStrictEqual(config.resume, { minIdleSec: 30, maxIdleHours: 6, requireSurface: false });
  assert.deepStrictEqual(config.dispatch, { enabled: true, authorityTokenRef: 'SOME_OTHER_TOKEN_REF' });
});

test('p11 config: partial blocks keep the untouched keys at their defaults', () => {
  const { config } = normalizeConfig(base({ resume: { maxIdleHours: 2 }, dispatch: { enabled: true } }));
  assert.deepStrictEqual(config.resume, { minIdleSec: 90, maxIdleHours: 2, requireSurface: true });
  assert.deepStrictEqual(config.dispatch, { enabled: true, authorityTokenRef: 'RADAR_OPERATOR_TOKEN' });
});

test('p11 config: a non-object block is ignored wholesale, silently', () => {
  for (const bad of ['nope', 42, [], null, true]) {
    const { config, issues } = normalizeConfig(base({ resume: bad, dispatch: bad }));
    assert.deepStrictEqual(config.resume, DEFAULTS.resume, `resume for ${JSON.stringify(bad)}`);
    assert.deepStrictEqual(config.dispatch, DEFAULTS.dispatch, `dispatch for ${JSON.stringify(bad)}`);
    assert.deepStrictEqual(issues.filter((i) => /resume|dispatch/.test(i)), [], 'house rule: no issue pushed');
  }
});

// The clamp arm. num() clamps into [min,max] and never reports; assert both the clamping and the
// silence, because "it was rejected" and "it was clamped" are different behaviors with the same
// happy-path symptom.
test('p11 config: numerics clamp into range and push no issue', () => {
  const cases = [
    [{ minIdleSec: -5 }, 'minIdleSec', 0],
    [{ minIdleSec: 999999 }, 'minIdleSec', 86400],
    [{ maxIdleHours: 0 }, 'maxIdleHours', 1],
    [{ maxIdleHours: 99999 }, 'maxIdleHours', 720],
  ];
  for (const [over, key, expected] of cases) {
    const { config, issues } = normalizeConfig(base({ resume: over }));
    assert.strictEqual(config.resume[key], expected, `${key} from ${JSON.stringify(over)}`);
    assert.deepStrictEqual(issues.filter((i) => /resume/.test(i)), [], 'house rule: no issue pushed');
  }
});

// `num` is the SHARED helper every p5/p6 knob already goes through, and it splits garbage into two
// groups rather than one, because it tests `Number.isFinite(Number(v))`:
//
//   Number('ninety') Number({}) NaN undefined  -> NaN     -> the default
//   Number(null)     Number([])                -> 0       -> FINITE, so it clamps into range
//
// So `minIdleSec: null` reads as 0, not as 90. That is surprising, and it is deliberately NOT
// "fixed" here: `num` is used by every numeric key in p5 and p6, and changing it would silently
// move their semantics too. It is pinned instead, so the behavior is documented and a future
// change to the shared helper fails HERE with an explanation rather than somewhere downstream.
//
// The safety consequence is bounded and worth stating: minIdleSec at 0 removes only the anti-race
// wait after a turn ends. It cannot create a two-writer violation, because eligibility still
// requires `status === 'idle'` independently (§M4.1).
test('p11 config: NaN-coercing garbage takes the default', () => {
  for (const bad of ['ninety', {}, NaN, undefined]) {
    const { config } = normalizeConfig(base({ resume: { minIdleSec: bad } }));
    assert.strictEqual(config.resume.minIdleSec, 90, `minIdleSec for ${String(bad)}`);
  }
});

test('p11 config: zero-coercing garbage clamps to the floor (pinned shared-helper behavior)', () => {
  for (const zeroish of [null, []]) {
    const { config } = normalizeConfig(base({ resume: { minIdleSec: zeroish, maxIdleHours: zeroish } }));
    assert.strictEqual(config.resume.minIdleSec, 0, `minIdleSec for ${JSON.stringify(zeroish)}`);
    assert.strictEqual(config.resume.maxIdleHours, 1, `maxIdleHours floors at 1, not 0`);
  }
});

// The safety arm. Truthy/falsy coercion here would let `"false"` enable autonomous dispatch.
test('p11 config: booleans are strict — only a real boolean moves the switch', () => {
  for (const bad of ['true', 'false', 1, 0, 'yes', 'on', null, {}, []]) {
    const { config } = normalizeConfig(base({ dispatch: { enabled: bad }, resume: { requireSurface: bad } }));
    assert.strictEqual(config.dispatch.enabled, false, `dispatch.enabled must stay false for ${JSON.stringify(bad)}`);
    assert.strictEqual(config.resume.requireSurface, true, `requireSurface must stay true for ${JSON.stringify(bad)}`);
  }
  // ...and a real boolean does move it, in both directions.
  assert.strictEqual(normalizeConfig(base({ dispatch: { enabled: true } })).config.dispatch.enabled, true);
  assert.strictEqual(normalizeConfig(base({ resume: { requireSurface: false } })).config.resume.requireSurface, false);
});

test('p11 config: authorityTokenRef names an env var and never holds a value', () => {
  const { config } = normalizeConfig(base({ dispatch: { authorityTokenRef: '   ' } }));
  assert.strictEqual(config.authorityTokenRef, undefined, 'no stray top-level key');
  assert.strictEqual(config.dispatch.authorityTokenRef, 'RADAR_OPERATOR_TOKEN', 'blank falls to default');
});

// The isolation arm — the reason freshDefaults() exists. Both early-return paths are covered
// because they are separate `return` statements and a fix applied to one is routinely missed.
test('p11 config: nested defaults are copied, not shared (root not an object)', () => {
  const first = normalizeConfig(null).config;
  first.resume.minIdleSec = 12345;
  first.dispatch.enabled = true;
  first.timeouts.bridgeMs = 1;
  const second = normalizeConfig(null).config;
  assert.strictEqual(second.resume.minIdleSec, 90);
  assert.strictEqual(second.dispatch.enabled, false);
  assert.strictEqual(second.timeouts.bridgeMs, 8000);
  assert.strictEqual(DEFAULTS.resume.minIdleSec, 90, 'module defaults must be untouched');
  assert.strictEqual(DEFAULTS.dispatch.enabled, false, 'module defaults must be untouched');
});

test('p11 config: nested defaults are copied, not shared (unknown configVersion)', () => {
  const first = normalizeConfig({ configVersion: 999 }).config;
  first.resume.maxIdleHours = 777;
  first.dispatch.authorityTokenRef = 'MUTATED';
  const second = normalizeConfig({ configVersion: 999 }).config;
  assert.strictEqual(second.resume.maxIdleHours, 24);
  assert.strictEqual(second.dispatch.authorityTokenRef, 'RADAR_OPERATOR_TOKEN');
  assert.strictEqual(DEFAULTS.resume.maxIdleHours, 24, 'module defaults must be untouched');
});

// p11 does not route jira config through this function (mod-jira reads the block raw). Asserting
// the ABSENCE keeps a future author from adding a second, silently-unused copy of the setting.
test('p11 config: jira/agile is NOT in the normalized config — mod-jira reads it raw', () => {
  const { config } = normalizeConfig(base({ jira: { baseUrl: 'https://jira.example.com', agile: { enabled: true } } }));
  assert.strictEqual(config.jira, undefined);
  assert.strictEqual(config.agile, undefined);
});
