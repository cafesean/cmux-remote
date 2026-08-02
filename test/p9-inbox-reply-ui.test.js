'use strict';
// STORY-009 — reply, refresh, and every state that is not success (spec §5.6, §6.1).
//
// Round 3 of the spec review found that v1.2 had pushed every SAFETY behaviour into tier-2 browser
// tests, which made `code_complete` vacuously reachable: the story could be "finished" having proved
// nothing. v1.3 splits the module so the safety behaviour is provable offline, and this file is that
// proof. Four pure units carry all of it —
//
//   copyForCode       the §6.1 map: copy, disable column, re-confirm column, fallback;
//   reconcileRows     canonical-key VALUE equality, and the surface-vs-turn split;
//   the question_changed machine   three states, two disjoint entries, no stale POST reachable;
//   the refresh reducer            one timer, and only while the predicate holds.
//
// — and each is exercised with no DOM at all. The last block drives the real module through a
// minimal DOM stand-in, because a perfect pure layer that nothing calls is the other way this story
// could ship dark.
//
// Everything is synthesised: invented machine ids, invented session ids on the reserved synthetic
// grammar, invented tab ids, invented text, invented timestamps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INBOX = require('../public/inbox.js');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---- synthesised rows --------------------------------------------------------------------------

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// A series of distinct turn identities. `turnAt(0)` is the turn a card opens on; every later index
// is "the question changed while you were typing".
const turnAt = (n) => ({ blockedSince: iso(-600000 + n * 1000), assistantTs: iso(-601000 + n * 1000) });

let seq = 0;
function row(o) {
  const n = ++seq;
  const turn = (o && o.turn) || turnAt(0);
  return Object.assign({
    sessionKey: { machine: 'fixture-machine-a', sessionId: `fixture-inbox-${n}` },
    blockedSince: turn.blockedSince,
    lastStopAt: null,
    cacheExpiresAt: null,
    cacheApprox: true,
    notificationType: 'idle_prompt',
    turn,
    repo: 'fixture-repo',
    worktree: null,
    epic: null,
    question: 'Which branch should this land on?',
    intent: { verdict: 'needs-decision', reason: 'synthetic reason', model: 'fixture-model', at: iso(-60000), inferred: true },
    surface: { workspace: 'fixture-ws', tabRef: 'fixture-tab-ref', tabUuid: 'fixture-tab-a', via: 'recorded' },
    surfaceReason: null,
    answerable: true,
    actions: [{ kind: 'reply' }],
  }, o || {});
}

// The same row, moved to another tab. Same question, same turn — only the pane changed.
const onTab = (r, tabUuid) => Object.assign({}, r, {
  surface: Object.assign({}, r.surface, { tabUuid }),
});

// The same row, carrying a NEW turn. `blockedSince` moves with it, as the producer emits it.
const onTurn = (r, n) => Object.assign({}, r, { turn: turnAt(n), blockedSince: turnAt(n).blockedSince });

// The same row with no live join at all — the shape a `tree-unavailable` sweep publishes.
const unjoined = (r, surfaceReason) => Object.assign({}, r, {
  surface: null, surfaceReason: surfaceReason || 'tree-unavailable', answerable: false, actions: [],
});

// A card state, open on `openRow`, with whatever the test needs overridden on top.
function stateWith(rows, openRow, over) {
  return { rows, card: Object.assign(INBOX.openCardState(openRow), over || {}) };
}

const payloadOf = (items, o) => Object.assign({ items, generatedAt: iso(0), sources: { classifier: 'ok' } }, o || {});

// ================================================================================================
// AC 1 (tier-1) — copyForCode covers every §6.1 FAILURE row, and the success row has NO copy
// ================================================================================================

// Byte-for-byte from specs.md §6.1. The separators are em dashes (U+2014), the ellipsis is a single
// U+2026, and every apostrophe is ASCII. This literal table is written out independently of the
// module's so that a typo in one is a failure rather than a shared mistake.
const SIX_ONE = [
  ['bad_json', 'Malformed request.', false],
  ['bad_request', 'Malformed request.', false],
  ['unknown_machine', 'No bridge is configured for this machine.', false],
  ['empty_reply', 'Reply is empty.', false],
  ['body_too_large', 'Reply exceeds the request size cap.', false],
  ['reply_too_large', 'Reply exceeds 8192 bytes.', false],
  ['unauthenticated_server', 'Set SERVER_TOKEN to enable replies.', false],
  ['viewer_refused', 'This install is a viewer — answer from the leader.', false],
  ['session_not_found', 'No trace of this session in the retained events.', true],
  ['already_answered', 'This session is no longer waiting.', true],
  ['question_changed', 'The question changed — waiting for the update…', true],
  ['surface_reassigned', 'Another session has taken over this tab.', true],
  ['not_text_answerable', 'This session is waiting at a permission prompt — open the tab to answer it.', true],
  ['tab_gone', "This session's tab is closed.", true],
  ['not_at_prompt', "The tab isn't at a Claude prompt right now.", false],
  ['pane_changed', 'The tab changed while sending — nothing was sent.', false],
  ['events_unavailable', "The event log isn't readable right now — nothing was sent.", false],
  ['bridge_unreachable', "The machine isn't reachable right now.", false],
  ['send_failed', 'Sending failed — nothing was typed into the tab.', false],
  ['send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
  ['text_inserted_submit_failed', 'Text was placed in the tab but not submitted — finish it there.', true],
];

test('AC1 · every §6.1 failure row maps to its exact copy and its exact disable rule', () => {
  assert.equal(SIX_ONE.length, 21, 'all 21 failure rows of §6.1 are covered');
  for (const [code, copy, disable] of SIX_ONE) {
    const out = INBOX.copyForCode(code);
    assert.ok(out, `${code} must have an entry`);
    assert.equal(out.text, copy, `wrong copy for ${code}`);
    assert.equal(out.disableSend, disable, `wrong disable rule for ${code}`);
    // Only ONE row of the table re-confirms, and it is the one the machine exists for.
    assert.equal(out.requiresReconfirm, code === 'question_changed', `wrong reconfirm rule for ${code}`);
  }
});

test('AC1 · the 200 ok row is the one row with NO copy — success renders no sentence', () => {
  // Not the empty string, not a blank sentence: nothing at all. The success path clears the field
  // and closes the card, and a caller that renders `copy.text` unconditionally would print "".
  assert.equal(INBOX.copyForCode('ok'), null);
});

test('AC1 · nonsense, undefined and a non-JSON marker all reach the fallback, Send still live', () => {
  const fallback = "Couldn't send — your reply is still here.";
  const inputs = [
    'nonsense', undefined, null, 42, {}, '',
    INBOX.REPLY_NON_JSON, INBOX.REPLY_NETWORK_ERROR, INBOX.REPLY_UNAUTHORIZED,
    // A shared-server 401 body carries this, and it is not a §6.1 code.
    'unauthorized',
    // Values that would inherit off Object.prototype if the map had one.
    'constructor', 'toString', 'hasOwnProperty', '__proto__',
  ];
  for (const v of inputs) {
    const out = INBOX.copyForCode(v);
    assert.ok(out, `${String(v)} must still produce copy`);
    assert.equal(out.text, fallback, `${String(v)} must reach the fallback`);
    assert.equal(out.disableSend, false, `${String(v)} must NOT disable Send — it is retryable`);
    assert.equal(out.requiresReconfirm, false);
    assert.equal(out.code, null, 'the fallback names no code');
  }
  assert.equal(INBOX.REPLY_FALLBACK_COPY, fallback);
});

test('AC1 · the load-bearing characters are the ones the spec wrote, not lookalikes', () => {
  const waiting = INBOX.copyForCode('question_changed').text;
  const dash = waiting.indexOf('—');
  assert.ok(dash !== -1 && waiting.codePointAt(dash) === 0x2014, 'an em dash (U+2014), not a hyphen');
  assert.ok(waiting.indexOf(' - ') === -1, 'and not a hyphen-minus with spaces');
  // ONE ellipsis character, not three full stops.
  assert.equal(waiting.codePointAt(waiting.length - 1), 0x2026, 'the sentence ends in U+2026');
  assert.ok(waiting.indexOf('...') === -1, 'never three periods');
  assert.equal(INBOX.QUESTION_CHANGED_REVIEW.codePointAt(INBOX.QUESTION_CHANGED_REVIEW.indexOf('—')), 0x2014);
  // Apostrophes are ASCII throughout — a typographic one would render, and compare, differently.
  for (const [, copy] of SIX_ONE) {
    for (const ch of copy) {
      const c = ch.codePointAt(0);
      assert.ok(c !== 0x2019, `${copy} must use an ASCII apostrophe`);
    }
  }
});

test('AC1 · sentences the spec says are the SAME sentence really are — no drift between the maps', () => {
  // §6.1 and §5.6's read-only vocabulary overlap in four places. Two independent literals that are
  // supposed to be one string is exactly how a copy table rots.
  assert.equal(INBOX.copyForCode('not_text_answerable').text, INBOX.PERMISSION_COPY);
  assert.equal(INBOX.copyForCode('tab_gone').text, INBOX.SURFACE_REASON_COPY['recorded-tab-gone']);
  assert.equal(INBOX.copyForCode('bridge_unreachable').text, INBOX.SURFACE_REASON_COPY['tree-unavailable']);
  assert.equal(INBOX.copyForCode('already_answered').text, INBOX.VANISHED_COPY);
  // And the two question_changed sentences are DIFFERENT sentences with different owners.
  assert.notEqual(INBOX.copyForCode('question_changed').text, INBOX.QUESTION_CHANGED_REVIEW);
});

// ================================================================================================
// AC 2 (tier-1) — reconcileRows compares by VALUE, never by object identity
// ================================================================================================

// The same data written out with every object's keys in the opposite order. Two payloads that say
// the same thing rarely arrive byte-identical, and nothing in the contract says they must.
function reorder(v) {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice().reverse()) out[k] = reorder(v[k]);
    return out;
  }
  return v;
}

test('AC2 · prev and next parsed from two SEPARATE JSON strings are all "keep", and the card survives', () => {
  const base = row({});
  const other = row({});
  // Two genuinely different JSON strings — different key order AND different whitespace — that mean
  // exactly the same thing. An identity comparison could not even start, and a stringify comparison
  // would call every row changed.
  const a = JSON.stringify({ items: [base, other] });
  const b = JSON.stringify({ items: reorder([base, other]) }, null, 2);
  assert.notEqual(a, b, 'the two payloads are not the same text');
  const prev = JSON.parse(a).items;
  const next = JSON.parse(b).items;

  assert.notEqual(prev[0], next[0], 'the two payloads share no object — identity comparison is impossible');
  assert.notEqual(JSON.stringify(prev[0]), JSON.stringify(next[0]), 'and stringify would disagree too');
  assert.equal(INBOX.rowKey(prev[0]), INBOX.rowKey(next[0]), 'the canonical key is a VALUE');
  assert.equal(INBOX.valueEqual(prev[0], next[0]), true, 'and so is the row comparison');

  const out = INBOX.reconcileRows(prev, next, { key: INBOX.rowKey(base), row: prev[0], turn: prev[0].turn });
  assert.deepEqual(out.rows.map((r) => r.decision), ['keep', 'keep'], 'every row is keep');
  assert.deepEqual(out.vanished, []);
  assert.equal(out.openCard.survived, true, 'the open card survives a payload that only looks new');
  assert.equal(out.openCard.decision, 'unchanged');
  assert.equal(out.openCard.turnChanged, false);
  assert.equal(out.openCard.surfaceChanged, false);
  assert.equal(out.openCard.field, 'keep', 'nothing moved, so the field node is left exactly where it is');
  assert.equal(out.openCard.machineEvent, null, 'an unchanged row hands the machine nothing');
});

test('AC2 · the open card also survives when reconcileRows is given only its KEY', () => {
  const r = row({});
  const prev = JSON.parse(JSON.stringify([r]));
  const next = JSON.parse(JSON.stringify([r]));
  const out = INBOX.reconcileRows(prev, next, INBOX.rowKey(r));
  assert.equal(out.openCard.survived, true);
  assert.equal(out.openCard.field, 'keep');
});

test('AC2 · a changed row is "replace", a new key is "add", and both are keyed by value', () => {
  const a = row({});
  const b = row({});
  const changed = Object.assign({}, a, { question: 'A different question entirely.' });
  const out = INBOX.reconcileRows([a], [changed, b], null);
  assert.deepEqual(out.rows.map((r) => r.decision), ['replace', 'add']);
  assert.deepEqual(out.vanished, []);
});

test('AC2 · the open card\'s key absent from next -> vanish, Send disabled, draft KEPT', () => {
  const gone = row({});
  const stays = row({});
  const st = stateWith([gone, stays], gone, { draft: 'half a sentence, still mine' });
  const out = INBOX.applyRefresh(st, { ok: true, items: [stays] });

  assert.deepEqual(out.reconciled.vanished, [INBOX.rowKey(gone)]);
  assert.equal(out.reconciled.openCard.survived, false);
  assert.equal(out.reconciled.openCard.decision, 'vanished');
  assert.equal(out.state.card.vanished, true);
  assert.equal(out.state.card.draft, 'half a sentence, still mine', 'the draft is not the payload\'s to delete');
  assert.equal(out.instr.sendEnabled, false, 'nothing to send to');
  assert.equal(out.instr.notice, 'This session is no longer waiting.');
  assert.equal(out.instr.draft, 'half a sentence, still mine');
});

// ================================================================================================
// AC 3 (tier-1) — SURFACE-ONLY and TURN are DIFFERENT EVENTS. Separate assertions, never merged.
// ================================================================================================

test('AC3 · SURFACE-ONLY: same key, new tabUuid, UNCHANGED turn -> remount with the draft, NO notice', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'typed while it was on tab a' });
  assert.equal(st.card.machine, INBOX.MACHINE_READY);

  const moved = onTab(r, 'fixture-tab-b');
  const out = INBOX.applyRefresh(st, { ok: true, items: [moved] });

  const dec = out.reconciled.openCard;
  assert.equal(dec.surfaceChanged, true);
  assert.equal(dec.turnChanged, false, 'the QUESTION did not change — only the pane did');
  assert.equal(dec.decision, 'surface-only');
  assert.equal(dec.field, 'remount', 'a new pane means a new field node');
  assert.equal(dec.machineEvent, null, 'the surface event never writes to the machine');

  assert.equal(out.instr.draft, 'typed while it was on tab a', 'the draft is re-applied VERBATIM');
  assert.equal(out.state.card.draft, 'typed while it was on tab a');
  assert.equal(out.instr.notice, null, 'a surface change creates no notice at all');
  assert.equal(out.state.card.machine, INBOX.MACHINE_READY, 'the machine is untouched');
  assert.equal(out.instr.sendEnabled, true, 'send is enabled iff the FRESH row is answerable');
  assert.equal(out.instr.immediateGet, false, 'a surface change never asks for an extra GET');
});

test('AC3 · SURFACE-ONLY onto a NOT-answerable fresh row leaves send off — the conjunction, not the event', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'still mine' });
  const out = INBOX.applyRefresh(st, { ok: true, items: [unjoined(r)] });
  assert.equal(out.reconciled.openCard.turnChanged, false);
  assert.equal(out.instr.sendEnabled, false);
  assert.equal(INBOX.sendEnabled(false, INBOX.MACHINE_READY), false);
});

test('AC3 · TURN CHANGE with the surface UNCHANGED -> reconfirm-required, review notice, send off', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'typed against the old question' });
  const fresh = onTurn(r, 1);
  assert.equal(INBOX.surfaceOf(fresh), INBOX.surfaceOf(r), 'the pane did not move');

  const out = INBOX.applyRefresh(st, { ok: true, items: [fresh] });
  const dec = out.reconciled.openCard;
  assert.equal(dec.turnChanged, true);
  assert.equal(dec.surfaceChanged, false);
  assert.equal(dec.decision, 'turn-changed');
  assert.equal(dec.field, 'keep', 'the pane did not move, so the field node does not either');

  assert.equal(out.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(out.instr.notice, 'The question changed — review it before sending.');
  assert.equal(out.instr.noticeTappable, true);
  assert.equal(out.instr.sendEnabled, false, 'send stays off until the operator taps');
  assert.equal(out.instr.draft, 'typed against the old question', 'the draft is intact');
  assert.equal(out.instr.immediateGet, false, 'the changed-turn refresh IS the fresh arrival');
});

test('AC3 · TURN CHANGE with the surface ALSO changed is still a turn change — the machine wins', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'typed against the old question' });
  const fresh = onTab(onTurn(r, 1), 'fixture-tab-b');
  const out = INBOX.applyRefresh(st, { ok: true, items: [fresh] });
  const dec = out.reconciled.openCard;
  assert.equal(dec.turnChanged, true);
  assert.equal(dec.surfaceChanged, true);
  assert.equal(dec.decision, 'turn-changed', 'a turn change is a turn change regardless of the pane');
  assert.equal(dec.field, 'remount', 'the pane moved, so the node is rebuilt — with the draft');
  assert.equal(out.instr.draft, 'typed against the old question');
  assert.equal(out.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(out.instr.notice, 'The question changed — review it before sending.');
  assert.equal(out.instr.sendEnabled, false);
});

// ================================================================================================
// AC 4 (tier-1) — ANSWERABILITY LOSS AND RECOVERY on the SAME turn
// ================================================================================================

test('AC4 · tab-a -> null (tree-unavailable) -> tab-b: field unmounts, draft survives, machine untouched', () => {
  const r = row({});
  const draft = 'the answer I had already typed';
  let st = stateWith([r], r, { draft });
  const steps = [];
  const record = (label, out) => {
    steps.push(label);
    // The conjunction, checked at EVERY step, not just at the end.
    assert.equal(out.instr.sendEnabled,
      INBOX.sendEnabled(out.state.card.answerable, out.state.card.machine),
      `${label}: effective send must be answerable AND ready`);
    assert.equal(out.state.card.machine, INBOX.MACHINE_READY, `${label}: the machine is untouched throughout`);
    assert.equal(out.state.card.draft, draft, `${label}: the draft is retained in card state`);
    assert.equal(out.instr.draft, draft, `${label}: and handed to the renderer verbatim`);
  };

  // LOSS — the tree could not be read, so the row has no surface at all.
  const lost = unjoined(r, 'tree-unavailable');
  let out = INBOX.applyRefresh(st, { ok: true, items: [lost] });
  record('loss', out);
  assert.equal(out.reconciled.openCard.turnChanged, false, 'the same question, all the way through');
  assert.equal(out.reconciled.openCard.surfaceChanged, true, 'tab-a -> null IS a surface change; null is a value');
  assert.equal(out.reconciled.openCard.field, 'unmount', 'a read-only card has NO field — existence beats remount');
  assert.equal(out.instr.readOnly, "The machine isn't reachable right now.");
  assert.equal(out.instr.sendEnabled, false, 'send is absent, not merely disabled');
  st = out.state;

  // RECOVERY — the same question, joined to a different pane.
  const back = onTab(r, 'fixture-tab-b');
  out = INBOX.applyRefresh(st, { ok: true, items: [back] });
  record('recovery', out);
  assert.equal(out.reconciled.openCard.turnChanged, false);
  assert.equal(out.reconciled.openCard.field, 'mount', 'the field comes back');
  assert.equal(out.instr.readOnly, null, 'and the read-only sentence goes away');
  assert.equal(out.instr.sendEnabled, true);
  assert.deepEqual(steps, ['loss', 'recovery']);
});

test('AC4 · answerability loss NEVER touches the machine — not even from awaiting-fresh', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'mine', machine: INBOX.MACHINE_AWAITING_FRESH });
  const out = INBOX.applyRefresh(st, { ok: true, items: [unjoined(r)] });
  assert.equal(out.state.card.machine, INBOX.MACHINE_AWAITING_FRESH);
  assert.equal(out.instr.notice, 'The question changed — waiting for the update…',
    'the machine notice survives — a surface event creates none, and clears none');
  assert.equal(out.state.card.draft, 'mine');
});

// ================================================================================================
// AC 5 (tier-1) — THE MACHINE OUTRANKS THE SURFACE
// ================================================================================================

test('AC5 · awaiting-fresh + same STALE turn + changed tab: remount, waiting notice stays, no extra GET', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'the reply the server refused', machine: INBOX.MACHINE_AWAITING_FRESH });
  const out = INBOX.applyRefresh(st, { ok: true, items: [onTab(r, 'fixture-tab-b')] });

  assert.equal(out.reconciled.openCard.surfaceChanged, true);
  assert.equal(out.reconciled.openCard.turnChanged, false, 'the sweep has not caught up yet');
  assert.equal(out.reconciled.openCard.field, 'remount');
  assert.equal(out.instr.draft, 'the reply the server refused', 'remounted VERBATIM');
  assert.equal(out.state.card.machine, INBOX.MACHINE_AWAITING_FRESH, 'the state is exactly where it was');
  assert.equal(out.instr.notice, 'The question changed — waiting for the update…');
  assert.equal(out.instr.sendEnabled, false, 'still disabled — the machine, not the surface, decides');
  assert.equal(out.instr.immediateGet, false, 'no second GET; the one from the POST is the only one');
  assert.equal(INBOX.sendEnabled(out.state.card.answerable, out.state.card.machine), out.instr.sendEnabled);
});

test('AC5 · reconfirm-required + same FRESH turn + changed tab: remount, review notice stays, tap still required', () => {
  const r = row({});
  const fresh = onTurn(r, 1);
  const st = stateWith([fresh], fresh, {
    draft: 'what I had typed', machine: INBOX.MACHINE_RECONFIRM, turn: fresh.turn,
  });
  const out = INBOX.applyRefresh(st, { ok: true, items: [onTab(fresh, 'fixture-tab-b')] });

  assert.equal(out.reconciled.openCard.surfaceChanged, true);
  assert.equal(out.reconciled.openCard.turnChanged, false);
  assert.equal(out.reconciled.openCard.field, 'remount');
  assert.equal(out.instr.draft, 'what I had typed');
  assert.equal(out.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(out.instr.notice, 'The question changed — review it before sending.');
  assert.equal(out.instr.sendEnabled, false, 'a remount is not a confirmation');
  assert.equal(out.instr.immediateGet, false);

  // ...and the tap still works afterwards, carrying the fresh turn.
  const tapped = INBOX.applyConfirm(out.state);
  assert.equal(tapped.state.card.machine, INBOX.MACHINE_READY);
  assert.equal(tapped.instr.sendEnabled, true);
  assert.equal(tapped.instr.notice, null);
  const sent = INBOX.applySend(tapped.state);
  assert.equal(INBOX.turnSignature(sent.instr.post.turn), INBOX.turnSignature(turnAt(1)));
});

test('AC5 · the conjunction holds in every combination of answerability and machine state', () => {
  for (const answerable of [true, false]) {
    for (const machine of [INBOX.MACHINE_READY, INBOX.MACHINE_AWAITING_FRESH, INBOX.MACHINE_RECONFIRM]) {
      const expected = answerable && machine === INBOX.MACHINE_READY;
      assert.equal(INBOX.sendEnabled(answerable, machine), expected, `${machine} / answerable=${answerable}`);
      const r = row({ answerable });
      const st = stateWith([r], r, { machine, draft: 'x', answerable });
      assert.equal(INBOX.instructionsFor(st.card, {}).sendEnabled, expected);
    }
  }
});

// ================================================================================================
// AC 6 (tier-1) — THE MACHINE: three states, TWO DISJOINT ENTRIES, no stale POST reachable
// ================================================================================================

test('AC6 · ENTRY 1 — a POST answered question_changed enters awaiting-fresh with EXACTLY one GET', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'still here after the refusal' });
  const out = INBOX.applyReplyResult(st, 'question_changed');

  assert.equal(out.state.card.machine, INBOX.MACHINE_AWAITING_FRESH);
  assert.equal(out.state.card.draft, 'still here after the refusal', 'the draft is intact');
  assert.equal(out.instr.sendEnabled, false);
  assert.equal(out.instr.notice, 'The question changed — waiting for the update…');
  assert.equal(out.instr.noticeTappable, false, 'there is nothing to confirm yet');
  assert.equal(out.instr.immediateGet, true, 'exactly one immediate GET, predicate-independent');

  // A second response cannot produce a second GET, because Send is a no-op in this state and the
  // transition is guarded on `ready` besides.
  const again = INBOX.applyReplyResult(out.state, 'question_changed');
  assert.equal(again.instr.immediateGet, false);
  assert.equal(again.state.card.machine, INBOX.MACHINE_AWAITING_FRESH);
});

test('AC6 · a refresh with the SAME stale turn keeps awaiting-fresh and emits NO further GET', () => {
  const r = row({});
  let st = INBOX.applyReplyResult(stateWith([r], r, { draft: 'mine' }), 'question_changed').state;
  const out = INBOX.applyRefresh(st, { ok: true, items: [r] });
  assert.equal(out.state.card.machine, INBOX.MACHINE_AWAITING_FRESH);
  assert.equal(out.instr.immediateGet, false);
  assert.equal(out.instr.notice, 'The question changed — waiting for the update…');
  assert.equal(out.instr.sendEnabled, false);
});

test('AC6 · ENTRY 2a — a changed-turn refresh goes STRAIGHT to reconfirm-required from awaiting-fresh, no GET', () => {
  const r = row({});
  const st = INBOX.applyReplyResult(stateWith([r], r, { draft: 'mine' }), 'question_changed').state;
  const out = INBOX.applyRefresh(st, { ok: true, items: [onTurn(r, 1)] });
  assert.equal(out.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(out.instr.immediateGet, false, 'the changed-turn refresh IS the fresh arrival');
  assert.equal(out.instr.notice, 'The question changed — review it before sending.');
  assert.equal(out.instr.sendEnabled, false);
  assert.equal(out.state.card.draft, 'mine');
  assert.equal(INBOX.turnSignature(out.state.card.turn), INBOX.turnSignature(turnAt(1)), 'the card now holds the FRESH turn');
});

test('AC6 · ENTRY 2b — the same transition from an open card that NEVER POSTed', () => {
  const r = row({});
  const st = stateWith([r], r, { draft: 'never sent anything' });
  assert.equal(st.card.machine, INBOX.MACHINE_READY);
  const out = INBOX.applyRefresh(st, { ok: true, items: [onTurn(r, 1)] });
  assert.equal(out.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(out.instr.immediateGet, false, 'no POST happened, so no POST-refusal GET can exist');
  assert.equal(out.instr.notice, 'The question changed — review it before sending.');
});

test('AC6 · send is a pure no-op in awaiting-fresh and in reconfirm-required', () => {
  const r = row({});
  const posted = INBOX.applyReplyResult(stateWith([r], r, { draft: 'text' }), 'question_changed').state;
  assert.equal(INBOX.applySend(posted, 'text').instr.post, null, 'awaiting-fresh: no POST');
  assert.equal(INBOX.machineReduce({ name: INBOX.MACHINE_AWAITING_FRESH, turn: turnAt(0) }, { type: 'send' }).post, null);

  const reconfirm = INBOX.applyRefresh(posted, { ok: true, items: [onTurn(r, 1)] }).state;
  assert.equal(INBOX.applySend(reconfirm, 'text').instr.post, null, 'reconfirm-required: no POST');
  assert.equal(INBOX.machineReduce({ name: INBOX.MACHINE_RECONFIRM, turn: turnAt(1) }, { type: 'send' }).post, null);
});

test('AC6 · a confirm tap in awaiting-fresh is a NO-OP — the fresh turn has not arrived yet', () => {
  const r = row({});
  const posted = INBOX.applyReplyResult(stateWith([r], r, { draft: 'text' }), 'question_changed').state;
  const tapped = INBOX.applyConfirm(posted);
  assert.equal(tapped.state.card.machine, INBOX.MACHINE_AWAITING_FRESH, 'no way out of waiting except a fresh turn');
  assert.equal(tapped.instr.sendEnabled, false);
  assert.equal(INBOX.applySend(tapped.state, 'text').instr.post, null);
});

test('AC6 · one tap -> ready, and the next send carries the FRESH turn', () => {
  const r = row({});
  let st = stateWith([r], r, { draft: 'my answer' });
  st = INBOX.applyReplyResult(st, 'question_changed').state;
  st = INBOX.applyRefresh(st, { ok: true, items: [onTurn(r, 1)] }).state;
  const tapped = INBOX.applyConfirm(st);
  assert.equal(tapped.state.card.machine, INBOX.MACHINE_READY);
  assert.equal(tapped.instr.sendEnabled, true);
  assert.equal(tapped.instr.notice, null, 'the notice goes with the state that owned it');

  const sent = INBOX.applySend(tapped.state, 'my answer');
  assert.ok(sent.instr.post, 'now it posts');
  assert.equal(sent.instr.post.text, 'my answer');
  assert.equal(sent.instr.post.machine, r.sessionKey.machine);
  assert.equal(sent.instr.post.sessionId, r.sessionKey.sessionId);
  assert.equal(INBOX.turnSignature(sent.instr.post.turn), INBOX.turnSignature(turnAt(1)), 'the FRESH token');
  assert.notEqual(INBOX.turnSignature(sent.instr.post.turn), INBOX.turnSignature(turnAt(0)));
});

test('AC6 · copy ownership — the waiting sentence is copyForCode\'s, the review sentence is the state\'s', () => {
  assert.equal(INBOX.copyForCode('question_changed').text, 'The question changed — waiting for the update…');
  assert.equal(INBOX.machineNotice(INBOX.MACHINE_AWAITING_FRESH), 'The question changed — waiting for the update…');
  assert.equal(INBOX.machineNotice(INBOX.MACHINE_RECONFIRM), 'The question changed — review it before sending.');
  assert.equal(INBOX.machineNotice(INBOX.MACHINE_READY), null, 'a ready card shows no machine notice');
  // The review sentence is NOT reachable through any code the server could send.
  const codes = SIX_ONE.map(([c]) => c).concat(['ok', 'nonsense', 'unauthorized', INBOX.REPLY_NON_JSON]);
  for (const c of codes) {
    const out = INBOX.copyForCode(c);
    if (out) assert.notEqual(out.text, INBOX.QUESTION_CHANGED_REVIEW, `${c} must not produce the review sentence`);
  }
});

test('AC6 · PROPERTY SWEEP — no reachable event sequence POSTs a stale token, and never a second GET', () => {
  const ALPHABET = ['send-qc', 'send-drop', 'confirm', 'refresh-same', 'refresh-new'];
  const DEPTH = 5;

  function run(sequence) {
    let machine = INBOX.machineInitial(turnAt(0));
    let world = 0;                       // the newest turn the world has produced
    const stale = new Set();             // turn signatures known to be superseded
    const posts = [];
    let gets = 0;
    let refusals = 0;
    const faults = [];

    for (const ev of sequence) {
      if (ev === 'send-qc' || ev === 'send-drop') {
        const out = INBOX.machineReduce(machine, { type: 'send' });
        machine = out.state;
        if (out.post) {
          const sig = INBOX.turnSignature(out.post.turn);
          if (stale.has(sig)) faults.push(`STALE POST after [${sequence.join(' ')}]`);
          posts.push(sig);
          if (ev === 'send-qc') {
            // The server refuses: whatever that POST carried is now known stale.
            stale.add(sig);
            refusals++;
            const r = INBOX.machineReduce(machine, { type: 'reply-response', code: 'question_changed' });
            machine = r.state;
            if (r.immediateGet) gets++;
          }
        }
      } else if (ev === 'confirm') {
        machine = INBOX.machineReduce(machine, { type: 'confirm' }).state;
      } else {
        if (ev === 'refresh-new') { stale.add(INBOX.turnSignature(turnAt(world))); world++; }
        const out = INBOX.machineReduce(machine, { type: 'refresh', turn: turnAt(world) });
        machine = out.state;
        if (out.immediateGet) gets++;
      }
      if (['ready', 'awaiting-fresh', 'reconfirm-required'].indexOf(machine.name) === -1) {
        faults.push(`unknown state ${machine.name}`);
      }
      if (machine.name !== INBOX.MACHINE_READY && INBOX.sendEnabled(true, machine.name)) {
        faults.push(`send enabled in ${machine.name}`);
      }
    }
    return { posts, gets, refusals, faults };
  }

  let sequences = 0;
  let sawPost = 0;
  let sawRefusal = 0;
  const enumerate = (prefix) => {
    if (prefix.length) {
      sequences++;
      const out = run(prefix);
      assert.deepEqual(out.faults, [], `sequence [${prefix.join(' ')}]`);
      // One immediate GET per POST refusal. Never two, never a refresh sneaking one in.
      assert.equal(out.gets, out.refusals, `sequence [${prefix.join(' ')}]: ${out.gets} GETs for ${out.refusals} refusals`);
      if (out.posts.length) sawPost++;
      if (out.refusals) sawRefusal++;
    }
    if (prefix.length === DEPTH) return;
    for (const ev of ALPHABET) enumerate(prefix.concat([ev]));
  };
  enumerate([]);

  assert.equal(sequences, 5 + 25 + 125 + 625 + 3125, 'every sequence up to length 5 was walked');
  assert.ok(sawPost > 100, `the sweep must actually reach the POST path (${sawPost} sequences did)`);
  assert.ok(sawRefusal > 100, `and the refusal path (${sawRefusal} sequences did)`);
});

// ================================================================================================
// AC 7 (tier-1) — the refresh-predicate reducer: one timer, and only while the predicate holds
// ================================================================================================

// A driver that plays the DOM layer's part: it creates a handle whenever the reducer says `start`,
// releases it on `stop`, and counts the loads.
function driveRefresh(events, initial) {
  let state = INBOX.refreshInitial(initial || {});
  let handles = 0;
  const live = [];
  let gets = 0;
  let stops = 0;
  for (const ev of events) {
    const out = INBOX.refreshReduce(state, ev);
    state = out.state;
    if (out.start) {
      handles++;
      const h = `timer-${handles}`;
      live.push(h);
      state = INBOX.refreshSetTimer(state, h);
    }
    if (out.stop) {
      stops++;
      if (out.stopped != null) {
        const i = live.indexOf(out.stopped);
        assert.notEqual(i, -1, 'a stop must release a handle that was actually created');
        live.splice(i, 1);
      }
    }
    if (out.get) gets++;
  }
  return { state, gets, handles, stops, live };
}

test('AC7 · active AND visible creates exactly one timer and one immediate load', () => {
  const out = driveRefresh([{ type: 'open' }]);
  assert.equal(out.gets, 1, 'one load, immediately');
  assert.equal(out.handles, 1, 'one timer created');
  assert.deepEqual(out.live, ['timer-1'], 'and exactly one alive');
  assert.equal(out.state.armed, true);
  assert.equal(out.state.timer, 'timer-1');
});

test('AC7 · visible but INACTIVE does nothing at all', () => {
  const out = driveRefresh([{ type: 'visible', value: true }, { type: 'visible', value: true }]);
  assert.equal(out.gets, 0);
  assert.equal(out.handles, 0);
  assert.equal(out.state.armed, false);
});

test('AC7 · HIDDEN does nothing, even with the inbox open', () => {
  const out = driveRefresh([{ type: 'visible', value: false }, { type: 'open' }]);
  assert.equal(out.gets, 0, 'never load while the predicate does not hold');
  assert.equal(out.handles, 0);
  assert.equal(out.state.active, true);
  assert.equal(out.state.armed, false);
  // ...and a tick that somehow survived would still not load.
  const tick = INBOX.refreshReduce(out.state, { type: 'tick' });
  assert.equal(tick.get, false);
});

test('AC7 · becoming true AGAIN fires exactly one load, and only on the transition', () => {
  const out = driveRefresh([
    { type: 'open' },                    // -> true: load 1, timer 1
    { type: 'open' },                    // already true: nothing
    { type: 'visible', value: true },    // already true: nothing
    { type: 'visible', value: false },   // -> false: stop
    { type: 'visible', value: false },   // already false: nothing
    { type: 'visible', value: true },    // -> true again: load 2, timer 2
  ]);
  assert.equal(out.gets, 2, 'exactly two loads across two become-true transitions');
  assert.equal(out.handles, 2);
  assert.equal(out.stops, 1);
  assert.deepEqual(out.live, ['timer-2'], 'the first handle was released, not leaked');
});

test('AC7 · repeated open/close cycles leave exactly ONE live timer handle', () => {
  const events = [];
  for (let i = 0; i < 12; i++) { events.push({ type: 'open' }); events.push({ type: 'close' }); }
  events.push({ type: 'open' });
  const out = driveRefresh(events);
  assert.equal(out.handles, 13);
  assert.equal(out.stops, 12);
  assert.equal(out.live.length, 1, 'one handle alive after 12 cycles and a final open');
  assert.deepEqual(out.live, ['timer-13']);
  assert.equal(out.state.armed, true);
  assert.equal(out.state.timer, 'timer-13');
  assert.equal(out.gets, 13, 'one load per become-true, no more');

  // ...and closing at the end leaves NONE.
  const closed = INBOX.refreshReduce(out.state, { type: 'close' });
  assert.equal(closed.stop, true);
  assert.equal(closed.stopped, 'timer-13');
  assert.equal(closed.state.armed, false);
  assert.equal(closed.state.timer, null);
});

test('AC7 · a tick loads only while the predicate holds', () => {
  let state = INBOX.refreshInitial();
  state = INBOX.refreshReduce(state, { type: 'open' }).state;
  assert.equal(INBOX.refreshReduce(state, { type: 'tick' }).get, true);
  state = INBOX.refreshReduce(state, { type: 'visible', value: false }).state;
  assert.equal(INBOX.refreshReduce(state, { type: 'tick' }).get, false, 'a late tick is not a load');
  assert.equal(INBOX.REFRESH_MS, 60000, 'the cadence is 60 seconds');
});

// ================================================================================================
// AC 8 (tier-1) — a FAILED refresh with an open draft
// ================================================================================================

test('AC8 · a failed refresh leaves the list and the draft untouched and emits ONE inline line', () => {
  const a = row({});
  const b = row({});
  const st = stateWith([a, b], a, { draft: 'a paragraph I am not finished with' });
  const rowsBefore = st.rows;

  // A stub adapter in the DOM layer's place: it records what it was told to do and nothing else.
  const rendered = [];
  const adapter = (instr) => rendered.push(instr);

  const out = INBOX.applyRefresh(st, { ok: false });
  adapter(out.instr);

  assert.equal(out.state.rows, rowsBefore, 'the list is not merely equal — it is untouched');
  assert.deepEqual(out.state.rows.map(INBOX.rowKey), [a, b].map(INBOX.rowKey));
  assert.equal(out.state.card.draft, 'a paragraph I am not finished with', 'the draft is untouched');
  assert.equal(out.state.card.row, a, 'the card still holds the row it had');
  assert.equal(out.state.card.machine, INBOX.MACHINE_READY);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].list, 'keep', 'the list is not re-rendered');
  assert.equal(rendered[0].field, 'keep', 'and the field node is not rebuilt');
  assert.equal(rendered[0].notice, INBOX.REFRESH_FAILED_COPY, 'exactly one inline line');
  assert.equal(rendered[0].draft, 'a paragraph I am not finished with');
  assert.equal(rendered[0].sendEnabled, true, 'a failed refresh is not a reason to disable Send');
});

test('AC8 · the failed-refresh line never displaces a machine notice', () => {
  const r = row({});
  for (const machine of [INBOX.MACHINE_AWAITING_FRESH, INBOX.MACHINE_RECONFIRM]) {
    const st = stateWith([r], r, { draft: 'mine', machine });
    const out = INBOX.applyRefresh(st, { ok: false });
    assert.equal(out.instr.notice, INBOX.machineNotice(machine), `${machine}: the machine outranks the transient line`);
    assert.equal(out.instr.sendEnabled, false);
    assert.equal(out.state.card.draft, 'mine');
  }
});

test('AC8 · a failed refresh with no card open changes nothing and renders no line', () => {
  const r = row({});
  const st = { rows: [r], card: null };
  const out = INBOX.applyRefresh(st, { ok: false });
  assert.equal(out.state.rows, st.rows);
  assert.equal(out.state.card, null);
  assert.equal(out.instr.notice, null);
});

// ================================================================================================
// The typed text is kept on EVERY non-success path — the promise §6.1 makes 22 times over
// ================================================================================================

test('every non-success outcome keeps the draft; only success clears it and closes the card', () => {
  const r = row({});
  const draft = 'the thing I typed, which is mine';
  const codes = SIX_ONE.map(([c]) => c).concat(['nonsense', 'unauthorized', INBOX.REPLY_NON_JSON, INBOX.REPLY_NETWORK_ERROR, INBOX.REPLY_UNAUTHORIZED]);
  for (const code of codes) {
    const st = stateWith([r], r, { draft });
    const out = INBOX.applyReplyResult(st, code);
    assert.ok(out.state.card, `${code}: the card stays open`);
    assert.equal(out.state.card.draft, draft, `${code}: THE TYPED TEXT IS KEPT`);
    assert.equal(out.instr.draft, draft, `${code}: and handed back to the renderer`);
    assert.equal(out.instr.closeCard, false, `${code}: nothing closes on a failure`);
    assert.equal(out.instr.clearField, false);
    assert.ok(out.instr.notice, `${code}: one inline sentence`);
    assert.deepEqual(out.state.rows.map(INBOX.rowKey), [r].map(INBOX.rowKey), `${code}: the list is untouched`);
    // The disable column, applied.
    const expected = code === 'question_changed' ? false : !INBOX.copyForCode(code).disableSend;
    assert.equal(out.instr.sendEnabled, expected, `${code}: wrong Send state`);
  }

  const ok = INBOX.applyReplyResult(stateWith([r], r, { draft }), 'ok');
  assert.equal(ok.state.card, null, 'success closes the card');
  assert.equal(ok.instr.closeCard, true);
  assert.equal(ok.instr.clearField, true);
  assert.equal(ok.instr.notice, null, 'and renders no sentence at all');
  assert.deepEqual(ok.state.rows.map(INBOX.rowKey), [r].map(INBOX.rowKey), 'the ROW stays until a refresh removes it');
});

test('a §6.1 disable latch does not outlive the question that earned it', () => {
  const r = row({});
  let st = stateWith([r], r, { draft: 'mine' });
  st = INBOX.applyReplyResult(st, 'send_unconfirmed').state;
  assert.equal(st.card.latched, true);
  assert.equal(INBOX.canSend(st.card), false, 'the table says disable, so it is disabled');

  // A brand-new question is a brand-new attempt.
  const moved = INBOX.applyRefresh(st, { ok: true, items: [onTurn(r, 1)] });
  assert.equal(moved.state.card.latched, false);
  assert.equal(moved.state.card.machine, INBOX.MACHINE_RECONFIRM, '...but the machine still wants a tap');
  const tapped = INBOX.applyConfirm(moved.state);
  assert.equal(tapped.instr.sendEnabled, true);
});

test('a surface-only refresh does NOT clear a §6.1 sentence — it creates nothing and clears nothing', () => {
  const r = row({});
  let st = stateWith([r], r, { draft: 'mine' });
  st = INBOX.applyReplyResult(st, 'not_at_prompt').state;
  const out = INBOX.applyRefresh(st, { ok: true, items: [onTab(r, 'fixture-tab-b')] });
  assert.equal(out.instr.notice, "The tab isn't at a Claude prompt right now.");
  assert.equal(out.instr.field, 'remount');
  assert.equal(out.instr.draft, 'mine');
});

// ================================================================================================
// WIRING — the real module, driven through a DOM stand-in. A perfect pure layer that nothing calls
// is the other way this story could ship dark.
// ================================================================================================

function makeText(doc, value) {
  return { ownerDocument: doc, nodeType: 3, tagName: '#text', childNodes: [], parentNode: null, _text: String(value), get textContent() { return this._text; } };
}

function makeNode(doc, tag) {
  const node = {
    ownerDocument: doc, nodeType: 1, tagName: String(tag).toUpperCase(),
    childNodes: [], parentNode: null, attributes: {}, dataset: {}, style: {},
    className: '', id: '', hidden: false, disabled: false, value: '', rows: 0,
    placeholder: '', scrollTop: 0, onclick: null, oninput: null, _text: null,
    append(...kids) { for (const k of kids) this.appendChild(k); },
    appendChild(k) {
      // A MOVE, exactly as the real DOM does it — that is what trap 10 is about.
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
  node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  return node;
}

function makeDoc() {
  const doc = { visibilityState: 'visible', _listeners: {} };
  doc.createElement = (tag) => makeNode(doc, tag);
  doc.createTextNode = (t) => makeText(doc, t);
  doc.addEventListener = (name, fn) => { (doc._listeners[name] = doc._listeners[name] || []).push(fn); };
  doc.emit = (name) => { for (const fn of doc._listeners[name] || []) fn(); };
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

// `load()` awaits the response and then its .json(); a single microtask tick is not enough. Two
// setImmediate turns cover the reply path, which awaits twice more.
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

function mountInbox(o) {
  const opts = o || {};
  const doc = makeDoc();
  const mount = makeNode(doc, 'div');
  doc.body.appendChild(mount);
  const calls = { gets: 0, posts: [] };
  const timers = { started: 0, cleared: 0, fn: null };
  const jget = async () => {
    calls.gets++;
    const r = opts.get ? opts.get(calls.gets) : { ok: true, status: 200, body: payloadOf([]) };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => { if (r.throws) throw new Error('not json'); return r.body; } };
  };
  const jpost = async (url, body) => {
    calls.posts.push(body);
    const r = opts.post ? opts.post(calls.posts.length, body) : { ok: true, status: 200, body: { ok: true } };
    if (r.reject) throw new Error('network down');
    return { ok: r.ok !== false, status: r.status || 200, json: async () => { if (r.throws) throw new Error('not json'); return r.body; } };
  };
  const ui = INBOX.create({
    mount, jget, jpost, now: () => NOW,
    setTimer: (fn) => { timers.started++; timers.fn = fn; return `timer-${timers.started}`; },
    clearTimer: () => { timers.cleared++; },
  });
  return { doc, mount, ui, calls, timers, pane: ui.el };
}

test('wiring · opening loads once and arms exactly one timer; closing releases it', async () => {
  const r = row({});
  const h = mountInbox({ get: () => ({ body: payloadOf([r]) }) });
  h.ui.open();
  await flush();
  assert.equal(h.calls.gets, 1);
  assert.equal(h.timers.started, 1);
  assert.equal(byClass(h.pane, 'irow').length, 1);
  h.ui.close();
  assert.equal(h.timers.cleared, 1);
  // A second open arms a second timer and loads again — one per become-true, never two.
  h.ui.open();
  await flush();
  assert.equal(h.calls.gets, 2);
  assert.equal(h.timers.started, 2);
});

test('wiring · a hidden document neither loads nor arms a timer', async () => {
  const h = mountInbox({ get: () => ({ body: payloadOf([row({})]) }) });
  h.doc.visibilityState = 'hidden';
  h.doc.emit('visibilitychange');
  h.ui.open();
  await flush();
  assert.equal(h.calls.gets, 0, 'never load while the predicate does not hold');
  assert.equal(h.timers.started, 0);
  // Coming back into view loads exactly once.
  h.doc.visibilityState = 'visible';
  h.doc.emit('visibilitychange');
  await flush();
  assert.equal(h.calls.gets, 1);
  assert.equal(h.timers.started, 1);
});

test('wiring · a successful reply clears the field and closes the card, and the ROW stays', async () => {
  const r = row({});
  const h = mountInbox({ get: () => ({ body: payloadOf([r]) }) });
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'land it on develop';
  ta.oninput();
  const send = byClass(h.pane, 'isend')[0];
  assert.equal(send.disabled, false, 'an answerable, ready card with text can send');

  send.onclick();
  await flush();

  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.posts[0], {
    machine: r.sessionKey.machine, sessionId: r.sessionKey.sessionId, text: 'land it on develop', turn: r.turn,
  }, 'the body is {machine, sessionId, text, turn} with the turn copied verbatim');
  assert.equal(byTag(h.pane, 'TEXTAREA').length, 0, 'the card closed');
  assert.equal(byClass(h.pane, 'icard')[0].hidden, true);
  assert.equal(byClass(h.pane, 'irow').length, 1, 'the row stays until a refresh removes it');
  assert.equal(byClass(h.pane, 'inotice')[0].hidden, true, 'success renders no sentence');
});

test('wiring · a §6.1 failure renders its exact sentence inline and leaves the text alone', async () => {
  const r = row({});
  for (const [code, copy, disable] of [
    ['not_at_prompt', "The tab isn't at a Claude prompt right now.", false],
    ['already_answered', 'This session is no longer waiting.', true],
    ['send_unconfirmed', "The send wasn't confirmed — check the tab before retrying.", true],
    ['pane_changed', 'The tab changed while sending — nothing was sent.', false],
  ]) {
    const h = mountInbox({
      get: () => ({ body: payloadOf([r]) }),
      post: () => ({ ok: false, status: 409, body: { error: code, message: copy } }),
    });
    h.ui.open();
    await flush();
    byClass(h.pane, 'irow')[0].onclick();
    const ta = byTag(h.pane, 'TEXTAREA')[0];
    ta.value = 'my careful answer';
    ta.oninput();
    byClass(h.pane, 'isend')[0].onclick();
    await flush();

    const notice = byClass(h.pane, 'inotice')[0];
    assert.equal(notice.hidden, false, `${code}: one line renders`);
    assert.equal(notice.textContent, copy, `${code}: and it is the client's own copy`);
    assert.equal(byTag(h.pane, 'TEXTAREA')[0], ta, `${code}: the very same field node`);
    assert.equal(ta.value, 'my careful answer', `${code}: THE TYPED TEXT IS KEPT`);
    assert.equal(byClass(h.pane, 'isend')[0].disabled, disable, `${code}: wrong Send state`);
  }
});

test('wiring · a 401, a non-JSON body and a network rejection all render the fallback with the text kept', async () => {
  const r = row({});
  const cases = [
    ['401', () => ({ ok: false, status: 401, body: { error: 'unauthorized' } })],
    ['non-JSON', () => ({ ok: false, status: 502, throws: true })],
    ['network', () => ({ reject: true })],
  ];
  for (const [label, post] of cases) {
    const h = mountInbox({ get: () => ({ body: payloadOf([r]) }), post });
    h.ui.open();
    await flush();
    byClass(h.pane, 'irow')[0].onclick();
    const ta = byTag(h.pane, 'TEXTAREA')[0];
    ta.value = 'still mine';
    ta.oninput();
    byClass(h.pane, 'isend')[0].onclick();
    await flush();
    assert.equal(byClass(h.pane, 'inotice')[0].textContent, "Couldn't send — your reply is still here.", label);
    assert.equal(ta.value, 'still mine', `${label}: the draft survives`);
    assert.equal(byClass(h.pane, 'isend')[0].disabled, false, `${label}: the fallback is retryable`);
  }
});

test('wiring · question_changed -> one extra GET -> the new question -> tap -> the retry carries the FRESH turn', async () => {
  const stale = row({});
  const fresh = onTurn(stale, 1);
  const h = mountInbox({
    // GET 1 (on open) serves the stale row; the immediate GET fired by the refusal serves the new one.
    get: (n) => ({ body: payloadOf([n === 1 ? stale : fresh]) }),
    post: (n) => (n === 1
      ? { ok: false, status: 409, body: { error: 'question_changed', message: 'The question changed — waiting for the update…' } }
      : { ok: true, status: 200, body: { ok: true } }),
  });
  h.ui.open();
  await flush();
  assert.equal(h.calls.gets, 1);
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'the answer I still want to send';
  ta.oninput();
  byClass(h.pane, 'isend')[0].onclick();
  await flush();

  // The refusal: the waiting notice, the draft, and EXACTLY one extra GET.
  assert.equal(h.calls.posts.length, 1);
  assert.equal(INBOX.turnSignature(h.calls.posts[0].turn), INBOX.turnSignature(turnAt(0)), 'the first POST carried the turn it had');
  assert.equal(h.calls.gets, 2, 'exactly one immediate GET, and it did not need the timer');
  assert.equal(ta.value, 'the answer I still want to send', 'the draft is intact');

  // The fresh row lands on that GET: the new question re-renders and the state moves to reconfirm.
  assert.equal(byClass(h.pane, 'inotice')[0].textContent, 'The question changed — review it before sending.');
  assert.equal(byClass(h.pane, 'isend')[0].disabled, true, 'send stays disabled until the tap');
  assert.equal(h.ui.state().card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(byTag(h.pane, 'TEXTAREA')[0].value, 'the answer I still want to send');

  // The tap.
  byClass(h.pane, 'inotice')[0].onclick();
  assert.equal(byClass(h.pane, 'inotice')[0].hidden, true, 'the notice goes with the state');
  assert.equal(byClass(h.pane, 'isend')[0].disabled, false);

  byClass(h.pane, 'isend')[0].onclick();
  await flush();
  assert.equal(h.calls.posts.length, 2);
  assert.equal(INBOX.turnSignature(h.calls.posts[1].turn), INBOX.turnSignature(turnAt(1)), 'the retry carries the FRESH token');
  assert.equal(h.calls.posts[1].text, 'the answer I still want to send');
  assert.equal(h.calls.gets, 2, 'and no further extra GET was asked for');
});

test('wiring · a failed refresh with an open draft leaves the list and the text exactly as they were', async () => {
  const r = row({});
  let fail = false;
  const h = mountInbox({ get: () => (fail ? { ok: false, status: 502, body: {} } : { body: payloadOf([r]) }) });
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'mid-sentence when the server blinked';
  ta.oninput();

  fail = true;
  h.ui.refresh();
  await flush();

  assert.equal(byTag(h.pane, 'TEXTAREA')[0], ta, 'the same field node');
  assert.equal(ta.value, 'mid-sentence when the server blinked');
  assert.equal(byClass(h.pane, 'inotice')[0].textContent, INBOX.REFRESH_FAILED_COPY);
  assert.deepEqual(h.ui.state().rows.map(INBOX.rowKey), [INBOX.rowKey(r)], 'the list is untouched');
});

test('wiring · the tappable notice is never a <button> — a read-only card must contain no control', async () => {
  const readOnly = unjoined(row({}), 'tree-unavailable');
  const h = mountInbox({ get: () => ({ body: payloadOf([readOnly]) }) });
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const cardEl = byClass(h.pane, 'icard')[0];
  assert.equal(byTag(cardEl, 'BUTTON').length, 0, 'no dismiss, no send, no notice-button');
  assert.equal(byTag(cardEl, 'TEXTAREA').length, 0);
  assert.equal(byClass(cardEl, 'ireadonly')[0].textContent, "The machine isn't reachable right now.");
});

// ================================================================================================
// THE IN-FLIGHT SEAM — a reply response is addressed, and a response that outlives its card is not
// applied to whoever happens to be open
//
// The server's send phase alone can take many seconds. In that window the operator can tap Back,
// open another row and start typing. Everything above this line fuses "POST" and "its response" into
// one atomic step — the AC6 property sweep included, whose alphabet has no event for a response
// arriving LATE — so no sequence any of it can express reaches this seam at all. These are the
// sequences that can.
// ================================================================================================

// A mount whose reply POST is HELD OPEN until the test releases it. This is the only way to write
// down the interleaving: a `jpost` that resolves on its own microtask can never still be in flight
// when the operator taps Back.
function mountHeld(o) {
  const opts = o || {};
  const doc = makeDoc();
  const mount = makeNode(doc, 'div');
  doc.body.appendChild(mount);
  const calls = { gets: 0, posts: [] };
  const held = [];
  const jget = async () => {
    calls.gets++;
    const r = opts.get ? opts.get(calls.gets) : { ok: true, status: 200, body: payloadOf([]) };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  };
  const jpost = (url, body) => {
    calls.posts.push(body);
    return new Promise((resolve) => { held.push({ body, resolve }); });
  };
  const ui = INBOX.create({
    mount, jget, jpost, now: () => NOW,
    setTimer: () => 'timer-held', clearTimer: () => {},
  });
  // Answer the i-th (0-based) POST still in flight, then let the client's awaits drain.
  const answer = async (i, code) => {
    const h = held[i];
    assert.ok(h, `POST #${i} must be in flight to be answered`);
    h.resolve(code === 'ok'
      ? { ok: true, status: 200, json: async () => ({ ok: true }) }
      : { ok: false, status: 409, json: async () => ({ error: code }) });
    await flush();
  };
  return { doc, mount, ui, calls, held, answer, pane: ui.el };
}

// Open A, type, Send (the POST is held), tap Back, open B, start typing. Returns B's live textarea.
async function aSentThenBOpened(h) {
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'A: land it on develop';
  ta.oninput();
  byClass(h.pane, 'isend')[0].onclick();
  await flush();
  assert.equal(h.calls.posts.length, 1, 'A POSTed');
  assert.equal(h.held.length, 1, "...and it is still in flight — that is the whole point");

  byClass(h.pane, 'iback')[0].onclick();
  byClass(h.pane, 'irow')[1].onclick();
  const tb = byTag(h.pane, 'TEXTAREA')[0];
  tb.value = 'B: what I am halfway through typing';
  tb.oninput();
  return tb;
}

test("defect 1 · A's `ok` resolving while B is open must not close B or destroy B's draft", async () => {
  const a = row({ question: 'Should A land on develop?' });
  const b = row({ question: 'Should B land on develop?' });
  const h = mountHeld({ get: () => ({ body: payloadOf([a, b]) }) });
  const tb = await aSentThenBOpened(h);

  await h.answer(0, 'ok');

  assert.equal(h.ui.state().card && h.ui.state().card.key, INBOX.rowKey(b), "B's card is still the open one");
  assert.equal(byClass(h.pane, 'icard')[0].hidden, false, "B's card was not closed by A's success");
  assert.equal(byTag(h.pane, 'TEXTAREA')[0], tb, 'the very same field node');
  assert.equal(tb.value, 'B: what I am halfway through typing', "B'S DRAFT IS INTACT");
  assert.equal(h.ui.state().card.draft, 'B: what I am halfway through typing');
  assert.equal(byClass(h.pane, 'isend')[0].disabled, false, 'and B can still send');
});

test("defect 1 · A's `question_changed` resolving while B is open must not wedge B or emit a GET", async () => {
  const a = row({ question: 'Should A land on develop?' });
  const b = row({ question: 'Should B land on develop?' });
  const h = mountHeld({ get: () => ({ body: payloadOf([a, b]) }) });
  const tb = await aSentThenBOpened(h);
  const getsBefore = h.calls.gets;

  await h.answer(0, 'question_changed');

  assert.equal(h.ui.state().card.machine, INBOX.MACHINE_READY, "B's machine is untouched — B's question never changed");
  assert.equal(h.calls.gets, getsBefore, 'no spurious immediate GET on B behalf');
  assert.equal(byClass(h.pane, 'inotice')[0].hidden, true, 'and no waiting sentence on a card that never POSTed');
  assert.equal(tb.value, 'B: what I am halfway through typing');
  assert.equal(byClass(h.pane, 'isend')[0].disabled, false, 'B is not wedged: Send is live');

  // The wedge, spelled out: B's turn will never change, so a `awaiting-fresh` entered here would have
  // no exit at all — a cadence refresh keeps it and a confirm tap is a no-op in that state.
  byClass(h.pane, 'isend')[0].onclick();
  await flush();
  assert.equal(h.calls.posts.length, 2, 'B can actually send');
  assert.equal(h.calls.posts[1].text, 'B: what I am halfway through typing');
});

test("defect 1 · A's disable-code resolving while B is open must not latch B with A's sentence", async () => {
  for (const code of ['already_answered', 'send_unconfirmed', 'tab_gone', 'session_not_found', 'surface_reassigned']) {
    const a = row({ question: 'Should A land on develop?' });
    const b = row({ question: 'Should B land on develop?' });
    const h = mountHeld({ get: () => ({ body: payloadOf([a, b]) }) });
    const tb = await aSentThenBOpened(h);

    await h.answer(0, code);

    assert.equal(h.ui.state().card.latched, false, `${code}: B is not latched by A's outcome`);
    assert.equal(h.ui.state().card.line, null, `${code}: and shows none of A's copy`);
    assert.equal(byClass(h.pane, 'inotice')[0].hidden, true, `${code}: nothing rendered`);
    assert.equal(byClass(h.pane, 'isend')[0].disabled, false, `${code}: Send stays live on B`);
    assert.equal(tb.value, 'B: what I am halfway through typing', `${code}: B's draft is intact`);
  }
});

test('defect 1 · a response resolving with NO card open is a safe no-op', async () => {
  for (const code of ['ok', 'question_changed', 'already_answered', 'not_at_prompt']) {
    const a = row({ question: 'Should A land on develop?' });
    const h = mountHeld({ get: () => ({ body: payloadOf([a]) }) });
    h.ui.open();
    await flush();
    byClass(h.pane, 'irow')[0].onclick();
    const ta = byTag(h.pane, 'TEXTAREA')[0];
    ta.value = 'A: land it on develop';
    ta.oninput();
    byClass(h.pane, 'isend')[0].onclick();
    await flush();
    byClass(h.pane, 'iback')[0].onclick();
    const getsBefore = h.calls.gets;

    await h.answer(0, code);

    assert.equal(h.ui.state().card, null, `${code}: still no card open`);
    assert.equal(h.calls.gets, getsBefore, `${code}: no GET`);
    assert.equal(byClass(h.pane, 'icard')[0].hidden, true, `${code}: the card stays closed`);
    assert.equal(byClass(h.pane, 'irow').length, 1, `${code}: the list is untouched`);
    assert.deepEqual(h.ui.state().rows.map(INBOX.rowKey), [INBOX.rowKey(a)], `${code}: and so are the rows`);
  }
});

test('defect 1 · the pure layer drops a response addressed to a generation that is gone', () => {
  const a = row({});
  const b = row({});
  const sent = INBOX.applySend({ rows: [a, b], card: Object.assign(INBOX.openCardState(a, 7), { draft: 'A' }) }, 'A');
  assert.deepEqual(sent.instr.postedCard, { gen: 7, turn: a.turn }, 'the sender addresses its own request');

  const cardB = Object.assign(INBOX.openCardState(b, 8), { draft: 'B, half typed' });
  const withB = { rows: [a, b], card: cardB };
  const codes = SIX_ONE.map(([c]) => c).concat(['ok', 'nonsense', INBOX.REPLY_NETWORK_ERROR]);
  for (const code of codes) {
    const out = INBOX.applyReplyResult(withB, code, sent.instr.postedCard);
    assert.equal(out.dropped, true, `${code}: dropped`);
    assert.equal(out.state.card, cardB, `${code}: B's card object is literally untouched`);
    assert.equal(out.instr.closeCard, false, `${code}: nothing closes`);
    assert.equal(out.instr.clearField, false, `${code}: nothing clears`);
    assert.equal(out.instr.immediateGet, false, `${code}: nothing fetches`);
  }
  // The same result addressed to a card that is not there at all.
  const gone = INBOX.applyReplyResult({ rows: [a, b], card: null }, 'ok', sent.instr.postedCard);
  assert.equal(gone.dropped, true);
  assert.equal(gone.state.card, null);
  assert.equal(gone.instr.closeCard, false, 'there is no card of that generation to close');

  // ...and a reopen of the SAME key is a different opening, so it is a different generation.
  const reopened = Object.assign(INBOX.openCardState(a, 9), { draft: 'typed again' });
  const back = INBOX.applyReplyResult({ rows: [a, b], card: reopened }, 'ok', sent.instr.postedCard);
  assert.equal(back.dropped, true, 'same key, new opening — the old POST is not its business');
  assert.equal(back.state.card.draft, 'typed again');
});

test('defect 2 · a stale POST\'s disable-latch must not survive onto a fresh turn', () => {
  const r = row({});
  // ready(T0) -> POST(T0) in flight
  const sent = INBOX.applySend(stateWith([r], r, { draft: 'my answer' }), 'my answer');
  assert.equal(INBOX.turnSignature(sent.instr.postedCard.turn), INBOX.turnSignature(turnAt(0)));

  // ...a refresh delivers T1 while it is in flight: reconfirm-required, latch cleared.
  const moved = INBOX.applyRefresh(sent.state, { ok: true, items: [onTurn(r, 1)] });
  assert.equal(moved.state.card.machine, INBOX.MACHINE_RECONFIRM);
  assert.equal(moved.state.card.latched, false);

  // ...and only NOW does the POST come back, refusing a question nobody is looking at.
  const out = INBOX.applyReplyResult(moved.state, 'already_answered', sent.instr.postedCard);
  assert.equal(out.stale, true, 'the response answers a turn that is gone');
  assert.equal(out.state.card.latched, false, 'THE LATCH IS NOT APPLIED — a new turn is a new question');
  assert.equal(out.state.card.line, null, "and neither is the old question's sentence");
  assert.equal(out.state.card.draft, 'my answer', 'the draft is kept, as always');

  // The operator taps the review notice, and Send is ALIVE on the fresh question.
  const tapped = INBOX.applyConfirm(out.state);
  assert.equal(tapped.state.card.machine, INBOX.MACHINE_READY);
  assert.equal(tapped.instr.sendEnabled, true, 'SEND IS LIVE ON T1');
  const retry = INBOX.applySend(tapped.state, 'my answer');
  assert.ok(retry.instr.post, 'and it can actually post');
  assert.equal(INBOX.turnSignature(retry.instr.post.turn), INBOX.turnSignature(turnAt(1)), 'carrying the FRESH token');
});

test('defect 2 · a stale `question_changed` must not re-wedge a card the operator already confirmed', () => {
  const r = row({});
  const sent = INBOX.applySend(stateWith([r], r, { draft: 'my answer' }), 'my answer');
  let st = INBOX.applyRefresh(sent.state, { ok: true, items: [onTurn(r, 1)] }).state;
  st = INBOX.applyConfirm(st).state;                       // ready, on T1
  assert.equal(st.machine, undefined);                     // (the card holds it, not the state)
  assert.equal(st.card.machine, INBOX.MACHINE_READY);

  const out = INBOX.applyReplyResult(st, 'question_changed', sent.instr.postedCard);
  assert.equal(out.state.card.machine, INBOX.MACHINE_READY, 'a refusal of T0 cannot send T1 back to awaiting-fresh');
  assert.equal(out.instr.immediateGet, false, 'and cannot buy a GET for a question that already arrived');
  assert.equal(out.instr.sendEnabled, true);
});

test('defect 2 · `ok` still closes the card even when the turn moved under it — the send DID land', () => {
  const r = row({});
  const sent = INBOX.applySend(stateWith([r], r, { draft: 'my answer' }), 'my answer');
  const moved = INBOX.applyRefresh(sent.state, { ok: true, items: [onTurn(r, 1)] });
  const out = INBOX.applyReplyResult(moved.state, 'ok', sent.instr.postedCard);
  assert.equal(out.state.card, null, 'success closes it');
  assert.equal(out.instr.closeCard, true);
  assert.equal(out.instr.clearField, true);
  assert.deepEqual(out.state.rows.map(INBOX.rowKey), [INBOX.rowKey(r)], 'and the row stays until a refresh removes it');
});

test('defect 2 · wired — the latch never lands, and Send comes back on the fresh turn', async () => {
  const stale = row({});
  const fresh = onTurn(stale, 1);
  let served = 0;
  const h = mountHeld({ get: () => { served++; return { body: payloadOf([served === 1 ? stale : fresh]) }; } });
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'the answer I still want to send';
  ta.oninput();
  byClass(h.pane, 'isend')[0].onclick();
  await flush();

  // The world moves on while the POST is in flight.
  h.ui.refresh();
  await flush();
  assert.equal(h.ui.state().card.machine, INBOX.MACHINE_RECONFIRM);

  await h.answer(0, 'already_answered');

  assert.equal(h.ui.state().card.latched, false, 'no latch from a question that is gone');
  assert.equal(byClass(h.pane, 'inotice')[0].textContent, INBOX.QUESTION_CHANGED_REVIEW, 'the machine still owns the line');
  byClass(h.pane, 'inotice')[0].onclick();
  assert.equal(byClass(h.pane, 'isend')[0].disabled, false, 'SEND IS ALIVE on the fresh question');
  byClass(h.pane, 'isend')[0].onclick();
  await flush();
  assert.equal(h.calls.posts.length, 2);
  assert.equal(INBOX.turnSignature(h.calls.posts[1].turn), INBOX.turnSignature(turnAt(1)), 'the retry carries the fresh token');
});

test('in-flight · Send is dead for the round trip, the draft is not, and a double tap is one POST', async () => {
  const r = row({});
  const h = mountHeld({ get: () => ({ body: payloadOf([r]) }) });
  h.ui.open();
  await flush();
  byClass(h.pane, 'irow')[0].onclick();
  const ta = byTag(h.pane, 'TEXTAREA')[0];
  ta.value = 'sent once, please';
  ta.oninput();
  const send = byClass(h.pane, 'isend')[0];
  assert.equal(send.disabled, false);

  send.onclick();
  await flush();
  assert.equal(send.disabled, true, 'dead while the POST is in flight');
  assert.equal(ta.value, 'sent once, please', 'the draft is untouched by the disable');
  assert.equal(byTag(h.pane, 'TEXTAREA')[0], ta, 'and the field node never moved');

  send.onclick();                                  // the double tap
  await flush();
  assert.equal(h.calls.posts.length, 1, 'ONE POST — a second tap cannot re-send the same token');

  await h.answer(0, 'not_at_prompt');
  assert.equal(byClass(h.pane, 'isend')[0].disabled, false, 'and it comes back through the ordinary conjunction');
  assert.equal(h.ui.state().card.sending, false);
  assert.equal(h.ui.state().card.machine, INBOX.MACHINE_READY, 'no fourth state was invented');
});

test('in-flight · the disable is the conjunction, not a state — the pure layer refuses the second send', () => {
  const r = row({});
  const first = INBOX.applySend(stateWith([r], r, { draft: 'mine' }), 'mine');
  assert.ok(first.instr.post, 'the first send posts');
  assert.equal(first.instr.sendEnabled, false, 'and the button dies with it');
  assert.equal(first.state.card.sending, true);
  assert.equal(first.state.card.draft, 'mine', 'the draft is not a casualty of the disable');
  assert.equal(first.state.card.machine, INBOX.MACHINE_READY, 'the MACHINE is untouched — sending is a latch, not a state');

  assert.equal(INBOX.applySend(first.state, 'mine').instr.post, null, 'the second send is a structural no-op');
  assert.equal(INBOX.canSend(first.state.card), false);
  // ...and it is released by the result, whatever the result is.
  for (const code of ['not_at_prompt', 'pane_changed', 'bridge_unreachable', INBOX.REPLY_NETWORK_ERROR]) {
    const out = INBOX.applyReplyResult(first.state, code, first.instr.postedCard);
    assert.equal(out.state.card.sending, false, `${code}: released`);
    assert.equal(out.instr.sendEnabled, true, `${code}: and retryable, per §6.1`);
  }
});

// ================================================================================================
// privacy
// ================================================================================================

test('privacy · nothing this story ships carries live-machine identity', () => {
  // Verified with node and a real regex, never the shell grep (a ugrep wrapper that skips gitignored
  // files and produces false all-clears).
  const files = ['public/inbox.js', 'test/p9-inbox-reply-ui.test.js'];
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
  // Every session id in this file is on the reserved synthetic grammar. The prefix is assembled from
  // pieces so that this assertion does not match ITSELF and report its own regex as a session id.
  const prefix = 'fixture-' + 'inbox-';
  const ids = readSrc('test/p9-inbox-reply-ui.test.js').match(new RegExp(prefix + "[^\\s'\"`]*", 'g')) || [];
  assert.ok(ids.length > 0, 'sanity: the scan must actually find the synthesised ids');
  const allowed = new RegExp('^' + prefix + '(\\$\\{n\\}|\\d+)$');
  for (const id of ids) assert.match(id, allowed, `${id} must be synthetic`);
});
