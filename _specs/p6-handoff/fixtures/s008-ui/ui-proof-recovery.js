'use strict';
// S-008 evidence — the recovery element (spec §M4/§7.2), against real published snapshots.
//
//   node ui-proof-recovery.js <one.json> <many.json> press
//
// one.json  = a published snapshot with the undecidable set at size 1
// many.json = a later snapshot with the set grown (same oldest member, so `since` is identical)
// press     = after the pinned-render assertions, boot against the LIVE server and press adopt.
//
// The pinned renders share one frozen clock, so the byte-identical claim compares the CHANGE under
// test (set size) and not the age of a row.
const assert = require('assert');
const fs = require('fs');
const { bootRadar, buttonsNamed, allButtons, recoveryEls, containsText, click, flush } = require('./dom-stub');

async function waitUntil(fn, why, ms) {
  let waited = 0;
  while (!fn()) {
    if (waited >= (ms || 8000)) throw new Error('timed out waiting for: ' + why);
    await flush();
    waited += 25;
  }
}

(async () => {
  const one = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const many = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  assert.ok(one.handoffRecovery && many.handoffRecovery, 'both snapshots carry the recovery element');
  assert.strictEqual(one.handoffRecovery.since, many.handoffRecovery.since,
    'the oldest member is the same, so since is identical — the pinned comparison is honest');
  assert.notStrictEqual(one.handoffRecovery.token, many.handoffRecovery.token, 'the set really did grow');
  assert.ok(many.counts.handoffsLive > one.counts.handoffsLive, 'more handoffs are live in the second snapshot');

  const NOW = () => Date.parse(many.generatedAt) + 30000;
  const texts = [];
  for (const state of [one, many]) {
    const b = bootRadar({ base: 'http://unused.invalid', token: 'x', state, now: NOW });
    await b.api.refresh();
    await flush();
    const els = recoveryEls(b.mount);
    assert.strictEqual(els.length, 1, 'exactly ONE element, however many handoffs are undecidable');
    const el = els[0];
    const btns = allButtons(el);
    assert.strictEqual(btns.length, 2, 'exactly two controls');
    assert.deepStrictEqual(btns.map((x) => x.textContent).sort(), ['adopt', 'discard']);
    const text = el.childNodes[0].textContent;
    assert.ok(!/more/.test(text), 'never "N more"');
    assert.ok(!/h-\d{8}/.test(el.textContent), 'no handoff id anywhere on the element');
    texts.push(text);
  }
  assert.strictEqual(texts[0], texts[1],
    'the rendered text is BYTE-IDENTICAL whether one handoff or several are undecidable');

  // ---- the live press: adopt applies to the whole set and empties the element -----------------
  const live = bootRadar({ base: process.env.BASE, token: process.env.SERVER_TOKEN });
  await live.api.refresh();
  await flush();
  const els = recoveryEls(live.mount);
  assert.strictEqual(els.length, 1, 'the live board renders the element');
  click(buttonsNamed(els[0], 'adopt')[0]);
  await waitUntil(() => live.posts.length === 1, 'the adopt POST');
  assert.strictEqual(live.posts[0].path, '/api/radar/recovery/adopt');
  assert.deepStrictEqual(Object.keys(live.posts[0].body), ['token'], 'the press posts {token} and nothing else');
  await waitUntil(() => recoveryEls(live.mount).length === 0, 'the element to clear after one press');
  assert.ok(!containsText(live.mount, 'not_recoverable'), 'no error affordance appeared');

  console.log(JSON.stringify({ ok: true, elementText: texts[0], adoptedToken: live.posts[0].body.token }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ui-proof-recovery FAIL:', e && e.message); process.exit(1); });
