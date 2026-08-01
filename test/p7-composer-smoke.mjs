// p7 Track A — browser proof that a pane's composer sends to THAT pane's surface.
//
// This is the bug the track exists to kill: one composer pointed at `state.tab` meant the box on
// screen and the terminal receiving the text could be different things, and a prompt meant for one
// agent executed by another has no undo. A DOM assertion cannot prove the fix — only reading both
// surfaces back off the Mac can. So the test types unique text into pane A and asserts pane A's
// surface has it AND pane B's does not, then repeats the other way round.
//
// Runs against an ISOLATED instance (ports 8091/8792) in a SCRATCH workspace it creates and closes.
// The operator's live mirror and live sessions are never touched.
//
//   NODE_PATH=/path/to/workspace/app-web/node_modules node test/p7-composer-smoke.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// This repo has no dependencies, so Playwright is BORROWED from a sibling checkout. ESM ignores
// NODE_PATH, so a bare `import 'playwright'` cannot find it — the path is imported directly, the
// same way test/multipane-smoke.mjs does it.
const PW = process.env.PLAYWRIGHT_DIR || '/path/to/workspace/app-web/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const exec = promisify(execFile);
const CMUX = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const BASE = process.env.P7_BASE || 'http://127.0.0.1:8091';
const TOKEN = process.env.SERVER_TOKEN;
if (!TOKEN) { console.error('SERVER_TOKEN required'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmux = async (args) => (await exec(CMUX, args, { maxBuffer: 32 << 20 })).stdout;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ok  ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };

async function tree() {
  const j = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
  const out = [];
  for (const w of j.windows || []) for (const ws of w.workspaces || []) {
    const panes = (ws.panes || []).map((p) => ({ id: p.id, surfaces: (p.surfaces || []).map((s) => s.id) }));
    out.push({ id: ws.id, title: ws.title || '', panes });
  }
  return out;
}
async function screenText(surface) {
  const d = JSON.parse(await cmux(['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })]));
  const rg = d.render_grid || {};
  return (rg.row_spans || []).map((s) => s.text).join(' ');
}

let scratchWs = null;
async function cleanup() {
  if (scratchWs) { try { await cmux(['close-workspace', '--workspace', scratchWs]); } catch (_) {} scratchWs = null; }
}
process.on('exit', () => { if (scratchWs) console.log('WARNING: scratch workspace may remain:', scratchWs); });

async function main() {
  // ---- a scratch workspace with two panes, created without stealing focus ----
  const before = new Set((await tree()).map((w) => w.id));
  await cmux(['new-workspace', '--focus', 'false', '--cwd', process.env.HOME]);
  await sleep(1500);
  const created = (await tree()).find((w) => !before.has(w.id));
  if (!created) throw new Error('scratch workspace did not appear');
  scratchWs = created.id;
  await cmux(['new-pane', '--type', 'terminal', '--direction', 'right', '--workspace', scratchWs, '--focus', 'false']);
  await sleep(2000);

  const ws = (await tree()).find((w) => w.id === scratchWs);
  ok(ws.panes.length === 2, `scratch workspace has two panes (got ${ws.panes.length})`);
  const [paneA, paneB] = ws.panes;
  const surfA = paneA.surfaces[0], surfB = paneB.surfaces[0];
  ok(surfA && surfB && surfA !== surfB, 'the two panes hold two distinct surfaces');

  const browser = await chromium.launch();
  const W = Number(process.env.P7_W || 390), H = Number(process.env.P7_H || 844);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: W < 700, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });

  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  // Switch to the scratch workspace through the UI's own workspace menu.
  await page.click('#wsChip');
  await page.waitForSelector('#wsMenu:not([hidden])', { timeout: 5000 });
  const wsBtn = page.locator('#wsMenu button', { hasText: created.title || 'zsh' }).first();
  if (await wsBtn.count()) await wsBtn.click();
  else await page.keyboard.press('Escape');
  await sleep(2500);

  // A phone is narrow, so the mirror shows one pane at a time; both still own a footer.
  const feet = await page.locator('.pfoot').count();
  ok(feet >= 1, `every mirrored pane has its own footer (${feet})`);

  // ---- the actual proof ----
  const stamp = Date.now().toString(36);
  const textA = `echo PANE_A_${stamp}`;
  const textB = `echo PANE_B_${stamp}`;

  async function typeInto(paneIndex, text) {
    // Take the composer for this pane the way a user does: tap its footer bar if it has one,
    // otherwise the composer is already here.
    const bars = page.locator('.pcomposebar');
    if (await bars.count() > paneIndex) await bars.nth(paneIndex).click();
    await page.waitForSelector('.pfoot footer', { timeout: 5000 });
    await page.fill('#text', text);
    await page.locator('#send').dispatchEvent('pointerdown');
    await sleep(2500);
  }

  // The mirror paints the focused pane; drive the panes by selecting each surface in the tab strip.
  // On a phone the mirror shows one pane at a time, so "switch pane" means selecting that pane's
  // surface in the tab strip. Pane chips only exist where a pane holds several surfaces.
  async function selectSurface(sid) {
    const chip = page.locator(`[data-surface="${sid}"]`).first();
    if (await chip.count()) { await chip.click(); await sleep(1500); return true; }
    const tab = page.locator(`#tabs [data-id="${sid}"]`).first();
    if (await tab.count()) { await tab.click(); await sleep(1500); return true; }
    return false;
  }

  const gotA = await selectSurface(surfA);
  ok(gotA, 'pane A surface is reachable from the tab strip');
  await typeInto(0, textA);
  const afterA_A = await screenText(surfA);
  const afterA_B = await screenText(surfB);
  ok(afterA_A.includes(`PANE_A_${stamp}`), 'text typed for pane A reached pane A');
  ok(!afterA_B.includes(`PANE_A_${stamp}`), 'text typed for pane A did NOT reach pane B — the wrong-pane bug');

  const gotB = await selectSurface(surfB);
  ok(gotB, 'pane B surface is reachable from the tab strip');
  await typeInto(0, textB);
  const afterB_B = await screenText(surfB);
  const afterB_A = await screenText(surfA);
  ok(afterB_B.includes(`PANE_B_${stamp}`), 'text typed for pane B reached pane B');
  ok(!afterB_A.includes(`PANE_B_${stamp}`), 'text typed for pane B did NOT reach pane A');

  // ---- live toggle: state is per surface, and toggling transmits nothing ----
  const liveBefore = await screenText(surfB);
  await page.locator('#liveToggle').dispatchEvent('pointerdown');
  await sleep(600);
  ok(await page.locator('#text.live').count() === 1, 'the field shows it is live');
  ok(await page.locator('#send').isHidden(), 'Send is hidden while live — nothing is pending to submit');
  await page.locator('#liveToggle').dispatchEvent('pointerdown');
  await sleep(600);
  const liveAfter = await screenText(surfB);
  ok(liveAfter === liveBefore, 'toggling live in either direction transmitted nothing');

  // ---- focus survives the background renders that killed it in live use ----
  // renderPanes() runs on every tree poll and every layout frame, and it re-mounts the composer.
  // appendChild MOVES a node, so moving the focused input's ancestor dropped focus every few
  // seconds — the operator: "I keep losing focus from this text box." Idempotent mount is the fix; this
  // asserts it by holding focus across the poll interval and checking the caret survived too.
  await page.locator('#text').click();
  await page.fill('#text', 'draft-that-must-survive');
  await page.locator('#text').evaluate((el) => el.setSelectionRange(5, 5));
  await sleep(9000);                                    // longer than the 5s tree poll
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'text',
    'the composer still has focus after background re-renders');
  ok(await page.inputValue('#text') === 'draft-that-must-survive', 'and the text was not reloaded under the caret');
  ok(await page.locator('#text').evaluate((el) => el.selectionStart) === 5, 'and the caret did not jump');
  await page.fill('#text', '');

  // ---- the composer follows the FOCUSED pane, with no bar-hunting ----
  // The operator: "the active pane should get the text input. I shouldn't have to hunt for the thin bar at
  // the bottom and click that." Selecting a surface is the same gesture as focusing its pane, so
  // after a plain tab switch the composer must already be pointed at it.
  await selectSurface(surfA);
  ok(await page.evaluate((sid) => {
    const foot = document.querySelector('.pfoot footer');
    return !!foot;                                     // the composer is mounted in SOME pane footer
  }, surfA), 'the composer is mounted in a pane footer after a plain tab switch');
  const stampF = Date.now().toString(36) + 'f';
  await page.fill('#text', `echo FOLLOW_${stampF}`);
  await page.locator('#send').dispatchEvent('pointerdown');
  await sleep(2500);
  ok((await screenText(surfA)).includes(`FOLLOW_${stampF}`),
    'and it sent to the pane that was focused — no bar tap needed');

  // ---- taking another pane's composer must NOT blow that pane up ----
  // The original design auto-soloed on focus and destroyed the split every time a bar was tapped.
  const bars = page.locator('.pcomposebar');
  if (await bars.count()) {
    const panesBefore = await page.locator('.pane').count();
    await bars.first().click();
    await sleep(1200);
    ok(await page.locator('.pane').count() === panesBefore, 'the split survives taking another pane\'s composer');
    ok(await page.locator('.pane.solo').count() === 0, 'and no pane was blown up to full screen');
  }

  // ---- the removed chrome is gone from view ----
  ok(await page.locator('#modeSeg').isHidden(), 'the Compose/Live segmented control is gone');
  ok(await page.locator('#hint').isHidden(), 'the instruction line is gone');
  ok(await page.locator('#pasteBtn').count() === 0 || await page.locator('#pasteBtn').isHidden(),
    'the separate clipboard button is gone');

  await page.screenshot({ path: '/tmp/p7-composer.png', fullPage: false });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
