'use strict';
// S-008 evidence — the confirm sheet against the REAL routes: preview -> ready -> edit/blur
// re-preview (seedOverride, new plan) -> confirm -> a real dispatch (202, stand-in claudeBin) ->
// the sheet closes and select mode ends. Prints the commit body so run.sh can cross-check the
// ledger and prove the same-key replay on the wire.
//
// Usage: node ui-proof-live.js  (BASE, SERVER_TOKEN in the environment)
const assert = require('assert');
const path = require('path');
const { bootRadar, buttonsNamed, allButtons, checkboxes, textareas, walk, containsText, click, flush } = require('./dom-stub');

async function waitUntil(fn, why, ms) {
  let waited = 0;
  while (!fn()) {
    if (waited >= (ms || 8000)) throw new Error('timed out waiting for: ' + why);
    await flush();
    waited += 25;
  }
}

(async () => {
  const REPO = path.join(__dirname, '..', '..', '..', '..');
  const b = bootRadar({ base: process.env.BASE, token: process.env.SERVER_TOKEN });
  await b.api.refresh();
  await flush();

  // ---- compose: exactly the mergeable epic ----------------------------------------------------
  click(buttonsNamed(b.mount, 'select')[0]);
  const more = allButtons(b.mount).filter((x) => x.dataset.role === 'queue-more' && /more/.test(x.textContent));
  if (more.length) click(more[0]);
  const box = checkboxes(b.mount).find((c) => /Merge BETA-908/.test(c.getAttribute('aria-label') || ''));
  assert.ok(box, 'the mergeable row is selectable');
  click(box);
  click(buttonsNamed(b.mount, 'hand off')[0]);

  // ---- ready: the exact plan, rendered --------------------------------------------------------
  await waitUntil(() => textareas(b.mount).length === 1, 'the ready sheet');
  const ta = textareas(b.mount)[0];
  assert.strictEqual(ta.value.split('\n')[0], '/radar-handoff', 'the seed\'s first line invokes the shipped skill (§6.8)');
  assert.ok(/FIRST TURN: inspect and plan only\./.test(ta.value), 'the one appended line is present');
  assert.ok(containsText(b.mount, 'preview '), 'the displayed plan carries its previewId');
  assert.strictEqual(b.posts.length, 1, 'entering ready posted exactly one preview and no commit');
  const firstPreviewId = b.posts[0] && (() => {
    let id = null;
    walk(b.mount, (n) => {
      const m = n._text === null && n.childNodes[0] && n.childNodes[0]._text !== null
        ? /^preview (.+)$/.exec(n.childNodes[0]._text) : null;
      if (m) id = m[1];
    });
    return id;
  })();
  assert.ok(firstPreviewId, 'a previewId is displayed');

  // the safety sentence is rendered byte-equal to S-007's exported constant — fail LOUDLY if the
  // export is missing rather than passing vacuously
  const { SAFETY_NOTICE } = require(path.join(REPO, 'radar', 'handoff.js'));
  assert.ok(typeof SAFETY_NOTICE === 'string' && SAFETY_NOTICE.length > 0, 'radar/handoff.js exports SAFETY_NOTICE');
  assert.ok(containsText(b.mount, SAFETY_NOTICE), 'the sheet renders SAFETY_NOTICE byte-equal to the export');

  // ---- edit + blur: re-preview with seedOverride, never a commit ------------------------------
  ta.value = 'EDITED SEED s008 — checked by the evidence run';
  ta.onblur();
  await waitUntil(() => b.posts.length === 2 && textareas(b.mount).length === 1
    && textareas(b.mount)[0].value.startsWith('EDITED SEED s008'), 'the re-previewed sheet');
  assert.strictEqual(b.posts[1].path, '/api/radar/handoff/preview', 'an edit re-previews; only confirm commits');
  assert.strictEqual(b.posts[1].body.seedOverride, 'EDITED SEED s008 — checked by the evidence run');
  assert.ok(/FIRST TURN: inspect and plan only\./.test(textareas(b.mount)[0].value),
    'the override still receives the appended line');
  let secondPreviewId = null;
  walk(b.mount, (n) => {
    const m = n._text === null && n.childNodes[0] && n.childNodes[0]._text !== null
      ? /^preview (.+)$/.exec(n.childNodes[0]._text) : null;
    if (m) secondPreviewId = m[1];
  });
  assert.ok(secondPreviewId && secondPreviewId !== firstPreviewId, 'an edit minted a NEW plan — new previewId');

  // ---- confirm: the only control that commits; 202 closes exactly as 201 would ----------------
  click(buttonsNamed(b.mount, 'confirm')[0]);
  await waitUntil(() => textareas(b.mount).length === 0 && checkboxes(b.mount).length === 0,
    'the sheet to close and select mode to end', 15000);
  assert.strictEqual(b.posts.length, 3);
  const commit = b.posts[2];
  assert.strictEqual(commit.path, '/api/radar/handoff');
  assert.deepStrictEqual(Object.keys(commit.body).sort(), ['hash', 'idempotencyKey', 'previewId'],
    'commit carries {previewId, hash, idempotencyKey} and never seed bytes');
  assert.strictEqual(commit.body.previewId, secondPreviewId, 'commit submits precisely the displayed plan');

  console.log(JSON.stringify({ ok: true, commitBody: commit.body, previewIds: [firstPreviewId, secondPreviewId] }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ui-proof-live FAIL:', e && e.message); process.exit(1); });
