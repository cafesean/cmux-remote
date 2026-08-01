// p7 Track B — browser proof of both chip sources.
//
//   Source B (disk): typing `@cad` in the compose box offers real directories, and tapping one
//                    replaces the partial token. Nothing is sent.
//   Source A (live): a real Claude session with its `@` picker open is mirrored as chips, and
//                    tapping the third chip actually moves Claude's selection to it.
//
// The live half runs against a REAL Claude session in a scratch workspace, and it drives the `@`
// picker rather than the `/` menu on purpose: choosing a file INSERTS TEXT and executes nothing, so
// proving the commit path costs no side effects.
//
//   SERVER_TOKEN=… node test/p7-chips-smoke.mjs

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

async function tree() {
  const j = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
  const out = [];
  for (const w of j.windows || []) for (const ws of w.workspaces || []) {
    out.push({ id: ws.id, title: ws.title || '', surfaces: (ws.panes || []).flatMap((p) => (p.surfaces || []).map((s) => s.id)) });
  }
  return out;
}
async function grid(surface) {
  const d = JSON.parse(await cmux(['rpc', 'terminal.replay', JSON.stringify({ surface_id: surface })]));
  return d.render_grid || {};
}
async function screenText(surface) {
  const g = await grid(surface);
  return (g.row_spans || []).map((s) => s.text).join('');
}

let scratchWs = null;
const cleanup = async () => { if (scratchWs) { try { await cmux(['close-workspace', '--workspace', scratchWs]); } catch (_) {} scratchWs = null; } };

async function main() {
  const before = new Set((await tree()).map((w) => w.id));
  await cmux(['new-workspace', '--focus', 'false', '--cwd', '/path/to/workspace']);
  await sleep(1800);
  const created = (await tree()).find((w) => !before.has(w.id));
  if (!created) throw new Error('scratch workspace did not appear');
  scratchWs = created.id;
  const surface = created.surfaces[0];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });
  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  ok(await page.evaluate(() => !!window.cmuxMenuParse), 'menuparse.js loaded in the page');

  // The tab strip lists the CURRENT workspace only, so the scratch one has to be selected first —
  // through the UI's own workspace menu, the way a user would.
  await page.click('#wsChip');
  await page.waitForSelector('#wsMenu:not([hidden])', { timeout: 5000 });
  const entries = page.locator('#wsMenu button');
  const n = await entries.count();
  let switched = false;
  for (let i = n - 1; i >= 0; i--) {                 // newest workspace is last
    const t = (await entries.nth(i).textContent()) || '';
    if (created.title && t.includes(created.title)) { await entries.nth(i).click(); switched = true; break; }
  }
  if (!switched) { await entries.nth(n - 1).click(); }
  await sleep(3000);

  const tab = page.locator(`#tabs [data-id="${surface}"]`).first();
  await tab.waitFor({ timeout: 15000 });
  await tab.click();
  await sleep(2000);

  // ---- source B: disk candidates while composing -------------------------------------------
  // Which directories exist in the workspace cwd is machine-specific, so the prefix to complete
  // against is a knob. Point it at a name that several sibling directories share on YOUR machine —
  // the Tab assertion below is only meaningful when more than one candidate matches.
  const DIR_PREFIX = process.env.CHIP_DIR_PREFIX || 'app';
  await page.fill('#text', `@${DIR_PREFIX}`);
  await page.locator('#text').dispatchEvent('input');
  await page.waitForSelector('#chipBar:not([hidden]) .mchip', { timeout: 10000 });
  const diskChips = await page.locator('#chipBar .mchip').allTextContents();
  ok(diskChips.length > 0, `disk chips offered for "@${DIR_PREFIX}" (${diskChips.slice(0, 3).join(', ')})`);
  ok(diskChips.some((t) => t.startsWith(DIR_PREFIX)), 'the candidates are real directories from the workspace cwd');
  ok(await page.locator('#chipBar').getAttribute('data-source') === 'disk', 'the bar names its source');

  const beforePick = await screenText(surface);
  await page.locator('#chipBar .mchip').first().dispatchEvent('pointerdown');
  await sleep(500);
  const val = await page.inputValue('#text');
  ok(val.startsWith(`@${DIR_PREFIX}`), `tapping a chip completed the token in the box (${val})`);
  ok((await screenText(surface)) === beforePick, 'completing a token sent NOTHING to the terminal');

  // ---- keyboard completion: Tab, arrows, Enter ----------------------------------------------
  await page.fill('#text', `@${DIR_PREFIX}-`);
  await page.locator('#text').dispatchEvent('input');
  await page.waitForSelector('#chipBar:not([hidden]) .mchip', { timeout: 10000 });

  // Tab completes as far as every candidate agrees and then stops — shell semantics. All the
  // <prefix>-* directories share "<prefix>-", so Tab must not guess one of them.
  const beforeTab = await page.inputValue('#text');
  await page.locator('#text').press('Tab');
  await sleep(700);
  const afterTab = await page.inputValue('#text');
  ok(afterTab.startsWith(`@${DIR_PREFIX}-`), `Tab kept the common prefix (${afterTab})`);
  ok(afterTab.length >= beforeTab.length, 'Tab never shortens what you typed');

  // Arrows select a chip; nothing is selected until they say so.
  ok(await page.locator('#chipBar .mchip.sel').count() === 0, 'no chip is selected before an arrow key');
  await page.locator('#text').press('ArrowRight');
  await sleep(400);
  ok(await page.locator('#chipBar .mchip.sel').count() === 1, '→ selects the first chip');
  await page.locator('#text').press('ArrowRight');
  await sleep(300);
  await page.locator('#text').press('ArrowLeft');
  await sleep(300);
  ok(await page.locator('#chipBar .mchip.sel').count() === 1, '← and → walk the selection');

  // Enter accepts the SELECTED chip — and only because one was deliberately selected.
  const selText = await page.locator('#chipBar .mchip.sel').textContent();
  const screenBeforeEnter = await screenText(surface);
  await page.locator('#text').press('Enter');
  await sleep(800);
  const afterEnter = await page.inputValue('#text');
  ok(afterEnter.includes(selText.trim()), `Enter accepted the selected chip (${afterEnter})`);
  ok((await screenText(surface)) === screenBeforeEnter, 'and accepting a chip sent NOTHING to the terminal');

  await page.fill('#text', '');
  await page.locator('#text').dispatchEvent('input');
  await sleep(400);

  // ---- source A: a real live menu ------------------------------------------------------------
  await cmux(['send', '--surface', surface, '--', 'claude']);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(14000);
  await cmux(['send', '--surface', surface, '--', '@']);
  await sleep(3500);

  const g = await grid(surface);
  const parsed = await page.evaluate((gg) => {
    const m = window.cmuxMenuParse.parseMenu(gg);
    return m ? { n: m.items.length, marked: m.markedIndex, signal: m.signal, texts: m.items.map((i) => i.text) } : null;
  }, { columns: g.columns, rows: g.rows, cursor: g.cursor, styles: g.styles, row_spans: g.row_spans, active_screen: g.active_screen });
  ok(parsed && parsed.n >= 3, `the live @ picker parses as a menu (${parsed && parsed.n} items, signal ${parsed && parsed.signal})`);

  await page.waitForSelector('#chipBar[data-source="live"] .mchip', { timeout: 15000 }).catch(() => {});
  const liveSource = await page.locator('#chipBar').getAttribute('data-source');
  const liveChips = await page.locator('#chipBar .mchip').allTextContents();
  ok(liveSource === 'live' && liveChips.length >= 3, `the live menu is mirrored as chips (${liveChips.length})`);
  ok((await page.locator('#chipBar .mchip.marked').count()) === 1, 'exactly one chip is shown as the current selection');

  // Tap the third chip and prove Claude's own selection moved there.
  const target = liveChips[2];
  await page.locator('#chipBar .mchip').nth(2).dispatchEvent('pointerdown');
  await sleep(4000);
  const after = await grid(surface);
  const afterParsed = await page.evaluate((gg) => {
    const m = window.cmuxMenuParse.parseMenu(gg);
    return m ? { marked: m.markedIndex, text: m.items[m.markedIndex] && m.items[m.markedIndex].text } : null;
  }, { columns: after.columns, rows: after.rows, cursor: after.cursor, styles: after.styles, row_spans: after.row_spans, active_screen: after.active_screen });
  const promptLine = await screenText(surface);
  const committed = (afterParsed && afterParsed.text === target) || promptLine.includes(target.replace(/^\+\s*/, '').replace(/\/$/, ''));
  ok(committed, `tapping chip 3 moved Claude's own selection to it (wanted "${target}")`);

  await page.screenshot({ path: '/tmp/p7-chips.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
