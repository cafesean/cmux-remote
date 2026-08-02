'use strict';
// S-009 evidence — the BOARD rows across the dispatch lifecycle, rendered by the REAL
// public/radar.js from three published snapshots:
//
//   node ui-proof-rows.js <before.json> <during.json> <after.json>
//
// before = the resting board; during = a live (unconfirmed) handoff holds every key the board's
// suppressible rows contribute; after = the handoff reached a terminal status through the server.
// The suppression rule is row-scoped: the epic row and both worktree rows leave WITH the covered
// keys and return with them, while every zero-key row — blocked, blocked-stale, decision — renders
// identically throughout. Assertions are roles and text, never an implementation class name.
const assert = require('assert');
const fs = require('fs');
const { bootRadar, allButtons, checkboxes, walk, containsText, click, flush } = require('./../s008-ui/dom-stub');

async function renderBoard(state) {
  const b = bootRadar({ base: 'http://unused.invalid', token: 'x', state, now: () => Date.parse(state.generatedAt) + 30000 });
  await b.api.refresh();
  await flush();
  // open every fold and the full queue so absence means SUPPRESSED, never merely folded
  const more = allButtons(b.mount).filter((x) => x.dataset.role === 'queue-more' && /more/.test(x.textContent));
  if (more.length) click(more[0]);
  for (const id of ['moving', 'parked', 'worktrees', 'dirty']) {
    const btns = allButtons(b.mount).filter((x) => x.dataset.fold === id);
    if (btns.length && btns[0].getAttribute('aria-expanded') !== 'true') click(btns[0]);
  }
  return b;
}
function hasEpicRow(b, key) {
  let hit = false;
  walk(b.mount, (n) => { if (n.dataset && n.dataset.epic === key) hit = true; });
  return hit;
}
function queueTitles(b) {
  const out = [];
  walk(b.mount, (n) => {
    if (n.tagName === 'DIV' && n.dataset && n.dataset.key) {
      const t = n.childNodes.find((c) => c.tagName === 'SPAN' && c.textContent && !/^[⏳⚠◆⇡?·]$/.test(c.textContent));
      if (t) out.push(t.textContent);
    }
  });
  return out.sort();
}

(async () => {
  const [before, during, after] = process.argv.slice(2, 5).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  const b1 = await renderBoard(before);
  const b2 = await renderBoard(during);
  const b3 = await renderBoard(after);

  // ---- before: every row on the board ---------------------------------------------------------
  assert.ok(hasEpicRow(b1, 'PROJ-909'), 'the epic row is on the resting board');
  assert.ok(containsText(b1.mount, 'wt-done'), 'the stale worktree row is on the resting board');
  assert.ok(containsText(b1.mount, 'wt-a'), 'the dirty worktree is on the resting board');
  assert.ok(containsText(b1.mount, 'Merge PROJ-909 into develop'), 'the mergeable item is on the resting board');
  assert.ok(containsText(b1.mount, 's009 zero-key decision'));
  assert.ok(containsText(b1.mount, 'Answer the'), 'the blocked rows are on the resting board');

  // ---- during: covered rows are GONE; zero-key rows render identically ------------------------
  assert.ok(!hasEpicRow(b2, 'PROJ-909'), 'every key of the epic is held, so its row leaves the board');
  assert.ok(!containsText(b2.mount, 'wt-done'), 'the stale worktree row leaves while its wt: key is held');
  assert.ok(!containsText(b2.mount, 'wt-a'), 'the dirty worktree row leaves while its wt: key is held');
  assert.ok(!containsText(b2.mount, 'Merge PROJ-909 into develop'), 'the mergeable item leaves (derive suppressed it)');
  assert.ok(containsText(b2.mount, 's009 zero-key decision'), 'a decision contributes no key and never leaves');
  assert.ok(containsText(b2.mount, 'Answer the'), 'blocked prompts contribute no key and never leave');
  assert.deepStrictEqual(queueTitles(b2).filter((t) => /Answer the|Decide:/.test(t)),
    queueTitles(b1).filter((t) => /Answer the|Decide:/.test(t)),
    'the zero-key rows render with the same titles during suppression');
  // suppression renders NOTHING of its own: no new element offers to inspect, retry or list a handoff
  assert.strictEqual(checkboxes(b2.mount).length, 0);
  assert.ok(!containsText(b2.mount, 'handoff'), 'the board shows suppression, not handoffs');

  // ---- after: the terminal transition hands every still-true row back -------------------------
  assert.ok(hasEpicRow(b3, 'PROJ-909'), 'the epic row returns after the terminal transition');
  assert.ok(containsText(b3.mount, 'wt-done'));
  assert.ok(containsText(b3.mount, 'wt-a'));
  assert.ok(containsText(b3.mount, 'Merge PROJ-909 into develop'));
  assert.deepStrictEqual(queueTitles(b3), queueTitles(b1), 'the queue equals the pre-dispatch set by role and text');

  console.log(JSON.stringify({ ok: true, queueBefore: queueTitles(b1).length, queueDuring: queueTitles(b2).length }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ui-proof-rows FAIL:', e && e.message); process.exit(1); });
