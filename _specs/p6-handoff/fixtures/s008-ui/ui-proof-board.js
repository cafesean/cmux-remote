'use strict';
// S-008 evidence — select mode on the fixture board: the REAL public/radar.js reading the REAL
// harness server over the shipped auth. Asserts roles, text and outgoing request bodies — never an
// implementation class name.
//
// Usage: node ui-proof-board.js  (BASE and SERVER_TOKEN in the environment; prints a JSON summary)
const assert = require('assert');
const { bootRadar, buttonsNamed, allButtons, checkboxes, walk, containsText, click, flush } = require('./dom-stub');

// A rendered row: the nearest ancestor registered as a queue row or hero, identified by the row
// TITLE text describe() renders — the accessible identity, not a style hook.
function rowsWithTitle(mount, re) {
  const out = [];
  walk(mount, (n) => {
    if (n.tagName !== 'DIV') return;
    const titled = n.childNodes.some((c) => c.tagName === 'SPAN' && re.test(c.textContent));
    if (titled) out.push(n);
  });
  return out;
}

(async () => {
  const net = { base: process.env.BASE, token: process.env.SERVER_TOKEN };
  const b = bootRadar(net);
  await b.api.refresh();
  await flush();

  // ---- the resting board: no checkbox anywhere, no action bar, one select control -------------
  assert.strictEqual(checkboxes(b.mount).length, 0, 'the resting board renders no checkbox');
  assert.strictEqual(buttonsNamed(b.mount, 'hand off').length, 0, 'no action bar at rest');
  assert.strictEqual(buttonsNamed(b.mount, 'select').length, 1, 'one toolbar control enters the mode');

  // ---- select mode ----------------------------------------------------------------------------
  click(buttonsNamed(b.mount, 'select')[0]);
  // expose every queue row and every fold row
  const more = allButtons(b.mount).filter((x) => x.dataset.role === 'queue-more' && /more/.test(x.textContent));
  if (more.length) click(more[0]);
  for (const id of ['moving', 'parked', 'worktrees', 'dirty']) {
    const btns = allButtons(b.mount).filter((x) => x.dataset.fold === id);
    if (btns.length && btns[0].getAttribute('aria-expanded') !== 'true') click(btns[0]);
  }

  const boxes = checkboxes(b.mount);
  assert.ok(boxes.length >= 6, `expected checkboxes on mergeable + default-unpushed + orphan-group + 2 epic rows + worktree rows, found ${boxes.length}`);

  // ---- non-selectable rows carry NO checkbox, per type ----------------------------------------
  // blocked / blocked-stale ("Answer the ... session"), decision ("Decide: ..."),
  // spec-orphan-group ("Triage N untagged spec folders"). Each must be ON the board (the fixture
  // built them) and must carry no checkbox — an absent row would prove nothing.
  const nonSelectable = [
    [/^Answer the .+ session/, 'blocked / blocked-stale', 2],
    [/^Decide: /, 'decision', 1],
    [/untagged spec folder/, 'spec-orphan-group', 1],
  ];
  const perType = {};
  for (const [re, label, minRows] of nonSelectable) {
    const rows = rowsWithTitle(b.mount, re);
    assert.ok(rows.length >= minRows, `${label}: expected >= ${minRows} rendered row(s), found ${rows.length}`);
    for (const row of rows) {
      assert.strictEqual(checkboxes(row).length, 0, `${label}: a non-selectable row must render no checkbox`);
    }
    perType[label] = rows.length;
  }
  // the orphan-group header IS selectable, and its checkbox stands for every member
  const orphanGroupRows = rowsWithTitle(b.mount, /untagged branch/);
  assert.ok(orphanGroupRows.length >= 1 && checkboxes(orphanGroupRows[0]).length === 1,
    'the orphan-group header carries exactly one checkbox');

  // ---- pick one of everything selectable; the wire carries §6.1 selectors ---------------------
  const picks = [
    [/^Merge BETA-908 into develop/, 'the mergeable item'],
    [/^default-unpushed/, 'the default-unpushed item'],
    [/untagged branch/, 'the orphan-group header'],
  ];
  for (const [re, label] of picks) {
    const row = rowsWithTitle(b.mount, re)[0];
    assert.ok(row, `${label} must be on the board`);
    click(checkboxes(row)[0]);
  }
  // epic row + a worktree row, addressed by their own identities
  let epicRow = null;
  walk(b.mount, (n) => { if (!epicRow && n.dataset && n.dataset.epic === 'PROJ-908') epicRow = n; });
  assert.ok(epicRow, 'the PROJ-908 epic row is in an open fold');
  click(checkboxes(epicRow)[0]);
  const wtBox = checkboxes(b.mount).find((c) => /wt-done/.test(c.getAttribute('aria-label') || ''));
  assert.ok(wtBox, 'the stale worktree row carries a checkbox');
  click(wtBox);

  // ---- the action bar: exactly two enabled controls, by role and name -------------------------
  let bar = null;
  walk(b.mount, (n) => {
    if (!bar && n.childNodes.some((c) => c.tagName === 'SPAN' && /^\d+ selected/.test(c.textContent))
      && buttonsNamed(n, 'hand off').length === 1) bar = n;
  });
  assert.ok(bar, 'the action bar shows the count');
  const barButtons = allButtons(bar);
  assert.strictEqual(barButtons.length, 2, 'exactly two actionable elements on the bar');
  assert.deepStrictEqual(barButtons.map((x) => x.textContent).sort(), ['cancel', 'hand off']);
  assert.ok(barButtons.every((x) => !x.disabled), 'both controls enabled');
  assert.ok(containsText(bar, '5 selected'), 'five rows are picked');

  // ---- hand off posts ONE preview whose selectors are the §6.1 identities ---------------------
  click(buttonsNamed(bar, 'hand off')[0]);
  let waited = 0;
  while (b.posts.length === 0 && waited < 5000) { await flush(); waited += 25; }
  assert.strictEqual(b.posts.length, 1);
  assert.strictEqual(b.posts[0].path, '/api/radar/handoff/preview');
  const sels = b.posts[0].body.selectors.slice().sort();
  const expected = [
    'branch:s008-repo:develop',
    'epic:BETA-908',
    'epic:PROJ-908',
    'orphan:s008-repo:stray-one',
    'orphan:s008-repo:stray-two',
  ];
  for (const s of expected) assert.ok(sels.includes(s), `preview must carry ${s}; got ${JSON.stringify(sels)}`);
  assert.ok(sels.some((s) => s.startsWith('wt:') && s.includes('wt-done')), 'the worktree row travels as wt:<path>');
  assert.strictEqual(sels.length, 6, 'a group header expands to every member; nothing else is invented');

  // the REAL server answered the preview (every selector resolves on this board)
  waited = 0;
  while (!containsText(b.mount, 'preview ') && waited < 5000) { await flush(); waited += 25; }
  assert.ok(containsText(b.mount, 'workdir '), 'the sheet reached ready against the real preview route');

  // ---- cancel: close, post nothing further, leave select mode ---------------------------------
  click(buttonsNamed(b.mount, 'cancel')[0]);
  assert.strictEqual(checkboxes(b.mount).length, 0, 'cancel leaves select mode');
  assert.strictEqual(b.posts.length, 1, 'cancel posted nothing');

  console.log(JSON.stringify({
    ok: true,
    checkboxes: boxes.length,
    nonSelectableRows: perType,
    postedSelectors: sels,
  }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ui-proof-board FAIL:', e && e.message); process.exit(1); });
