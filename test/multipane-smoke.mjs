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
const tree = () => ({ workspaces: [{
  ref: 'workspace:1', id: WS, title: 'SMOKE', selected: true, window: 'win',
  tabs: [
    { id: SF.a, ref: 'surface:1', title: 'left-agent', type: 'terminal', selected: true, pane: PANE.a, paneRef: 'pane:1', inPane: true, status: 'Running' },
    { id: SF.a2, ref: 'surface:3', title: 'left-second', type: 'terminal', selected: false, pane: PANE.a, paneRef: 'pane:1', inPane: false, status: '' },
    { id: SF.b, ref: 'surface:2', title: 'right-agent', type: 'terminal', selected: false, pane: PANE.b, paneRef: 'pane:2', inPane: true, status: '' },
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

  // --- narrow viewport collapses to one pane (the phone path) ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const narrow = await page.locator('.pane').count();
  const solo = await page.locator('.pane.solo').count();
  check('a phone viewport mirrors one pane at a time', narrow === 1 && solo === 1, 'panes=' + narrow + ' solo=' + solo);
  const noHandles = await page.locator('.phandle').count();
  check('no drag handles on a phone viewport', noHandles === 0, 'handles=' + noHandles);
  // the phone never shows a split, so the strip has to come back as its switcher — and it carries
  // the new-tab affordances the pane headers hold in split view
  check('the tab strip returns on a phone viewport', await page.locator('#tabs').isVisible());
  check('the strip offers new tabs', await page.locator('#tabs .tab.add').count() === 2,
    'n=' + await page.locator('#tabs .tab.add').count());
  check('the Files toggle is still in the toolbar on a phone',
    await page.locator('header #filesBtn').isVisible());
} catch (e) {
  check('smoke run completed', false, e && e.message);
} finally {
  await browser.close();
  server.kill();
  bridge.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
