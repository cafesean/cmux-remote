// Playwright smoke for the multi-pane mirror.
//
// Runs against a STUB BRIDGE (canned tree/layout/grids) rather than the real cmux, so it is
// deterministic and never touches a live desktop: the assertions are about the client's behaviour —
// two panes painted from the layout fractions, a divider you can drag, focus following a tap, the
// narrow-viewport collapse, and a layout pushed from the "Mac" landing in the UI.
//
// Playwright is BORROWED, not depended on — this repo stays npm-install-free:
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/multipane-smoke.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
    '\n  PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/multipane-smoke.mjs');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BRIDGE_PORT = 8899, SERVER_PORT = 8098, TOKEN = 'smoke-token';
let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || extra === undefined ? '' : '  [' + extra + ']'));
  if (!ok) failed++;
};

// ---- the fixture: one workspace, two panes side by side; the left pane holds two tabs ----
const SF = { a: 'AAAAAAAA-0000-0000-0000-000000000001', b: 'BBBBBBBB-0000-0000-0000-000000000002',
  a2: 'CCCCCCCC-0000-0000-0000-000000000003' };
const PANE = { a: 'PPPPPPPP-0000-0000-0000-00000000000A', b: 'PPPPPPPP-0000-0000-0000-00000000000B' };
const WS = 'WWWWWWWW-0000-0000-0000-00000000000W';
// Mutable per-surface status, so the smoke can drive a tab through Running → idle the way cmux does
// and watch `done` appear. /stub/set-status is the only writer.
const STATUS = { [SF.a]: 'Running', [SF.a2]: 'Needs input', [SF.b]: '' };
const tree = () => ({ workspaces: [{
  ref: 'workspace:1', id: WS, title: 'SMOKE', selected: true, window: 'win',
  tabs: [
    { id: SF.a, ref: 'surface:1', title: 'left-agent', type: 'terminal', selected: true, pane: PANE.a, paneRef: 'pane:1', inPane: true, status: STATUS[SF.a] },
    { id: SF.a2, ref: 'surface:3', title: 'left-second', type: 'terminal', selected: false, pane: PANE.a, paneRef: 'pane:1', inPane: false, status: STATUS[SF.a2] },
    { id: SF.b, ref: 'surface:2', title: 'right-agent', type: 'terminal', selected: false, pane: PANE.b, paneRef: 'pane:2', inPane: true, status: STATUS[SF.b] },
  ],
  panes: [
    { ref: 'pane:1', id: PANE.a, index: 0, focused: true, selected: SF.a, tabs: [SF.a, SF.a2] },
    { ref: 'pane:2', id: PANE.b, index: 1, focused: false, selected: SF.b, tabs: [SF.b] },
  ],
}] });
let dividerAt = 0.6;
const layout = () => ({
  box: { w: 1600, h: 1000 },
  focusedPane: 'pane:1',
  workspace: WS,
  panes: [
    { ref: 'pane:1', id: PANE.a, index: 0, focused: true, cols: 80, rows: 50, selectedSurface: SF.a,
      selectedSurfaceRef: 'surface:1', surfaceRefs: ['surface:1'], surfaceIds: [SF.a],
      x: 0, y: 0, w: dividerAt, h: 1, pxw: Math.round(1600 * dividerAt), pxh: 1000 },
    { ref: 'pane:2', id: PANE.b, index: 1, focused: false, cols: 60, rows: 50, selectedSurface: SF.b,
      selectedSurfaceRef: 'surface:2', surfaceRefs: ['surface:2'], surfaceIds: [SF.b],
      x: dividerAt, y: 0, w: 1 - dividerAt, h: 1, pxw: Math.round(1600 * (1 - dividerAt)), pxh: 1000 },
  ],
  handles: [{ axis: 'x', pos: dividerAt, start: 0, end: 1, a: ['pane:1'], b: ['pane:2'] }],
  h: 'layout-' + dividerAt,
});
// The fixture grid is TALL (a desktop terminal is much taller than a mirrored pane), so the pane has
// somewhere to scroll — which is what makes "a new pane opens at the top" testable at all.
const GRID_ROWS = 60;
const gridFor = (sid) => {
  const text = sid === SF.a ? 'LEFT PANE OUTPUT' : sid === SF.b ? 'RIGHT PANE OUTPUT' : 'SECOND TAB OUTPUT';
  const spans = [{ row: 0, column: 0, style_id: 0, text }];
  for (let r = 1; r < GRID_ROWS - 1; r++) spans.push({ row: r, column: 0, style_id: 0, text: 'line ' + r });
  spans.push({ row: GRID_ROWS - 1, column: 0, style_id: 0, text: 'TAIL OF ' + text });
  return { surface: sid, seq: 1, grid: { columns: 40, rows: GRID_ROWS, styles: [{ id: 0 }],
    spans, cursor: null }, h: 'grid-' + sid };
};

const seen = { resize: [], focusSurface: [], focusPane: [], key: [], drop: [], split: [], closePane: [], upload: [] };
const layoutClients = new Set();   // open layout-stream responses, so the stub can push like cmux does
const bridge = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (u.pathname === '/cmux/tree') return json(tree());
  if (u.pathname === '/cmux/layout') return json(layout());
  if (u.pathname === '/cmux/layout-stream') {
    sse();
    res.write('data: ' + JSON.stringify(layout()) + '\n\n');
    layoutClients.add(res);
    req.on('close', () => layoutClients.delete(res));
    return;
  }
  // test-only: pretend a session on the Mac started or finished, so the next /cmux/tree read (and so
  // the next fleet beat) carries the new status. Same precedent as /stub/push-layout below.
  if (u.pathname === '/stub/set-status') {
    const s = u.searchParams.get('surface');
    if (s && Object.prototype.hasOwnProperty.call(STATUS, s)) STATUS[s] = u.searchParams.get('status') || '';
    return json({ ok: true, status: STATUS });
  }
  // test-only: pretend the divider was dragged ON THE MAC and push the new layout down the stream
  if (u.pathname === '/stub/push-layout') {
    dividerAt = Number(u.searchParams.get('target') || 0.3);
    for (const c of layoutClients) c.write('data: ' + JSON.stringify(layout()) + '\n\n');
    return json({ ok: true, pushed: layoutClients.size });
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
    if (u.pathname === '/cmux/resize-pane') {
      seen.resize.push(b);
      dividerAt = Math.round(b.target * 1000) / 1000;
      return json({ ok: true, layout: layout() });
    }
    if (u.pathname === '/cmux/drop-surface') { seen.drop.push(b); return json({ ok: true, layout: layout() }); }
    if (u.pathname === '/cmux/new-pane') { seen.split.push(b); return json({ ok: true, layout: layout() }); }
    if (u.pathname === '/cmux/close-pane') { seen.closePane.push(b); return json({ ok: true, layout: layout() }); }
    if (u.pathname === '/cmux/upload') {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      seen.upload.push({ name, bytes: body.length });
      // the real bridge refuses a 0-byte body (bridge.js cmuxUpload) — mirror it, or the batch tests lie
      if (!body.length) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'empty' })); }
      return json({ ok: true, path: '/Users/stub/Downloads/cmux-remote/2026-07-31/' + name, name, bytes: body.length });
    }
    if (u.pathname === '/cmux/focus-surface') { seen.focusSurface.push(b); return json({ ok: true }); }
    if (u.pathname === '/cmux/focus-pane') { seen.focusPane.push(b); return json({ ok: true }); }
    if (u.pathname === '/cmux/key') { seen.key.push(b); return json({ ok: true }); }
    if (u.pathname === '/cmux/send') { return json({ ok: true }); }
    json({ error: 'not_found' });
  });
});
await new Promise((r) => bridge.listen(BRIDGE_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(SERVER_PORT), HOST: '127.0.0.1', SERVER_TOKEN: TOKEN,
    CMUX_MACHINE_URL: `http://127.0.0.1:${BRIDGE_PORT}`, CMUX_MACHINE_SECRET: 'stub',
    CMUX_MACHINE_LABEL: 'stub-mac', CMUX_CONFIG: '',
    // Three machines. `second` is REACHABLE — the same stub bridge answers for it, so it serves the
    // same tree, which is what makes switching machines (and coming back to the remembered one after
    // a reload) testable. `unplugged` has nothing listening on port 1, so every call to it is refused
    // at once; it is the unreachable row, and it is not switchable from the panel by design.
    CMUX_MACHINES: JSON.stringify([
      { id: 'second', label: 'Second Mac', baseUrl: `http://127.0.0.1:${BRIDGE_PORT}`, secret: 'stub' },
      { id: 'unplugged', label: 'Unplugged Mac', baseUrl: 'http://127.0.0.1:1', secret: 'x' },
    ]) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
// Console errors/warnings are REPORTED but not fatal. p17 shipped the sidebar dark because
// /sidebar.js 404'd and app.js's defensive mount swallowed it — the only trace anywhere was a
// console error nothing was listening for. A 404 on a module is not a page error, so pageerror
// below never sees it.
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console] ' + m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => { console.log('FAIL — page error: ' + e.message); failed++; });
const base = `http://127.0.0.1:${SERVER_PORT}`;

try {
  await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1200);

  // --- both panes are mirrored at once, each with ITS OWN surface ---
  const panes = await page.locator('.pane').count();
  check('wide viewport shows both panes', panes === 2, 'panes=' + panes);
  const leftText = await page.locator('.pane').nth(0).innerText();
  const rightText = await page.locator('.pane').nth(1).innerText();
  check('left pane mirrors its own surface', leftText.includes('LEFT PANE OUTPUT'), JSON.stringify(leftText.slice(0, 60)));
  check('right pane mirrors its own surface', rightText.includes('RIGHT PANE OUTPUT'), JSON.stringify(rightText.slice(0, 60)));

  // --- a pane opens at the TOP of its grid, not at the tail ---
  // A mirrored pane is much shorter than the source terminal, so opening at the bottom shows trailing
  // blanks and hides the prompt. The pin must also survive the repaints that follow the first frame.
  const topState = await page.locator('.pane').nth(0).locator('.pscreen')
    .evaluate((e) => ({ top: e.scrollTop, scrollable: e.scrollHeight > e.clientHeight + 4 }));
  check('the pane grid is long enough to scroll (fixture sanity)', topState.scrollable,
    JSON.stringify(topState));
  check('a pane opens scrolled to the top', topState.top === 0, 'scrollTop=' + topState.top);
  check('the first line of the grid is what you see', (await page.locator('.pane').nth(0)
    .locator('.pscreen .trow').first().innerText()).includes('LEFT PANE OUTPUT'));
  // scrolling away releases the pin — from then on it is an ordinary terminal again
  await page.locator('.pane').nth(0).locator('.pscreen').evaluate((e) => { e.scrollTop = 200; });
  await page.waitForTimeout(300);
  const afterScroll = await page.locator('.pane').nth(0).locator('.pscreen').evaluate((e) => e.scrollTop);
  check('scrolling off the top is not yanked back', afterScroll > 0, 'scrollTop=' + afterScroll);

  // --- geometry comes from the layout fractions (0.6 / 0.4 of the box) ---
  const boxes = await page.locator('.pane').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  const ratio = boxes[0] / (boxes[0] + boxes[1]);
  check('pane widths follow the layout fractions', Math.abs(ratio - 0.6) < 0.03, 'ratio=' + ratio.toFixed(3));

  // --- the pane with several tabs offers them in its header ---
  const chips = await page.locator('.pane').nth(0).locator('.pchip').count();
  check('a multi-tab pane shows its tabs in the pane header', chips === 2, 'chips=' + chips);

  // --- tapping a background pane moves focus there, and fires NO keys at it ---
  const keysBefore = seen.key.length;
  await page.locator('.pane').nth(1).locator('.pscreen').click({ position: { x: 40, y: 30 } });
  await page.waitForTimeout(400);
  const focusIsRight = await page.locator('.pane').nth(1).evaluate((e) => e.classList.contains('focus'));
  check('tapping a background pane focuses it', focusIsRight);
  check('tapping a background pane sends no keys to it', seen.key.length === keysBefore);
  check('focusing a pane tells cmux too', seen.focusSurface.some((f) => f.surface === SF.b),
    JSON.stringify(seen.focusSurface));

  // --- drag the divider: one resize request, with the dragged position ---
  const handle = page.locator('.phandle.x').first();
  check('a divider handle is rendered', await handle.count() === 1);
  const hb = await handle.boundingBox();
  const wrap = await page.locator('#panes').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(wrap.x + wrap.width * 0.4, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  check('dragging a divider issues exactly one resize', seen.resize.length === 1, 'n=' + seen.resize.length);
  const rq = seen.resize[0] || {};
  check('the resize targets the dragged position', Math.abs((rq.target || 0) - 0.4) < 0.03, 'target=' + rq.target);
  check('the resize names both panes of the divider', rq.paneA === PANE.a && rq.paneB === PANE.b,
    rq.paneA + '/' + rq.paneB);
  check('the resize carries the axis', rq.axis === 'x', rq.axis);
  const after = await page.locator('.pane').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  const ratio2 = after[0] / (after[0] + after[1]);
  check('the mirror repaints at the new split', Math.abs(ratio2 - 0.4) < 0.04, 'ratio=' + ratio2.toFixed(3));

  // --- a layout pushed from the "Mac" lands without any interaction here ---
  await fetch(`http://127.0.0.1:${BRIDGE_PORT}/stub/push-layout?target=0.3`);
  await page.waitForFunction(() => {
    const p = document.querySelectorAll('.pane');
    if (p.length !== 2) return false;
    const a = p[0].getBoundingClientRect().width, b = p[1].getBoundingClientRect().width;
    return Math.abs(a / (a + b) - 0.3) < 0.04;
  }, null, { timeout: 6000 }).then(() => check('a split moved ON THE MAC follows to the mirror', true))
    .catch(() => check('a split moved ON THE MAC follows to the mirror', false));

  // --- drag a pane by its header to rearrange it -----------------------------------------------
  // The arrangement is a drag, not a menu: the header band is the grip, the drop position decides
  // whether the pane lands BESIDE the target (an edge) or INSIDE it as a tab (the middle).
  const dragHeadTo = async (fromIdx, toIdx, fx, fy) => {
    const head = await page.locator('.pane').nth(fromIdx).locator('.phead').boundingBox();
    const target = await page.locator('.pane').nth(toIdx).boundingBox();
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    // ONE jump straight out of the header band (no interpolation): this is what a real mouse does,
    // and it is the case that fails if the drag listeners live on the header element instead of on
    // window — the first move lands on the terminal and the drag never arms.
    await page.mouse.move(head.x + head.width / 2 + 40, head.y + head.height + 90);
    await page.mouse.move(target.x + target.width * fx, target.y + target.height * fy, { steps: 6 });
    return target;
  };

  // hovering the RIGHT pane's left edge previews a drop beside it, and says so
  await dragHeadTo(0, 1, 0.08, 0.5);
  await page.waitForTimeout(120);
  const zoneShown = await page.locator('#dropZone').isVisible();
  const zoneLabel = await page.locator('#dropZone .dzlabel').innerText().catch(() => '');
  const ghostShown = await page.locator('#dragGhost').isVisible();
  check('dragging a pane header shows a drop zone', zoneShown);
  check('an edge drop reads as "move here"', /move here/i.test(zoneLabel), JSON.stringify(zoneLabel));
  check('the dragged pane follows the pointer as a ghost', ghostShown);
  const dropsBefore = seen.drop.length;
  await page.mouse.up();
  await page.waitForTimeout(500);
  check('dropping on an edge issues exactly one move', seen.drop.length === dropsBefore + 1,
    'n=' + (seen.drop.length - dropsBefore));
  const dq = seen.drop[seen.drop.length - 1] || {};
  check('the move carries the dragged surface and the target pane',
    dq.surface === SF.a && dq.pane === PANE.b, dq.surface + ' -> ' + dq.pane);
  check('the edge is the side the finger was on', dq.edge === 'left', dq.edge);
  check('the drop zone is gone after the drop', !(await page.locator('#dropZone').isVisible()));

  // the MIDDLE of a pane is the join-as-a-tab drop
  await dragHeadTo(0, 1, 0.5, 0.5);
  await page.waitForTimeout(120);
  const centerLabel = await page.locator('#dropZone .dzlabel').innerText().catch(() => '');
  check('a middle drop reads as "join as a tab"', /join as a tab/i.test(centerLabel), JSON.stringify(centerLabel));
  await page.mouse.up();
  await page.waitForTimeout(500);
  check('dropping on the middle moves the tab into that pane',
    (seen.drop[seen.drop.length - 1] || {}).edge === 'center', (seen.drop[seen.drop.length - 1] || {}).edge);

  // dropping a single-tab pane back onto ITSELF is a no-op, not an error round trip
  const dropsBeforeSelf = seen.drop.length;
  await dragHeadTo(1, 1, 0.5, 0.5);
  await page.waitForTimeout(120);
  const selfZone = await page.locator('#dropZone').isVisible();
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('a pane dropped on itself shows no drop zone', !selfZone);
  check('a pane dropped on itself issues no move', seen.drop.length === dropsBeforeSelf,
    'n=' + (seen.drop.length - dropsBeforeSelf));

  // --- the chrome now lives on the panes, cmux-style ---
  check('no global split button in the toolbar', await page.locator('#splitBtn').count() === 0);
  check('no global new-tab buttons in the toolbar',
    await page.locator('#newTab, #newBrowser').count() === 0);
  check('the Files toggle moved to the toolbar', await page.locator('header #filesBtn').count() === 1);
  check('the tab strip is hidden in split view', !(await page.locator('#tabs').isVisible()));
  check('every pane header carries its own ⊞ and ×',
    await page.locator('.pane .phead .pact').count() === 4, 'n=' + await page.locator('.pane .phead .pact').count());

  // the pane ⊞ menu acts on THAT pane — a split from pane B must name pane B
  await page.locator('.pane').nth(1).locator('.phead .pact').first().click();
  await page.waitForTimeout(150);
  check('the pane ⊞ opens the pane menu', await page.locator('#splitMenu').isVisible());
  check('the erroring "move this tab out" buttons are gone',
    await page.locator('#splitMenu button[data-splitoff]').count() === 0);
  check('the pane menu offers a new tab in this pane', await page.locator('#paneNewTab').count() === 1);
  check('the pane menu offers closing this pane', await page.locator('#paneClose').count() === 1);
  await page.locator('#splitMenu button[data-split="right"]').click();
  await page.waitForTimeout(400);
  check('a split from a pane header names that pane',
    (seen.split[seen.split.length - 1] || {}).pane === PANE.b,
    JSON.stringify(seen.split[seen.split.length - 1] || {}));

  // × on a pane header kills the pane, not just its selected tab
  const killsBefore = seen.closePane.length;
  await page.locator('.pane').nth(1).locator('.phead .pact.kill').click();
  await page.waitForTimeout(400);
  check('× on a pane header closes the whole pane', seen.closePane.length === killsBefore + 1,
    'n=' + (seen.closePane.length - killsBefore));
  check('the close names the pane it was tapped on',
    (seen.closePane[seen.closePane.length - 1] || {}).pane === PANE.b,
    JSON.stringify(seen.closePane[seen.closePane.length - 1] || {}));

  // --- dropping a file lands it on the Mac and types the path ---
  // The remote equivalent of dragging an image into a terminal: there is no path on the phone, so
  // the file is uploaded and the path it landed at goes into the composer (quoted, since a photo
  // name has spaces in it more often than not).
  const paneBox = await page.locator('.pane').nth(1).boundingBox();
  const overlayDuringDrag = await page.evaluate(async ({ x, y }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'my reference shot.png', { type: 'image/png' }));
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    window.dispatchEvent(new DragEvent('dragenter', opts));
    window.dispatchEvent(new DragEvent('dragover', opts));
    await new Promise((r) => setTimeout(r, 120));
    const shown = !document.getElementById('fileDrop').hidden;
    window.dispatchEvent(new DragEvent('drop', opts));
    return shown;
  }, { x: paneBox.x + paneBox.width / 2, y: paneBox.y + paneBox.height / 2 });
  await page.waitForTimeout(900);
  check('dragging a file in shows the drop overlay', overlayDuringDrag);
  check('the overlay goes away after the drop', await page.locator('#fileDrop').isVisible() === false);
  check('the file reached the bridge with its name intact',
    (seen.upload[seen.upload.length - 1] || {}).name === 'my reference shot.png',
    JSON.stringify(seen.upload[seen.upload.length - 1] || {}));
  check('the file body was forwarded, not swallowed',
    (seen.upload[seen.upload.length - 1] || {}).bytes > 0);
  const composed = await page.locator('#text').inputValue();
  check('the path lands in the composer, quoted',
    composed === "'/Users/stub/Downloads/cmux-remote/2026-07-31/my reference shot.png'", JSON.stringify(composed));
  check('there is an attach button for phones (no drag there)',
    await page.locator('#attachBtn').count() === 1);
  await page.locator('#text').fill('');

  // --- several files at once: every one lands, and one bad file does not take the batch down ---
  // A folder dragged out of Finder arrives as a 0-byte File. The bridge refuses it (`empty`), and
  // the first refusal used to abort the loop and throw away the paths already uploaded — so a bulk
  // attach with one folder in it "gave an error and did not work" while every single file worked.
  const bulkBefore = seen.upload.length;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-bulk-'));
  const mk = (n, bytes) => { const p = path.join(tmp, n); fs.writeFileSync(p, Buffer.alloc(bytes, 65)); return p; };
  await page.setInputFiles('#attachInput', [mk('one.txt', 10), mk('two.png', 20), mk('three.pdf', 30)]);
  await page.waitForTimeout(1500);
  const bulkComposed = await page.locator('#text').inputValue();
  check('attaching three files uploads all three', seen.upload.length === bulkBefore + 3,
    'n=' + (seen.upload.length - bulkBefore));
  check('all three paths land in the composer',
    ['one.txt', 'two.png', 'three.pdf'].every((n) => bulkComposed.includes('/' + n)), JSON.stringify(bulkComposed));
  await page.locator('#text').fill('');
  const mixedBefore = seen.upload.length;
  await page.setInputFiles('#attachInput', [mk('good.txt', 10), mk('folder', 0), mk('also-good.txt', 12)]);
  await page.waitForTimeout(1500);
  const mixedComposed = await page.locator('#text').inputValue();
  const mixedStatus = await page.locator('#status').evaluate((e) => e.textContent);
  check('a 0-byte entry does not abort the batch: the good files still land',
    mixedComposed.includes('/good.txt') && mixedComposed.includes('/also-good.txt'), JSON.stringify(mixedComposed));
  check('the status names the skipped file and says why',
    /folder/.test(mixedStatus) && /empty/i.test(mixedStatus), JSON.stringify(mixedStatus));
  check('the 0-byte entry never crosses the wire',
    !seen.upload.slice(mixedBefore).some((u) => u.name === 'folder'),
    JSON.stringify(seen.upload.slice(mixedBefore).map((u) => u.name)));
  await page.locator('#text').fill('');

  // --- pasting a screenshot is the same gesture without the drag ---
  // A clipboard image has no filename, so it must be stamped rather than left as the browser's
  // placeholder, and some browsers expose it only through `items` — never through `files`.
  const uploadsBeforePaste = seen.upload.length;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], 'image.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await page.waitForTimeout(900);
  const pasted = seen.upload[seen.upload.length - 1] || {};
  check('pasting an image uploads it', seen.upload.length === uploadsBeforePaste + 1,
    'n=' + (seen.upload.length - uploadsBeforePaste));
  check('a nameless screenshot gets a timestamped name, not "image.png"',
    /^pasted-\d{8}-\d{6}\.png$/.test(pasted.name || ''), JSON.stringify(pasted.name));
  check('the pasted bytes made it through', pasted.bytes === 5, 'bytes=' + pasted.bytes);
  check('the pasted path lands in the composer',
    (await page.locator('#text').inputValue()).includes(pasted.name || 'NOPE'));
  await page.locator('#text').fill('');

  // a paste that carries no files at all must not be swallowed — typing still works
  const uploadsBeforeText = seen.upload.length;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just some text');
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await page.waitForTimeout(300);
  check('a text paste is left alone', seen.upload.length === uploadsBeforeText);
  check('there is a clipboard button for iOS (no ⌘V there)',
    await page.locator('#pasteBtn').count() === 1);

  // --- p17 sidebar: every machine, what is waiting, three modes, drawer on a phone ---
  // TWO of the three machines are reachable and answered by the same stub bridge, so they carry the
  // same tree: every FLEET-wide count is double the per-machine one. Machine-scoped locators keep the
  // per-machine assertions honest about which machine they are reading.
  const box = (id) => page.locator(`#side .sidem[data-machine="${id}"]`);
  const machineLabel = () => page.locator('#hostLabel').innerText();
  check('the dropdown is gone', await page.locator('#wsMenu').count() === 0);
  check('desktop opens with the panel in full mode', await page.locator('#side').getAttribute('data-mode') === 'full');
  const mh = page.locator('#side .sidemh');
  check('every machine is listed', await mh.count() === 3, 'n=' + await mh.count());
  // The panel is where a dead machine is now reported, so the wording regression that used to be
  // checked on #status lives here: named machine, plain words, never the raw bridge code.
  const deadText = await page.locator('#side .sideerr').innerText();
  check('an unreachable bridge is reported by machine name in words, not as a raw code',
    /unreachable/i.test(deadText) && !/bridge_unreachable/.test(deadText) && /Unplugged Mac/.test(deadText),
    JSON.stringify(deadText));
  check('the waiting tab badges its workspace',
    await box('default').locator('.siderow.ws .sidecount').first().innerText() === '1');
  check('the waiting tab badges its machine', await mh.first().locator('.sidecount').innerText() === '1');
  check('the header badge carries the fleet total (one waiting on each reachable machine)',
    await page.locator('#sideBadge').innerText() === '2', 'badge=' + await page.locator('#sideBadge').innerText());
  const subRows = box('default').locator('.siderow.tab');
  check('only the running and waiting tabs are listed under the workspace', await subRows.count() === 2, 'n=' + await subRows.count());
  const focusBefore = seen.focusSurface.length;
  await box('default').locator('.siderow.tab', { hasText: 'left-second' }).click();
  await page.waitForTimeout(500);
  check('tapping the waiting tab lands on it', seen.focusSurface.length > focusBefore && seen.focusSurface[seen.focusSurface.length - 1].surface === SF.a2,
    JSON.stringify(seen.focusSurface.slice(-1)));
  const wsRows = await box('unplugged').locator('.siderow.ws').count();
  check('the dead machine lists no workspaces', wsRows === 0, 'ws rows=' + wsRows);

  // --- switching machines from the panel, and the remembered machine surviving a reload (23e6667) --
  // The panel replaced the machine dropdown, so it is the only way to change machine now. The dead
  // machine is deliberately NOT switchable here: it has no workspace rows to tap.
  await box('second').locator('.siderow.ws').first().click();
  await page.waitForTimeout(1500);
  check('tapping a workspace under another machine switches to it', (await machineLabel()) === 'Second Mac',
    JSON.stringify(await machineLabel()));
  const secondPanes = await page.locator('.pane').count();
  check('the second machine paints its own panes', secondPanes >= 1, 'panes=' + secondPanes);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1200);
  check('a reload comes back on the machine that was chosen, not the first registered one',
    (await machineLabel()) === 'Second Mac', JSON.stringify(await machineLabel()));
  await box('default').locator('.siderow.ws').first().click();
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1200);
  check('switching back repaints the first machine',
    (await machineLabel()) === 'stub-mac' && await page.locator('.pane').count() >= 1,
    JSON.stringify(await machineLabel()) + ' panes=' + await page.locator('.pane').count());

  // --- a tab that finishes OFF SCREEN badges `done`, and opening it clears it (spec §2.3, §6) ---
  // Land on left-agent first: a surface mirrored in a pane is ON screen, and an on-screen tab never
  // badges done — so left-second has to be the one nobody is looking at.
  await box('default').locator('.siderow.tab', { hasText: 'left-agent' }).click();
  await page.waitForTimeout(700);
  // the client polls the fleet every 5 s, so each transition is waited for in the DOM, not slept on
  const glyph = (mid, sid, st) => page.waitForFunction(
    ([m, s, g]) => {
      const r = document.querySelector(`#side .sidem[data-machine="${m}"] .siderow.tab[data-surface="${s}"]`);
      return !!(r && r.querySelector('.sideglyph.' + g));
    }, [mid, sid, st], { timeout: 20000, polling: 250 });
  const setStatus_ = (sid, st) => fetch(`http://127.0.0.1:${BRIDGE_PORT}/stub/set-status?surface=${sid}&status=${encodeURIComponent(st)}`);
  await setStatus_(SF.a2, 'Running');
  let ranOffScreen = true;
  await glyph('default', SF.a2, 'running').catch(() => { ranOffScreen = false; });
  check('a tab that starts running off screen shows as running', ranOffScreen);
  await setStatus_(SF.a2, '');
  let doneShown = true;
  await glyph('default', SF.a2, 'done').catch(() => { doneShown = false; });
  check('a tab that went Running → idle off screen badges done', doneShown);
  check('the done tab still counts on its workspace',
    await box('default').locator('.siderow.ws .sidecount').first().innerText() === '1',
    'count=' + await box('default').locator('.siderow.ws .sidecount').first().innerText());
  const focusBeforeDone = seen.focusSurface.length;
  await box('default').locator('.siderow.tab', { hasText: 'left-second' }).click();
  await page.waitForTimeout(700);
  check('tapping the done tab lands on it',
    seen.focusSurface.length > focusBeforeDone && seen.focusSurface[seen.focusSurface.length - 1].surface === SF.a2,
    JSON.stringify(seen.focusSurface.slice(-1)));
  const doneRowsLeft = await box('default').locator(`.siderow.tab[data-surface="${SF.a2}"]`).count();
  check('opening it clears the done row at once', doneRowsLeft === 0, 'rows=' + doneRowsLeft);
  check('and the header badge drops by one', await page.locator('#sideBadge').innerText() === '1',
    'badge=' + await page.locator('#sideBadge').innerText());

  // --- the panel keeps its scroll position across a beat ---
  // A repaint rebuilds the list every 5 s; a fleet taller than the panel was unscrollable because of
  // it. The fixture fleet is short, so the overflow a real fleet has is created by capping the list.
  const style = await page.addStyleTag({ content: '#side .sidelist { max-height: 90px !important; }' });
  const listTop = () => page.locator('#side .sidelist').evaluate((e) => e.scrollTop);
  await page.locator('#side .sidelist').evaluate((e) => { e.scrollTop = 45; });
  const scrolledTo = await listTop();
  await setStatus_(SF.a, 'Needs input');                        // a real change, so a repaint must happen
  await glyph('default', SF.a, 'waiting').catch(() => {});
  const keptScroll = await listTop();
  check('the panel keeps its scroll position across a beat', scrolledTo > 0 && keptScroll === scrolledTo,
    'before=' + scrolledTo + ' after=' + keptScroll);
  await setStatus_(SF.a, 'Running');
  await glyph('default', SF.a, 'running').catch(() => {});
  await style.evaluate((e) => e.remove());

  // rail ↔ full persists across a reload
  await page.locator('#side .siderail').click();
  await page.waitForTimeout(200);
  check('the foot control collapses to the rail', await page.locator('#side').getAttribute('data-mode') === 'rail');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1200);
  check('the rail survives a reload', await page.locator('#side').getAttribute('data-mode') === 'rail');
  await page.locator('#side .sidemh').first().click();
  await page.waitForTimeout(200);
  check('tapping a rail cell opens full', await page.locator('#side').getAttribute('data-mode') === 'full');
  await page.locator('#wsChip').click();
  await page.waitForTimeout(200);
  check('the header chip hides the panel', await page.locator('#side').getAttribute('data-mode') === 'hidden');
  await page.locator('#wsChip').click();
  await page.waitForTimeout(200);
  check('and brings it back to the last open mode', await page.locator('#side').getAttribute('data-mode') === 'full');

  // --- narrow viewport collapses to one pane (the phone path) ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const narrow = await page.locator('.pane').count();
  const solo = await page.locator('.pane.solo').count();
  check('a phone viewport mirrors one pane at a time', narrow === 1 && solo === 1, 'panes=' + narrow + ' solo=' + solo);
  check('resizing down to a phone puts the panel away', await page.locator('#side').getAttribute('data-mode') === 'hidden');
  // ...and so does a COLD BOOT on a phone, which is the case the resize above cannot prove: the
  // desktop's stored mode is still `full`, and the phone reads its own key (cmux_side_phone).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1000);
  check('a phone starts with the panel hidden', await page.locator('#side').getAttribute('data-mode') === 'hidden',
    'mode=' + await page.locator('#side').getAttribute('data-mode'));
  check('the desktop mode is remembered separately, and is still full',
    await page.evaluate(() => localStorage.getItem('cmux_side')) === 'full',
    JSON.stringify(await page.evaluate(() => localStorage.getItem('cmux_side'))));
  await page.locator('#wsChip').click();
  await page.waitForTimeout(250);
  await page.locator('#side .siderail').click();
  await page.waitForTimeout(250);
  check('the foot control collapses the phone drawer to the rail',
    await page.locator('#side').getAttribute('data-mode') === 'rail');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await page.waitForTimeout(1000);
  check('the phone remembers its OWN mode across a reload',
    await page.locator('#side').getAttribute('data-mode') === 'rail',
    'mode=' + await page.locator('#side').getAttribute('data-mode'));
  await page.locator('#side .siderail').click();   // back to full, so the chip below reopens as a drawer
  await page.waitForTimeout(200);
  await page.locator('#wsChip').click();           // and away, so the remaining phone checks start hidden
  await page.waitForTimeout(250);
  check('the chip puts the phone panel away again',
    await page.locator('#side').getAttribute('data-mode') === 'hidden');
  await page.locator('#wsChip').click();
  await page.waitForTimeout(250);
  check('on a phone full is a drawer with a scrim', await page.locator('#side').getAttribute('data-mode') === 'full'
    && await page.locator('#sidescrim').isVisible());
  await page.locator('#side .siderow.ws').first().click();
  await page.waitForTimeout(400);
  check('a navigating tap closes the drawer', await page.locator('#side').getAttribute('data-mode') === 'hidden');
  const noHandles = await page.locator('.phandle').count();
  check('no drag handles on a phone viewport', noHandles === 0, 'handles=' + noHandles);
  // the phone never shows a split, so the strip has to come back as its switcher — and it carries
  // the new-tab affordances the pane headers hold in split view
  check('the tab strip returns on a phone viewport', await page.locator('#tabs').isVisible());
  check('the strip offers new tabs', await page.locator('#tabs .tab.add').count() === 2,
    'n=' + await page.locator('#tabs .tab.add').count());
  check('the Files toggle is still in the toolbar on a phone',
    await page.locator('header #filesBtn').isVisible());

  // --- the long-press sheet is placed in the VIEWPORT, so #side's overflow cannot swallow it ---
  // A short viewport puts the last workspace row near the bottom edge — the case where a sheet
  // positioned inside the panel was painted past #side's clipped box and never appeared at all.
  await page.setViewportSize({ width: 390, height: 320 });
  await page.waitForTimeout(400);
  await page.locator('#wsChip').click();
  await page.waitForTimeout(300);
  await page.locator('#side .siderow.ws').last().evaluate((e) => e.scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(200);
  await page.locator('#side .siderow.ws').last().dispatchEvent('touchstart');
  await page.waitForTimeout(700);
  const sheetGeom = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#side .siderow.ws')].pop();
    const sheet = document.querySelector('#side .sidesheet');
    if (!row || !sheet) return { sheet: !!sheet };
    const rc = row.getBoundingClientRect(), sr = sheet.getBoundingClientRect();
    const mr = document.getElementById('side').getBoundingClientRect();
    return { sheet: true, pos: getComputedStyle(sheet).position, top: sr.top, bottom: sr.bottom,
      // where the pre-fix code put it, and how far past the panel's clipped box that was
      insidePanelWouldOverflow: rc.bottom + 4 + sr.height > mr.bottom, vh: window.innerHeight };
  });
  check('a long-press near the bottom opens a sheet that is fully on screen',
    !!sheetGeom.sheet && sheetGeom.pos === 'fixed' && sheetGeom.top >= 0 && sheetGeom.bottom <= sheetGeom.vh
    && sheetGeom.insidePanelWouldOverflow, JSON.stringify(sheetGeom));
  check('the sheet offers rename and close', await page.locator('#side .sidesheet button').count() === 2,
    'n=' + await page.locator('#side .sidesheet button').count());
} catch (e) {
  check('smoke run completed', false, e && e.message);
} finally {
  await browser.close();
  server.kill();
  bridge.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
