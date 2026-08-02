// Wrapped-row tail follow: on a phone, zoomed text WRAPS (pre-wrap + the 7px font floor / user
// zoom), so one grid row paints as 2+ visual lines. scrollToTail used to compute the tail target
// as (rowIndex + 1) * lineHeight — row-index arithmetic that undercounts pixels once rows wrap.
//
// The bug this covers: the operator scrolls to the very bottom, follow re-engages, and the next
// repaint yanks the viewport UP to the miscalculated target — mid-content. "When you scroll to
// the very bottom, it always jumps back up to the middle and I can never stay at the bottom."
//
// Repro is deterministic: font zoom 2x on a 390px viewport makes every full-width row wrap, and
// long filler lines make the undercount large enough that the newest line lands OFF screen.

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

// Is the row carrying `mark` inside the pane's viewport right now?
const markerVisible = (mark) => {
  const screen = document.querySelector('.pscreen');
  if (!screen) return { found: false, reason: 'no pane' };
  const box = screen.getBoundingClientRect();
  for (const row of screen.childNodes) {
    if (!row.textContent || !row.textContent.includes(mark)) continue;
    const r = row.getBoundingClientRect();
    return { found: true, onScreen: r.top >= box.top - 2 && r.bottom <= box.bottom + 2,
             wrapped: r.height > parseFloat(getComputedStyle(screen).lineHeight) * 1.5 };
  }
  return { found: false, reason: 'marker not rendered' };
};

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
  // 2x font zoom BEFORE the app boots — this is what makes rows wrap, and what a phone reader
  // actually runs at (the fit-to-columns baseline is unreadably small).
  await page.addInitScript(() => { try { localStorage.setItem('cmux_fontzoom', '2'); } catch (_) {} });
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

  // Long lines: each fills the source terminal's width, so at 2x zoom every one wraps in the pane.
  const stamp = 'WRAPTAIL_' + Date.now().toString(36);
  await cmux(['send', '--surface', surface, '--', 'for i in $(seq 1 60); do printf "line %03d "; printf "%0.sx" $(seq 1 150); echo; done']);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(3500);
  await cmux(['send', '--surface', surface, '--', `echo ${stamp}`]);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(4000);

  // 1) Follow must land ON the newest line even though rows above it wrap.
  const v1 = await page.evaluate(markerVisible, stamp);
  ok(v1.found, `newest output is rendered (${v1.reason || 'found'})`);
  ok(v1.found && v1.onScreen, 'auto-follow lands on the newest line despite wrapped rows above it');

  // Sanity: the repro actually wrapped rows — otherwise this test silently stops covering the bug.
  const wrapped = await page.evaluate(() => {
    const screen = document.querySelector('.pscreen');
    const lh = parseFloat(getComputedStyle(screen).lineHeight);
    let n = 0;
    for (const row of screen.childNodes) if (row.getBoundingClientRect && row.getBoundingClientRect().height > lh * 1.5) n++;
    return n;
  });
  ok(wrapped > 10, `filler rows actually wrap at 2x zoom (${wrapped} wrapped rows)`);

  // 2) THE reported bug: scroll to the very bottom by hand, let a repaint happen — the viewport
  // must NOT be yanked up past the newest line.
  await page.evaluate(() => { const s = document.querySelector('.pscreen'); s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); });
  await sleep(400);
  await cmux(['send', '--surface', surface, '--', `echo after-${stamp}`]);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(4000);
  const v2 = await page.evaluate(markerVisible, `after-${stamp}`);
  ok(v2.found && v2.onScreen, 'after scrolling to the very bottom, the repaint does NOT yank the view up off the tail');

  // 3) Regression guard from p7: a reader who scrolls up KEEPS their position.
  await page.evaluate(() => { const s = document.querySelector('.pscreen'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); });
  await sleep(600);
  const top = await page.evaluate(() => document.querySelector('.pscreen').scrollTop);
  await cmux(['send', '--surface', surface, '--', 'echo scrollback-hold']);
  await cmux(['send-key', '--surface', surface, '--', 'enter']);
  await sleep(4000);
  const stillTop = await page.evaluate(() => document.querySelector('.pscreen').scrollTop);
  ok(stillTop <= top + 40, 'scrolling up still stops the auto-follow');

  await page.screenshot({ path: '/tmp/p10-tailwrap.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
