// Playwright phone smoke for the p4 Files tab.
//
// Playwright is BORROWED, not depended on — this repo stays npm-install-free, so there is no
// node_modules here to resolve it from. Point PLAYWRIGHT_DIR at any Playwright install you
// already have, or run this from a directory whose node_modules contains one:
//
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p4-files-smoke.mjs
//
// (ESM ignores NODE_PATH, which is why this is an explicit path rather than a bare import.)
// The server must be up: ./start-cmux-remote.sh
//
// The XSS assertion is the one that matters. It writes a fixture markdown file into a browsable
// root, opens it through the real UI, and asserts the payload did not execute. Verified by
// mutation: bypassing DOMPurify makes it fail.
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';

async function loadPlaywright() {
  const tried = [];
  if (process.env.PLAYWRIGHT_DIR) {
    tried.push(process.env.PLAYWRIGHT_DIR);
    try { return await import(process.env.PLAYWRIGHT_DIR); } catch (_) { /* fall through */ }
  }
  // Bare specifier: works when invoked from somewhere Node can resolve `playwright`.
  tried.push('playwright (bare specifier)');
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  console.error(
    'FAIL: could not load Playwright.\n' +
    '  Tried: ' + tried.join(', ') + '\n' +
    '  Set PLAYWRIGHT_DIR to a playwright entry point, e.g.\n' +
    '    PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p4-files-smoke.mjs');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TOKEN = (readFileSync(`${REPO}/.env`, 'utf8').match(/^SERVER_TOKEN=(.*)$/m) || [])[1]
  ?.trim().replace(/^['"]|['"]$/g, '');
if (!TOKEN) { console.error('FAIL: no SERVER_TOKEN in .env'); process.exit(1); }

let failed = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name); if (!ok) failed++; };

const api = async (p) => (await fetch('http://localhost:8080/api/cmux/fs/' + p, {
  headers: { Authorization: 'Bearer ' + TOKEN },
})).json();

// Find a directory with more than one page of entries, so the paging assertions mean something.
// Probes a few likely spots rather than walking the whole tree.
async function findBigDir(root) {
  const probes = [];
  const top = await api(`list?path=${encodeURIComponent(root)}&offset=0&limit=500`);
  for (const e of (top.entries || [])) {
    if (e.type !== 'dir') continue;
    probes.push(`${root}/${e.name}/node_modules/.pnpm`, `${root}/${e.name}/node_modules`);
  }
  for (const p of probes) {
    const d = await api(`list?path=${encodeURIComponent(p)}&offset=0&limit=1`);
    if (!d.error && d.total > 200) return { path: p, total: d.total };
  }
  return null;
}

// The 📁 control is a toggle, so tests must never click it blind — they have to know the current
// state or they will close the panel they meant to open.
async function closeFiles(page) {
  const ctl = page.locator('header #filesBtn');
  if (await ctl.getAttribute('aria-pressed') === 'true') {
    await ctl.click();
    await page.waitForTimeout(600);
  }
}

// Drive the UI to an absolute path by tapping breadcrumb-reachable rows. The app never accepts a
// path from outside — every navigation is a tap — so the smoke test navigates the same way a
// thumb would, one segment at a time.
async function navigateTo(page, target) {
  const cur = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#fcrumb span')].slice(1).map((s) => s.textContent);
    return segs.length ? '/' + segs.join('/') : null;
  });
  if (cur === target) return;
  // Walk up to the shared prefix via the breadcrumb, then descend by tapping rows.
  const parts = target.split('/').filter(Boolean);
  const curParts = (cur || '').split('/').filter(Boolean);
  let shared = 0;
  while (shared < parts.length && shared < curParts.length && parts[shared] === curParts[shared]) shared++;
  if (cur && shared < curParts.length) {
    if (shared === 0) { await page.locator('#fcrumb span').first().click(); }
    else { await page.locator('#fcrumb span').nth(shared).click(); }
    await page.waitForTimeout(700);
  }
  for (let i = shared; i < parts.length; i++) {
    const row = page.locator('#flist .frow', { hasText: parts[i] }).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    await page.waitForTimeout(700);
  }
}

// The fixture must live inside a browsable root. Ask the server which roots exist rather than
// hardcoding a path — with FS_ROOTS=workspace-cwds the answer depends on what cmux has open.
const rootsRes = await fetch('http://localhost:8080/api/cmux/fs/roots', {
  headers: { Authorization: 'Bearer ' + TOKEN },
});
const { roots = [] } = await rootsRes.json();
const root = (roots.find((r) => r.kind === 'workspace') || roots[0] || {}).path;
if (!root) { console.error('FAIL: no browsable roots configured'); process.exit(1); }

// The download endpoint is the one /api route SERVER_TOKEN does not gate, so its own credential
// has to hold on its own. Both halves are checked before the UI ever runs.
{
  const mint = `http://localhost:8080/api/cmux/fs/download-ticket?path=${encodeURIComponent(root)}`;
  check('minting a download ticket without the server token is 401',
    (await fetch(mint)).status === 401);
  check('the download endpoint rejects an unknown ticket',
    (await fetch('http://localhost:8080/api/cmux/fs/download?ticket=not-a-real-ticket')).status === 403);
}

const FIXTURE = `${root}/_p4-smoke-fixture.md`;
writeFileSync(FIXTURE, [
  '# p4 smoke fixture',
  '',
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned2=1</script>',
  '',
  '| col | col |',
  '|---|---|',
  '| a | b |',
  '',
  '```js',
  'const highlighted = true;',
  '```',
  '',
].join('\n'));

// A binary fixture with NUL bytes: the viewer can only stub it, so Download is its ONLY exit —
// and its bytes must survive the round trip through both hops unchanged.
const BINFIX = `${root}/_p4-smoke-fixture.bin`;
const BINBYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + (i % 7)) & 0xff));
writeFileSync(BINFIX, BINBYTES);
const sha = (b) => createHash('sha256').update(b).digest('hex');

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  acceptDownloads: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// A download navigation never shows up in page.on('request') — Chromium hands it to the download
// manager — so the Download object is where its URL is observable.
const dlUrls = [];
page.on('download', (d) => dlUrls.push(d.url()));

try {
  // domcontentloaded, NEVER networkidle — the app holds long-lived SSE connections open.
  await page.goto(`http://localhost:8080/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 15000 });

  // The Files control lives in the TOOLBAR now (it used to be the first chip in the tab strip, but
  // the strip is the one-pane view's switcher and disappears in split view — the explorer must be
  // reachable in both).
  check('Files control is present in the toolbar', await page.locator('header #filesBtn').count() === 1);
  check('Files control is no longer a tab chip', await page.locator('#tabs .tab.files').count() === 0);

  await page.locator('header #filesBtn').click();
  await page.waitForSelector('#files .frow', { timeout: 10000 });
  check('roots screen lists at least one root', await page.locator('#files .frow').count() > 0);
  check('files pane is visible', await page.locator('#files').isVisible());
  check('footer is hidden in files mode', !(await page.locator('footer').isVisible()));

  await page.locator('#files .frow').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#flist .frow').length > 1, null, { timeout: 10000 });
  check('entering a root lists a directory', await page.locator('#flist .frow').count() > 1);
  check('breadcrumb is built', await page.locator('#fcrumb span').count() > 1);
  check('footer shows a count', /\d/.test(await page.locator('#ffoot').textContent() || ''));

  // Paging must be exercised against a directory bigger than one page (200), otherwise the
  // assertion passes vacuously. Walk to a pnpm store if one is reachable — those run to
  // thousands of entries, which is exactly the case lazy loading exists for.
  const big = await findBigDir(root);
  if (big) {
    await navigateTo(page, big.path);
    await page.waitForFunction(
      (n) => document.querySelectorAll('#flist .frow').length >= n, 200, { timeout: 20000 });
    const firstPage = await page.locator('#flist .frow').count();
    check(`big dir (${big.total} entries) loads exactly one page first (${firstPage})`,
      firstPage === 200);

    await page.locator('#flist').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(
      (n) => document.querySelectorAll('#flist .frow').length > n, firstPage, { timeout: 20000 });
    const grown = await page.locator('#flist .frow').count();
    check(`scrolling loaded the next page (${firstPage} -> ${grown})`, grown > firstPage);
    check('footer reports loaded/total',
      /\d+\s*\/\s*\d+/.test(await page.locator('#ffoot').textContent() || ''));

    // Row identity must be stable across page boundaries — a sort that is not total would
    // duplicate or drop entries when paging.
    const names = await page.locator('#flist .frow .fname').allTextContents();
    check('no duplicate rows across page boundary', new Set(names).size === names.length);

    await navigateTo(page, root);
    await page.waitForTimeout(600);
  } else {
    console.log('SKIP — no directory over 200 entries reachable; paging not exercised');
  }

  // The fixture — markdown rendering plus the XSS assertions.
  const row = page.locator('#flist .frow', { hasText: '_p4-smoke-fixture.md' }).first();
  check('fixture file is listed', await row.count() > 0);
  await row.click();
  await page.waitForFunction(
    () => !/^Loading/.test(document.getElementById('fvbody').textContent || ''),
    null, { timeout: 15000 });
  await page.waitForTimeout(1200);

  check('markdown rendered a heading', await page.locator('#fvbody h1').count() > 0);
  check('GFM table rendered', await page.locator('#fvbody table td').count() >= 2);
  check('fenced code was highlighted', await page.locator('#fvbody pre code').count() > 0);
  check('XSS img onerror did NOT fire', await page.evaluate(() => window.__pwned === undefined));
  check('inline <script> did NOT run', await page.evaluate(() => window.__pwned2 === undefined));
  check('no <script> survived sanitize', await page.locator('#fvbody script').count() === 0);

  await page.locator('#fvtoggle').click();
  await page.waitForTimeout(400);
  const raw = await page.locator('#fvbody pre').textContent();
  check('Raw toggle shows the source', /onerror/.test(raw || ''));

  // ---- Download ----
  // The assertion that matters is BYTE-IDENTITY: the viewer is allowed to truncate, transcode and
  // re-render, and a download that inherited any of that would be a silently corrupt file.
  check('viewer offers a Download button', await page.locator('#fvdl').isVisible());
  const [mdDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('#fvdl').click(),
  ]);
  check('download keeps the file name', mdDl.suggestedFilename() === '_p4-smoke-fixture.md',
    mdDl.suggestedFilename());
  check('downloaded markdown is byte-identical to the file on disk',
    sha(readFileSync(await mdDl.path())) === sha(readFileSync(FIXTURE)));
  // The download is a NAVIGATION, so it cannot send an Authorization header. It must carry a
  // one-file ticket instead — SERVER_TOKEN in that URL would land in history and in every log.
  check('the download URL carries a ticket and never SERVER_TOKEN',
    dlUrls.length > 0 && dlUrls.every((u) => u.includes('ticket=') && !u.includes(TOKEN)), dlUrls[0]);

  await page.locator('#fvback').click();
  await page.waitForTimeout(800);
  const binRow = page.locator('#flist .frow', { hasText: '_p4-smoke-fixture.bin' }).first();
  if (await binRow.count()) {
    await binRow.click();
    await page.waitForFunction(
      () => !/^Loading/.test(document.getElementById('fvbody').textContent || ''), null, { timeout: 15000 });
    check('a binary opens as a stub', /binary/i.test(await page.locator('#fvbody').textContent() || ''));
    check('Copy is hidden for a binary — there is nothing to copy',
      !(await page.locator('#fvcopy').isVisible()));
    check('Download is still offered for a binary', await page.locator('#fvdl').isVisible());
    const [binDl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.locator('#fvdl').click(),
    ]);
    check('downloaded binary is byte-identical (NUL bytes and all)',
      sha(readFileSync(await binDl.path())) === sha(BINBYTES));
  } else { console.log('SKIP — binary fixture not listed'); }

  await page.goBack();
  await page.waitForTimeout(700);
  check('back returns to the listing', await page.locator('#flist .frow').count() > 0);

  // Leaving Files for a terminal tab must actually reveal the terminal. The files/viewer panes are
  // absolutely positioned at z-index 3 over #wrap, so a stale body class leaves them covering a
  // terminal that is rendering perfectly well underneath — looks like "the tab didn't switch".
  const termTab = page.locator('.tab:not(.files):not(.browser)').first();
  if (await termTab.count()) {
    await closeFiles(page);
    await page.locator('header #filesBtn').click();
    await page.waitForSelector('#files .frow', { timeout: 10000 });
    await termTab.click();
    await page.waitForTimeout(800);
    check('files pane is hidden after switching to a terminal tab',
      !(await page.locator('#files').isVisible()));
    check('terminal screen is visible after switching back',
      await page.locator('.pane .pscreen').first().isVisible());
    check('body no longer carries a files mode class',
      await page.evaluate(() => !document.body.classList.contains('mode-files')
        && !document.body.classList.contains('mode-fview')));
    check('footer (composer) is back', await page.locator('footer').isVisible());

    // Same journey, but leaving from the VIEWER rather than the listing.
    await closeFiles(page);
    await page.locator('header #filesBtn').click();
    await page.waitForSelector('#files .frow', { timeout: 10000 });
    await page.locator('#files .frow').first().click();
    await page.waitForFunction(
      () => document.querySelectorAll('#flist .frow').length > 1, null, { timeout: 10000 });
    const anyFile = page.locator('#flist .frow:not(.dir)').first();
    if (await anyFile.count()) {
      await anyFile.click();
      await page.waitForTimeout(1000);
      await termTab.click();
      await page.waitForTimeout(800);
      check('viewer pane is hidden after switching to a terminal tab',
        !(await page.locator('#fviewer').isVisible()));
      check('terminal screen is visible after leaving the viewer',
        await page.locator('.pane .pscreen').first().isVisible());
    }
  } else {
    console.log('SKIP — no terminal tab available to switch back to');
  }

  // The 📁 control toggles: a second tap must dismiss the panel, not re-open it.
  // Normalize to CLOSED first — earlier blocks may leave it open, and with a toggle a blind
  // click would close rather than open.
  await closeFiles(page);
  await page.locator('header #filesBtn').click();
  await page.waitForSelector('#files .frow', { timeout: 10000 });
  check('files control reads as pressed while open',
    await page.locator('header #filesBtn').getAttribute('aria-pressed') === 'true');
  await page.locator('header #filesBtn').click();
  await page.waitForTimeout(700);
  check('second tap on the files control hides the panel',
    !(await page.locator('#files').isVisible()));
  check('files control reads as unpressed once closed',
    await page.locator('header #filesBtn').getAttribute('aria-pressed') === 'false');

  // Dotfile checkbox — server-side filter, so `total` must move with it.
  await closeFiles(page);
  await page.locator('header #filesBtn').click();
  await page.waitForSelector('#files .frow', { timeout: 10000 });
  await page.locator('#files .frow').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#flist .frow').length > 1, null, { timeout: 10000 });
  check('dotfile checkbox is present and checked by default',
    await page.locator('#fdotcb').isChecked());
  // Pin to a directory KNOWN to contain dotfiles. Reopening now restores the last location, so
  // whatever directory this block happens to inherit may have none — and the assertion would
  // pass without testing anything.
  await navigateTo(page, root);
  await page.waitForTimeout(900);
  const withDots = await page.locator('#flist .frow').count();
  const dotRows = await page.locator('#flist .frow', { hasText: /^\S*\s\./ }).count();
  check(`test directory actually contains dotfiles (${dotRows})`, dotRows > 0);
  await page.locator('#fdotcb').uncheck();
  await page.waitForTimeout(1200);
  const withoutDots = await page.locator('#flist .frow').count();
  check(`unchecking hides dotfiles (${withDots} -> ${withoutDots}, ${dotRows} dot rows)`,
    withoutDots === withDots - dotRows);
  check('no dotfile rows remain',
    (await page.locator('#flist .fname').allTextContents()).every((t) => !/\s\./.test(t)));
  await page.locator('#fdotcb').check();
  await page.waitForTimeout(1200);
  check('re-checking restores them', await page.locator('#flist .frow').count() === withDots);

  // Reopening must land where you left off, not back at the roots screen.
  await closeFiles(page);
  await page.locator('header #filesBtn').click();
  await page.waitForSelector('#files .frow', { timeout: 10000 });
  await page.locator('#files .frow').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#flist .frow').length > 1, null, { timeout: 10000 });
  const dirRow = page.locator('#flist .frow.dir').first();
  if (await dirRow.count()) { await dirRow.click(); await page.waitForTimeout(900); }
  const leftAt = await page.evaluate(() =>
    [...document.querySelectorAll('#fcrumb span')].slice(1).map((s) => s.textContent).join('/'));

  await page.locator('header #filesBtn').click();      // close
  await page.waitForTimeout(600);
  await page.locator('header #filesBtn').click();      // reopen
  await page.waitForTimeout(1200);
  const backAt = await page.evaluate(() =>
    [...document.querySelectorAll('#fcrumb span')].slice(1).map((s) => s.textContent).join('/'));
  check(`reopening restores the last directory (${leftAt || '(roots)'} -> ${backAt || '(roots)'})`,
    !!leftAt && backAt === leftAt);
  check('restored view actually lists that directory',
    await page.locator('#flist .frow').count() > 0);

  // And it must survive a full relaunch — iOS kills the standalone app constantly, so every
  // open is a cold boot.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 15000 });
  await page.locator('header #filesBtn').click();
  await page.waitForTimeout(1500);
  const afterReload = await page.evaluate(() =>
    [...document.querySelectorAll('#fcrumb span')].slice(1).map((s) => s.textContent).join('/'));
  check(`last directory survives a reload (${afterReload || '(roots)'})`, afterReload === leftAt);

  check('no uncaught page errors', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 3));
} finally {
  await browser.close();
  for (const f of [FIXTURE, BINFIX]) { try { unlinkSync(f); } catch (_) { /* already gone */ } }
}

console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
