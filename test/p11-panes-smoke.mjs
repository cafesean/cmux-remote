// Playwright smoke for p11 — the three operator-reported defects, seen in a real browser.
//
//   1. A workspace with ONE pane must come up in the SPLIT view on a desktop (pane header, no pill
//      strip). It used to fall through to the phone layout, which is what every new workspace hit.
//   2. A workspace can be renamed from the workspace list, and the name reaches the bridge.
//   3. A pane paints the scrollback ABOVE cmux's 240-row replay window as history rows, in order,
//      joined to the live grid with nothing duplicated or missing.
//
// Runs against a STUB BRIDGE (canned tree/layout/grid/history), so it is deterministic and never
// touches the live desktop — the claims here are about the CLIENT. The same paths are exercised
// against the real cmux by hand; see the branch notes.
//
// Playwright is BORROWED, not depended on — this repo stays npm-install-free:
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p11-panes-smoke.mjs
import http from 'http';
import { spawn } from 'child_process';

async function loadPlaywright() {
  const tried = [];
  if (process.env.PLAYWRIGHT_DIR) {
    tried.push(process.env.PLAYWRIGHT_DIR);
    try { return await import(process.env.PLAYWRIGHT_DIR); } catch (_) { /* fall through */ }
  }
  tried.push('playwright (bare specifier)');
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  console.error('FAIL: could not load Playwright. Tried: ' + tried.join(', ') +
    '\n  PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p11-panes-smoke.mjs');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BRIDGE_PORT = 8897, SERVER_PORT = 8096, TOKEN = 'p11-smoke-token';
let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || extra === undefined ? '' : '  [' + extra + ']'));
  if (!ok) failed++;
};

// ---- the fixture: ONE workspace with ONE pane. That is the shape the defect lived in. ----
const SF = 'AAAAAAAA-0000-0000-0000-000000000001';
const PANE = 'PPPPPPPP-0000-0000-0000-00000000000A';
const WS = 'WWWWWWWW-0000-0000-0000-00000000000W';
let wsTitle = 'agent-ux';                       // the tab-derived name a new workspace gets
const tree = () => ({ workspaces: [{
  ref: 'workspace:1', id: WS, title: wsTitle, selected: true, window: 'win',
  tabs: [{ id: SF, ref: 'surface:1', title: 'agent-ux', type: 'terminal', selected: true,
    pane: PANE, paneRef: 'pane:1', inPane: true, status: '' }],
  panes: [{ ref: 'pane:1', id: PANE, index: 0, focused: true, selected: SF, tabs: [SF] }],
}] });
const layout = () => ({
  box: { w: 1600, h: 1000 }, focusedPane: 'pane:1', workspace: WS,
  panes: [{ ref: 'pane:1', id: PANE, index: 0, focused: true, cols: 80, rows: 40, selectedSurface: SF,
    selectedSurfaceRef: 'surface:1', surfaceRefs: ['surface:1'], surfaceIds: [SF],
    x: 0, y: 0, w: 1, h: 1, pxw: 1600, pxh: 1000 }],
  handles: [], h: 'layout-1',
});
// The live grid: cmux's replay window. 240 scrollback + 40 viewport is what it can carry at most.
const STYLED_ROWS = 40;
const gridFor = (sid) => {
  const spans = [];
  for (let r = 0; r < STYLED_ROWS; r++) spans.push({ row: r, column: 0, style_id: 0, text: 'live ' + (r + 1) });
  return { surface: sid, seq: 1, grid: { columns: 40, rows: STYLED_ROWS, styles: [{ id: 0 }], spans, cursor: null },
    h: 'grid-' + sid };
};
// And the rows ABOVE it — what /cmux/history exists to deliver.
const HIST_ROWS = 1200;
const history = () => {
  const rows = [];
  for (let i = 1; i <= HIST_ROWS; i++) rows.push('hist ' + i);
  return { rows, aligned: true, styledRows: STYLED_ROWS, bufferRows: HIST_ROWS + STYLED_ROWS };
};

const seen = { history: [], rename: [] };
const bridge = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (u.pathname === '/cmux/tree') return json(tree());
  if (u.pathname === '/cmux/layout') return json(layout());
  if (u.pathname === '/cmux/layout-stream') {
    sse();
    res.write('data: ' + JSON.stringify(layout()) + '\n\n');
    const hb = setInterval(() => res.write(': hb\n\n'), 5000);
    req.on('close', () => clearInterval(hb));
    return;
  }
  if (u.pathname === '/cmux/history') {
    seen.history.push({ surface: u.searchParams.get('surface'), rows: u.searchParams.get('rows') });
    return json(history());
  }
  if (u.pathname === '/cmux/panes-stream') {
    sse();
    for (const s of (u.searchParams.get('surfaces') || '').split(',').filter(Boolean)) {
      res.write('data: ' + JSON.stringify(gridFor(s)) + '\n\n');
    }
    const hb = setInterval(() => res.write(': hb\n\n'), 5000);
    req.on('close', () => clearInterval(hb));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(body || '{}'); } catch (_) {}
    if (u.pathname === '/cmux/rename-workspace') {
      seen.rename.push(b);
      wsTitle = b.title || 'agent-ux';                  // empty title = back to the tab-derived name
      return json({ ok: true, workspace: b.workspace, title: b.title, workspaces: tree().workspaces });
    }
    if (u.pathname === '/cmux/focus-surface' || u.pathname === '/cmux/focus-pane') return json({ ok: true });
    json({ error: 'not_found' });
  });
});
await new Promise((r) => bridge.listen(BRIDGE_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1', SERVER_TOKEN: TOKEN,
    CMUX_MACHINE_URL: `http://127.0.0.1:${BRIDGE_PORT}`, CMUX_MACHINE_SECRET: 'stub',
    CMUX_MACHINE_LABEL: 'stub-mac', CMUX_MACHINES: '', CMUX_CONFIG: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('pageerror', (e) => { console.log('FAIL — page error: ' + e.message); failed++; });
const base = `http://127.0.0.1:${SERVER_PORT}`;

try {
  await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });   // never networkidle: it polls forever
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1500);

  // --- 1. one pane, wide viewport: the SPLIT view, not the phone layout ---
  check('a single-pane workspace paints one pane', await page.locator('.pane').count() === 1);
  check('and it is NOT the solo blow-up', await page.locator('.pane.solo').count() === 0,
    'solo=' + await page.locator('.pane.solo').count());
  check('body.solo is off, so the pill strip stays hidden',
    !(await page.evaluate(() => document.body.classList.contains('solo'))));
  check('the pill strip is hidden', !(await page.locator('#tabs').isVisible()));
  check('the pane header IS visible (it is the switcher in split view)',
    await page.locator('.pane .phead').first().isVisible());
  check('the pane header carries its own ⊞ and ×',
    await page.locator('.pane .phead .pact').count() === 2,
    'acts=' + await page.locator('.pane .phead .pact').count());
  check('no dividers with one pane', await page.locator('.phandle').count() === 0);

  // --- 3. history is painted above the live grid, in order ---
  check('the pane asked for its deep scrollback on attach', seen.history.length >= 1,
    'calls=' + seen.history.length);
  check('and asked for 2000 rows', seen.history[0] && seen.history[0].rows === '2000',
    seen.history[0] && seen.history[0].rows);
  const histCount = await page.locator('.pane .trow.hist').count();
  check('the history rows are in the DOM', histCount === HIST_ROWS, 'hist rows=' + histCount);
  const firstRow = (await page.locator('.pane .trow').first().innerText()).trim();
  const rowTexts = await page.locator('.pane .trow').allInnerTexts();
  check('history comes FIRST — scrolling up leaves the live grid and enters the past',
    firstRow === 'hist 1', firstRow);
  check('the join is seamless: the last history row is followed by the first live row',
    rowTexts[HIST_ROWS - 1].trim() === 'hist ' + HIST_ROWS && rowTexts[HIST_ROWS].trim() === 'live 1',
    rowTexts[HIST_ROWS - 1] + ' → ' + rowTexts[HIST_ROWS]);
  check('the live grid is all there after it',
    rowTexts[HIST_ROWS + STYLED_ROWS - 1].trim() === 'live ' + STYLED_ROWS,
    rowTexts[HIST_ROWS + STYLED_ROWS - 1]);
  check('no blank padding under the prompt once history fills the scroll',
    rowTexts.length === HIST_ROWS + STYLED_ROWS, 'rows=' + rowTexts.length);
  // A terminal opens at its tail, and 1200 rows of history must not park the reader at the top.
  const scrolled = await page.evaluate(() => {
    const el = document.querySelector('.pane .pscreen');
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  check('the pane still opens at the tail, not at the top of the history',
    scrolled.top > scrolled.max * 0.8, 'scrollTop=' + scrolled.top + ' of ' + scrolled.max);

  // --- 2. rename, from the workspace list ---
  check('the header shows the tab-derived name to begin with',
    (await page.locator('#wsLabel').innerText()).trim() === 'agent-ux');
  await page.locator('#wsChip').click();
  await page.waitForTimeout(200);
  check('every workspace row offers a rename', await page.locator('#wsMenu .wsedit').count() === 1);
  await page.evaluate(() => { window.prompt = () => 'billing-rework'; });
  await page.locator('#wsMenu .wsedit').first().click();
  await page.waitForTimeout(600);
  check('the rename reached the bridge', seen.rename.length === 1, 'calls=' + seen.rename.length);
  check('addressed by workspace UUID (refs do not resolve from a detached bridge)',
    seen.rename[0] && seen.rename[0].workspace === WS, seen.rename[0] && seen.rename[0].workspace);
  check('with the typed title', seen.rename[0] && seen.rename[0].title === 'billing-rework',
    seen.rename[0] && seen.rename[0].title);
  check('and the header shows it', (await page.locator('#wsLabel').innerText()).trim() === 'billing-rework',
    await page.locator('#wsLabel').innerText());

  // Cancelling the box must not rename anything — an Esc is not "clear the name".
  await page.locator('#wsChip').click();
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.prompt = () => null; });
  await page.locator('#wsMenu .wsedit').first().click();
  await page.waitForTimeout(400);
  check('cancelling the rename box sends nothing', seen.rename.length === 1, 'calls=' + seen.rename.length);

  // An EMPTIED box clears the custom name — the only way to undo a rename.
  await page.locator('#wsChip').click();
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.prompt = () => '   '; });
  await page.locator('#wsMenu .wsedit').first().click();
  await page.waitForTimeout(600);
  check('an emptied box clears the name', seen.rename.length === 2 && seen.rename[1].title === '',
    seen.rename.length + ' / ' + JSON.stringify(seen.rename[1] && seen.rename[1].title));

  // --- the phone path is untouched: pills come back, one pane at a time ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  check('a phone viewport goes back to the pill strip', await page.locator('#tabs').isVisible());
  check('and the pane is the solo blow-up again', await page.locator('.pane.solo').count() === 1,
    'solo=' + await page.locator('.pane.solo').count());
  check('the strip still offers new tabs on a phone',
    await page.locator('#tabs .tab.add').count() === 2);
  check('history survives the viewport change', await page.locator('.pane .trow.hist').count() === HIST_ROWS);
} catch (e) {
  check('smoke run completed', false, e && e.message);
} finally {
  await browser.close();
  server.kill();
  bridge.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
