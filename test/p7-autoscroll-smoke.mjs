// Auto-scroll: a mirrored pane must follow its terminal's tail without being told to.
//
// The bug this covers: panes opened pinned to the TOP and the pin could never clear itself, because
// it forced scrollTop = 0 on every repaint and the scroll event fired by that very set read
// scrollTop === 0. The operator: "I seem to always need to click jump to bottom."
//
// Asserting on scroll position alone would be weak — a cmux grid carries the desktop terminal's
// trailing BLANK rows, so "scrolled to the bottom" and "looking at the newest output" are different
// things. What is asserted is the thing that matters: after new output arrives, the newest line is
// VISIBLE in the pane's viewport.

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
const cmux = async (a) => (await exec(CMUX, a, { maxBuffer: 32 << 20 })).stdout;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

let scratchWs = null;
const cleanup = async () => { if (scratchWs) { try { await cmux(['close-workspace', '--workspace', scratchWs]); } catch (_) {} scratchWs = null; } };

const listWs = async () => JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']))
  .windows.flatMap((w) => w.workspaces);

async function main() {
  const before = new Set((await listWs()).map((w) => w.id));
  await cmux(['new-workspace', '--focus', 'false', '--cwd', process.env.HOME]);
  await sleep(2000);
  const created = (await listWs()).find((w) => !before.has(w.id));
  if (!created) throw new Error('scratch workspace did not appear');
  scratchWs = created.id;
  const surface = created.panes[0].surfaces[0].id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });
  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  await page.click('#wsChip');
  await page.waitForSelector('#wsMenu:not([hidden])', { timeout: 5000 });
  const entries = page.locator('#wsMenu button');
  const n = await entries.count();
  let switched = false;
  for (let i = n - 1; i >= 0; i--) {
    const t = (await entries.nth(i).textContent()) || '';
    if (created.title && t.includes(created.title)) { await entries.nth(i).click(); switched = true; break; }
  }
  if (!switched) await entries.nth(n - 1).click();
  await sleep(3000);

  // Fill well past one screen, then emit a unique marker as the newest line.
  const stamp = 'TAIL_' + Date.now().toString(36);
  await cmux(['send', '--surface', surface, '--', 'for i in $(seq 1 80); do echo "filler line $i"; done']);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(3500);
  await cmux(['send', '--surface', surface, '--', `echo ${stamp}`]);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(4000);

  // Is the newest line actually ON SCREEN — without anyone tapping "jump to bottom"?
  const visible = await page.evaluate((mark) => {
    const screen = document.querySelector('.pscreen');
    if (!screen) return { found: false, reason: 'no pane' };
    const box = screen.getBoundingClientRect();
    for (const row of screen.childNodes) {
      if (!row.textContent || !row.textContent.includes(mark)) continue;
      const r = row.getBoundingClientRect();
      return { found: true, onScreen: r.top >= box.top - 2 && r.bottom <= box.bottom + 2 };
    }
    return { found: false, reason: 'marker not rendered' };
  }, stamp);

  ok(visible.found, `the newest output is rendered in the pane (${visible.reason || 'found'})`);
  ok(visible.found && visible.onScreen, 'and it is VISIBLE without tapping jump-to-bottom');
  ok(await page.locator('#jump.show').count() === 0, 'the jump-to-bottom chip is not being offered — we are already at the tail');

  // A reader who scrolls up KEEPS their position: following is theirs to break.
  await page.evaluate(() => { const s = document.querySelector('.pscreen'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); });
  await sleep(600);
  const top = await page.evaluate(() => document.querySelector('.pscreen').scrollTop);
  await cmux(['send', '--surface', surface, '--', 'echo after-scrollback']);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(4000);
  const stillTop = await page.evaluate(() => document.querySelector('.pscreen').scrollTop);
  ok(stillTop <= top + 40, 'scrolling up stops the auto-follow — new output does not yank you back');
  ok(await page.locator('#jump.show').count() === 1, 'and the jump chip appears while you are behind');

  await page.screenshot({ path: '/tmp/p7-autoscroll.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
