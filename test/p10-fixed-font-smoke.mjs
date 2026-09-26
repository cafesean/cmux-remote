// Fixed font size: desktop panes differ in column count (their own ⌘+/−, split widths), so the
// fit-width mirror opened every workspace at a different text size and the phone reader re-zoomed on
// each switch. Settings → Font → "Fixed size" pins one size (13px × zoom) everywhere.
//
// Covers: in Fixed mode two workspaces whose source grids have DIFFERENT `columns` render the same
// computed font-size; Fit mode still follows the width formula; the mode survives a reload; A+ still
// scales the fixed size; and tail-follow still lands on the newest line with wrapped rows.
//
// Two scratch workspaces: A is one full-width pane, B is split three ways so its panes carry far fewer
// columns. Keys only ever go to A's scratch surface. Both are closed on every exit path.

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
const cmux = async (a) => (await exec(CMUX, a, { maxBuffer: 32 << 20, env: { ...process.env, CMUX_QUIET: '1' } })).stdout;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const scratch = [];
const cleanup = async () => {
  while (scratch.length) { const id = scratch.pop(); try { await cmux(['close-workspace', '--workspace', id]); } catch (_) {} }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });

const listWs = async () => JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']))
  .windows.flatMap((w) => w.workspaces);

async function makeWs(name) {
  const before = new Set((await listWs()).map((w) => w.id));
  await cmux(['new-workspace', '--name', name, '--cwd', '/tmp', '--focus', 'false']);
  await sleep(2000);
  const ws = (await listWs()).find((w) => !before.has(w.id));
  if (!ws) throw new Error(`scratch workspace ${name} did not appear`);
  scratch.push(ws.id);
  return ws;
}

const columnsOf = async (surface) => {
  const r = await fetch(`${BASE}/api/cmux/grid?surface=${encodeURIComponent(surface)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  return (j.grid && j.grid.columns) || j.columns || 0;
};

// The focused pane's computed font-size, and what fit-width WOULD give it for `cols` source columns
// (the same formula as fitFont: floor the baseline, then zoom).
const paneFont = (cols) => {
  const screen = document.querySelector('.pane.focus .pscreen') || document.querySelector('.pscreen');
  if (!screen) return null;
  const cs = getComputedStyle(screen);
  const s = document.createElement('span');
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:100px;';
  s.textContent = '0'.repeat(100);
  document.body.appendChild(s);
  const ratio = s.getBoundingClientRect().width / 100 / 100; s.remove();
  const avail = screen.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let zoom = 1; try { zoom = parseFloat(localStorage.getItem('cmux_fontzoom')) || 1; } catch (_) {}
  const base = Math.max(7, Math.min(avail / (cols * ratio), 48));
  return { fs: parseFloat(cs.fontSize), fit: Math.max(7, Math.min(base * zoom, 72)) };
};

// Jump via the p17 sidebar: open it from the workspace chip, click the row carrying the title.
async function switchTo(page, title) {
  await page.click('#wsChip');
  const row = page.locator('#side .siderow.ws', { hasText: title }).first();
  try { await row.waitFor({ state: 'visible', timeout: 15000 }); } catch (_) { await page.click('#wsChip'); return false; }
  await row.click();
  await sleep(3000);
  return (await page.textContent('#wsLabel') || '').includes(title);
}

async function setMode(page, want) {
  await page.click('#settingsBtn');
  await page.waitForSelector('#setMenu:not([hidden])', { timeout: 5000 });
  if ((await page.textContent('#fontMode')).trim() !== want) await page.click('#fontMode');
  const label = (await page.textContent('#fontMode')).trim();
  await page.click('#settingsBtn');
  await sleep(300);
  return label;
}

async function main() {
  const tag = Date.now().toString(36);
  const nameA = `scratch-font-a-${tag}`, nameB = `scratch-font-b-${tag}`;
  const wsA = await makeWs(nameA);
  const wsB = await makeWs(nameB);
  // Split B's pane twice so its terminals carry far fewer columns than A's full-width one.
  await cmux(['new-split', 'right', '--workspace', wsB.id, '--focus', 'false']);
  await sleep(800);
  await cmux(['new-split', 'right', '--workspace', wsB.id, '--focus', 'false']);
  await sleep(1500);
  // A never-shown background workspace has no terminal size yet (grid columns 0). Show each scratch
  // workspace on the desktop for a moment so cmux lays it out, then hand the original selection back.
  const selected = (await listWs()).find((w) => w.selected);
  for (const id of [wsA.id, wsB.id]) { await cmux(['select-workspace', '--workspace', id]); await sleep(1500); }
  if (selected) await cmux(['select-workspace', '--workspace', selected.id]);
  await sleep(1000);
  const surfA = wsA.panes[0].surfaces[0].id;
  const treeB = (await listWs()).find((w) => w.id === wsB.id);
  const colsA = await columnsOf(surfA);
  const colsB = await Promise.all(treeB.panes.map((p) => columnsOf(p.surfaces[0].id)));
  console.log(`  columns: A=${colsA} B=[${colsB.join(', ')}]`);
  ok(colsA > 1 && colsB.every((c) => c > 1 && c !== colsA), 'precondition: the two workspaces\' source grids differ in columns');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  FAIL page error: ${e.message}`); });
  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });
  // Start from a clean slate: default mode, 100% zoom.
  await page.evaluate(() => { try { localStorage.removeItem('cmux_fontmode'); localStorage.removeItem('cmux_fontzoom'); } catch (_) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });

  // 1) Fit width is the default and still follows the width formula per workspace.
  await page.click('#settingsBtn');
  await page.waitForSelector('#setMenu:not([hidden])', { timeout: 5000 });
  ok((await page.textContent('#fontMode')).trim() === 'Fit width', 'Fit width is the default mode');
  await page.click('#settingsBtn');
  ok(await switchTo(page, nameA), 'switched to scratch A');
  const fitA = await page.evaluate(paneFont, colsA);
  ok(fitA && Math.abs(fitA.fs - fitA.fit) < 0.1, `fit mode A: font ${fitA && fitA.fs}px = width formula ${fitA && fitA.fit.toFixed(2)}px`);
  ok(await switchTo(page, nameB), 'switched to scratch B');
  const fitB = await page.evaluate(paneFont, Math.min(...colsB));
  const fitBAny = await Promise.all(colsB.map((c) => page.evaluate(paneFont, c)));
  ok(fitBAny.some((f) => f && Math.abs(f.fs - f.fit) < 0.1), `fit mode B: font ${fitB && fitB.fs}px matches the width formula for its pane's columns`);

  // 2) Fixed size: the same font in both workspaces, whatever their columns.
  ok(await setMode(page, 'Fixed size') === 'Fixed size', 'toggle switches to Fixed size');
  const fixB = await page.evaluate(paneFont, colsA);
  ok(await switchTo(page, nameA), 'switched back to scratch A');
  const fixA = await page.evaluate(paneFont, colsA);
  ok(fixA && fixB && fixA.fs === fixB.fs, `fixed mode: A ${fixA && fixA.fs}px === B ${fixB && fixB.fs}px despite ${colsA} vs [${colsB.join(', ')}] columns`);
  ok(fixA && Math.abs(fixA.fs - 13) < 0.05, 'fixed mode at 100% zoom renders 13px');
  const stored = await page.evaluate(() => { try { return localStorage.getItem('cmux_fontmode'); } catch (_) { return null; } });
  ok(stored === 'fixed', 'mode persisted to localStorage cmux_fontmode');

  // 3) A+ still scales the fixed size.
  await page.click('#settingsBtn');
  await page.waitForSelector('#setMenu:not([hidden])', { timeout: 5000 });
  await page.click('#fontUp');
  await page.click('#settingsBtn');
  await sleep(300);
  const up = await page.evaluate(paneFont, colsA);
  ok(up && Math.abs(up.fs - 13 * 1.15) < 0.05, `A+ in fixed mode → ${up && up.fs}px (13 × 1.15)`);

  // 4) The mode survives a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 20000 });
  await sleep(2000);
  await switchTo(page, nameB);
  const afterB = await page.evaluate(paneFont, colsA);
  await page.click('#settingsBtn');
  await page.waitForSelector('#setMenu:not([hidden])', { timeout: 5000 });
  ok((await page.textContent('#fontMode')).trim() === 'Fixed size', 'Fixed size survives a reload (settings label)');
  await page.click('#settingsBtn');
  ok(afterB && Math.abs(afterB.fs - 13 * 1.15) < 0.05, `after reload scratch B renders the fixed ${afterB && afterB.fs}px`);

  // 5) Tail follow in fixed mode: long lines wrap at 13px on a phone; the newest line must be on screen.
  await switchTo(page, nameA);
  const stamp = 'FIXTAIL_' + tag;
  await cmux(['send', '--surface', surfA, '--', 'for i in $(seq 1 60); do printf "line %03d "; printf "%0.sx" $(seq 1 150); echo; done']);
  await cmux(['send-key', '--surface', surfA, '--', 'enter']);
  await sleep(3500);
  await cmux(['send', '--surface', surfA, '--', `echo ${stamp}`]);
  await cmux(['send-key', '--surface', surfA, '--', 'enter']);
  await sleep(4000);
  const tail = await page.evaluate((mark) => {
    const screen = document.querySelector('.pane.focus .pscreen') || document.querySelector('.pscreen');
    if (!screen) return { found: false };
    const box = screen.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(screen).lineHeight);
    let wrapped = 0, hit = null;
    for (const row of screen.childNodes) {
      if (!row.getBoundingClientRect) continue;
      const r = row.getBoundingClientRect();
      if (r.height > lh * 1.5) wrapped++;
      // the LAST row carrying the stamp is the echo output (the first is the typed command)
      if (row.textContent && row.textContent.includes(mark)) hit = r;
    }
    return { found: !!hit, onScreen: !!hit && hit.top >= box.top - 2 && hit.bottom <= box.bottom + 2, wrapped };
  }, stamp);
  ok(tail.wrapped > 10, `fixed mode wraps long rows (${tail.wrapped} wrapped rows)`);
  ok(tail.found && tail.onScreen, 'fixed mode: auto-follow lands on the newest line despite wrapped rows');

  // 6) Switching back to Fit width restores the width formula.
  ok(await setMode(page, 'Fit width') === 'Fit width', 'toggle switches back to Fit width');
  const back = await page.evaluate(paneFont, colsA);
  ok(back && Math.abs(back.fs - back.fit) < 0.1, `fit mode restored: ${back && back.fs}px = formula ${back && back.fit.toFixed(2)}px`);

  await page.screenshot({ path: '/tmp/p10-fixed-font.png' });
  await browser.close();
}

main()
  .then(async () => { await cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { await cleanup(); console.error('ERROR:', e.message); process.exit(1); });
