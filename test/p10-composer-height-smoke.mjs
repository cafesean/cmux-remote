// Composer height across the compose⇄live round-trip. autogrow() skips live mode and the live
// keystroke path empties the field, so before the fix nothing ever shrank the box: a multi-line
// compose draft left a giant EMPTY "Type…" field after any trip through ⚡ live — most visible on
// narrow phones, where drafts wrap (and grow the box) after just a few words.

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

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 320, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });
  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  // Switch to the scratch workspace so every keystroke below lands in a throwaway terminal.
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

  const box = () => page.evaluate(() => {
    const t = document.querySelector('#text');
    return { h: Math.round(t.getBoundingClientRect().height), val: t.value };
  });

  const base = (await box()).h;
  ok(base < 60, `empty compose field is one row (${base}px)`);

  // A wrapping draft grows the box.
  await page.evaluate(() => { const t = document.querySelector('#text');
    t.value = 'a compose draft long enough to wrap on a narrow phone\nsecond line\nthird line\nfourth line';
    t.dispatchEvent(new Event('input', { bubbles: true })); });
  const grown = (await box()).h;
  ok(grown > base + 30, `multi-line draft grows the field (${grown}px)`);

  // Round-trip WITHOUT typing: the kept draft must come back at its grown height.
  await page.click('#liveToggle'); await sleep(150);
  await page.click('#liveToggle'); await sleep(150);
  const kept = await box();
  ok(kept.val.includes('fourth line') && kept.h > base + 30, `untouched draft survives the ⚡ round-trip at height (${kept.h}px)`);

  // Live keystroke empties the field — the height must fall with the text.
  await page.click('#liveToggle'); await sleep(150);
  await page.focus('#text');
  await page.keyboard.type('x');
  await sleep(300);
  const live = await box();
  ok(live.val === '' && live.h < 60, `live keystroke leaves a one-row empty field (${live.h}px)`);

  // And back in compose it stays one row — the reported giant empty "Type…" box.
  await page.click('#liveToggle'); await sleep(150);
  const back = await box();
  ok(back.val === '' && back.h < 60, `back in compose the empty field is one row (${back.h}px)`);

  await page.screenshot({ path: '/tmp/p10-composer-height.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
