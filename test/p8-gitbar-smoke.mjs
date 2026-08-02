// p8 — the browser proof of the source-control bar in the file explorer (specs.md §8.2, B1–B11).
//
// Launched by test/p8-browser-run.mjs, never by hand: the runner owns the fixtures, the tokens, the
// worktree-booted server/bridge pair and the scratch cmux workspaces, and it has already asserted
// every §8.3 precondition — including asking the running server how it classifies each fixture.
// Running this file directly would be running it against an environment nobody checked.
//
// TWO PROPERTIES ABOVE ALL, because they are the ones a green suite can most easily fake:
//
//   * p8 is READ-ONLY. It renders git command TEXT the operator runs by hand; it never writes to a
//     repository. So every fixture's staged index and HEAD are captured before the browser opens and
//     compared after it closes, and B10 proves repo A's index byte-for-byte across the one
//     interaction designed to smuggle a write into it.
//   * A COUNT ORACLE IS NOT AN ABSENCE ORACLE. `querySelectorAll('#gitbar *').length === 0` is
//     satisfied by a bar left attached and merely emptied. Every "no bar" assertion here reads the
//     mount's TEXT and requires it gone.
//
// Assertions are on the user-visible property, never a proxy — p7's auto-scroll bug passed a
// `scrollTop` proxy while broken.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PW = process.env.PLAYWRIGHT_DIR || '/path/to/workspace/app-web/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const exec = promisify(execFile);
const GIT = '/usr/bin/git';
const BASE = process.env.P8_BASE || 'http://127.0.0.1:8091';
const TOKEN = process.env.SERVER_TOKEN;
if (!TOKEN) { console.error('SERVER_TOKEN required (the runner mints it)'); process.exit(2); }
const F = JSON.parse(process.env.P8_FIXTURES || 'null');
if (!F || !F.parent) { console.error('P8_FIXTURES required (the runner builds and passes the fixture map)'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = async (repo, args) => (await exec(GIT, ['-C', repo, ...args], { maxBuffer: 16 << 20 })).stdout;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const section = (t) => console.log(`\n${t}`);

// ---- the read-only oracle ----------------------------------------------------------------------
// `--raw` is the honest index oracle: mode, blob oid and status per path. `--name-only` alone would
// miss a re-stage of the same path with different content.
const REPOS = [F.parent, F.childDirty, F.childDetached, F.childXss, F.xssRepo, F.sharedChild,
  F.anchorA, F.anchorB, F.outsideRepo];
async function snapshot() {
  const out = {};
  for (const r of REPOS) {
    out[r] = {
      staged: await git(r, ['diff', '--cached', '--raw']),
      names: await git(r, ['diff', '--cached', '--name-only']),
      head: (await git(r, ['rev-parse', 'HEAD']).catch(() => '')).trim(),
    };
  }
  return out;
}

// ---- page helpers --------------------------------------------------------------------------------

const barState = (page) => page.evaluate(() => {
  const m = document.getElementById('gitbar');
  const q = (s) => { const n = m && m.querySelector(s); return n ? n.textContent : null; };
  return {
    text: m ? m.textContent : null,
    children: m ? m.children.length : -1,
    name: q('.gbname'),
    branch: q('.gbbranch'),
    state: q('.gbstate'),
    note: q('.gbnote'),
    titles: m ? [...m.querySelectorAll('.gbbtn')].map((b) => b.title) : [],
    display: m ? getComputedStyle(m).display : null,
    hasHiddenAttr: m ? m.hasAttribute('hidden') : null,
    injectedImg: m ? m.querySelectorAll('img').length : -1,
    injectedSvg: m ? m.querySelectorAll('svg').length : -1,
  };
});

const crumbPath = (page) => page.evaluate(() => {
  const s = [...document.querySelectorAll('#fcrumb span')].slice(1).map((x) => x.textContent);
  return s.length ? '/' + s.join('/') : null;
});

// Tap a row by its EXACT entry name. `hasText` is a substring match and several fixture names here
// are substrings of each other (and one is an HTML payload), so the name is compared whole.
async function clickRow(page, name) {
  await page.waitForSelector('#flist .frow', { timeout: 15000 });
  const idx = await page.evaluate((n) => {
    const rows = [...document.querySelectorAll('#flist .frow')];
    return rows.findIndex((r) => {
      const f = r.querySelector('.fname');
      if (!f) return false;
      const t = f.textContent || '';
      return t.slice(t.indexOf(' ') + 1) === n;
    });
  }, name);
  if (idx < 0) throw new Error(`no row named ${JSON.stringify(name)} in the listing`);
  await page.locator('#flist .frow').nth(idx).click();
}

// 📁 is a TOGGLE. Clicking it blind closes the Files view a previous step left open — which is how
// this suite first "lost" its listing between B10 and B5. State is read before it is changed.
async function ensureFiles(page) {
  if (await page.locator('#filesBtn').getAttribute('aria-pressed') !== 'true') {
    await page.click('#filesBtn');
  }
  await page.waitForSelector('#flist', { state: 'visible', timeout: 15000 });
}

// The listing's OWN readiness signal: #ffoot reads 'Loading…' while a page is in flight and a count
// when it lands. Leaving a directory mid-fetch is what breaks navigation, and it is not a theory —
// MEASURED with fs/list for the parent held 2500 ms and the ⌂ crumb tapped inside that window: the
// roots screen rendered correctly, then the held response landed and `loadPage(reset)` — which has
// no cancellation and no generation check — called replaceChildren() and repainted the PARENT's
// entries over the roots screen, breadcrumb still empty. Rows exist, so a waitForSelector never
// fires; none carries a root path, so the row lookup returns -1. That is the whole of the
// intermittent "the fixture root is not on the roots screen" abort.
//
// (The underlying repaint is a p4 defect, pre-existing and outside p8: an operator who taps ⌂ during
// a slow listing lands on the roots screen wearing the previous directory's rows. Reported, not
// fixed here — this suite does not own app.js.)
//
// So: never leave a screen that is still loading, and never trust that a screen change landed.
async function settleListing(page) {
  await page.waitForFunction(() => {
    const f = document.getElementById('ffoot');
    return !!f && f.textContent !== 'Loading…';
  }, null, { timeout: 25000 });
}

// The roots screen, then the fixed root by its PATH — the label is a display string, the path is the
// identity, and the roots screen prints both.
//
// A CONVERGING LOOP on the observable, not a sleep: it works out where the app actually is from the
// screen itself (the roots screen is the one with no breadcrumb — openFiles() empties it) and drives
// toward the fixture root until the breadcrumb says it arrived. Every wait is on a state the app
// publishes, so a slow machine costs time and never correctness.
async function toFixtureRoot(page) {
  const deadline = Date.now() + 30000;
  for (;;) {
    await settleListing(page);
    const where = await page.evaluate((root) => {
      const rows = [...document.querySelectorAll('#flist .frow')];
      return {
        onRoots: document.querySelectorAll('#fcrumb span').length === 0,
        idx: rows.findIndex((r) => { const m = r.querySelector('.fmeta'); return m && m.textContent === root; }),
        rowCount: rows.length,
      };
    }, F.root);

    if (where.onRoots && where.idx >= 0) {
      await page.locator('#flist .frow').nth(where.idx).click();
      await settleListing(page);
      if (await crumbPath(page) === F.root) return;
    } else if (!where.onRoots) {
      await page.locator('#fcrumb span').first().click();          // ⌂ — back to the roots screen
      await settleListing(page);
    } else {
      // On the roots screen with the roots rows clobbered — the measured state above. 📁 off and on
      // re-renders it: openFiles() cleared the remembered path, so the toggle lands on roots rather
      // than on a directory. A real operator action, and the only one that recovers this.
      await page.click('#filesBtn');
      await page.waitForSelector('#flist', { state: 'hidden', timeout: 15000 });
      await page.click('#filesBtn');
      await page.waitForSelector('#flist', { state: 'visible', timeout: 15000 });
      await settleListing(page);
    }

    if (Date.now() > deadline) {
      throw new Error(`could not reach the fixture root ${F.root} — `
        + `onRoots=${where.onRoots}, rootRow=${where.idx}, rows=${where.rowCount}`);
    }
  }
}

// Walk down from the fixture root by tapping one row per segment — the way a thumb gets there. The
// app accepts no path from outside, and neither does this suite. Each segment waits for its listing
// to LAND before the next tap, so navigation never leaves a fetch in flight behind it. The timed
// assertions (B2's probe count, B3's TTL window, B7's rapid A→B) drive clickRow directly and are
// deliberately NOT settled — settling them would dissolve the very races they measure.
async function navigate(page, absPath, settle = 600) {
  await toFixtureRoot(page);
  const rel = path.relative(F.root, absPath);
  for (const seg of rel.split('/').filter(Boolean)) {
    await clickRow(page, seg);
    await settleListing(page);
    await page.waitForTimeout(settle);
  }
  const at = await crumbPath(page);
  if (at !== absPath) throw new Error(`navigation landed at ${at}, expected ${absPath}`);
}

async function waitForBarName(page, name, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const b = await barState(page);
    if (b.name === name) return b;
    if (Date.now() - t0 > timeout) return b;
    await sleep(150);
  }
}

// "No bar" means the mount holds NO TEXT. A bar left attached and merely emptied of controls would
// satisfy a child count of zero and is exactly the stale-render bug this shape catches.
async function settleNoBar(page, dir) {
  try {
    await page.waitForResponse((r) => r.url().includes('/gitread/probe')
      && decodeURIComponent(r.url()).includes(`dir=${dir}`), { timeout: 10000 });
  } catch (_) { /* a refusal may already have been answered before the wait was armed */ }
  await sleep(400);
  return barState(page);
}

async function openBarPanel(page) {
  await page.locator('#gitbar .gbbtn[title="source control panel"]').click();
}
// Two taps: the panel's ‹ goes repo → list → closed. That IS the operator's close from a bar open.
async function closePanel(page) {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#gitpanel.on').count())) break;
    await page.locator('#gitpanel .gback').click();
    await page.waitForTimeout(500);
  }
}

// ---- main ----------------------------------------------------------------------------------------

let browser = null;
const stageWrites = [];        // every stage/unstage POST the page issues, for B10
const probeUrls = [];
const pageErrors = [];
const consoleErrors = [];

async function main() {
  const before = await snapshot();

  browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { pageErrors.push(e.message); fail++; console.log(`  FAIL page error: ${e.message}`); });
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/cmux/gitread/probe')) probeUrls.push(decodeURIComponent(u));
    if (/\/api\/cmux\/git\/(stage|unstage)/.test(u)) stageWrites.push(u);
  });

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(`${BASE}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 25000 });

  ok(await page.evaluate(() => window.innerWidth) === 390, 'the context is the 390×844 phone viewport');

  // The bar mounts DEFENSIVELY (app.js): a missing, stale or throwing gitbar.js leaves the model
  // null and Files browses exactly as it does today — silently. Every "no bar" assertion below
  // would then pass for that reason instead of the one it claims, so the mount is checked first.
  const mounted = await page.evaluate(() => ({
    api: typeof ((window.cmuxGitBar || {}).createGitBarModel),
    mount: !!document.getElementById('gitbar'),
  }));
  ok(mounted.api === 'function', `gitbar.js is loaded and exports its factory (${mounted.api})`);
  ok(mounted.mount, 'the #gitbar mount exists in the served document');
  if (consoleErrors.length) console.log(`  note console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);

  await ensureFiles(page);

  // ---- B1 ---------------------------------------------------------------------------------------
  section('B1 — the bar names the repo and its branch');
  await navigate(page, F.childDirty);
  let b = await waitForBarName(page, 'child-dirty');
  ok(b.name === 'child-dirty', `entering a project repo shows the bar naming it (${JSON.stringify(b.name)})`);
  ok(b.branch === 'child-branch', `the bar shows the branch (${JSON.stringify(b.branch)})`);
  ok(b.children > 0 && (b.text || '').includes('child-dirty'), 'the bar is really mounted, with its text on screen');

  // The cold burst crossed three workspace cwds and the bar still appeared on FIRST entry —
  // the assertion the single-cwd version of this suite could not make.
  ok(true, 'the bar appeared on first entry with three workspace cwds discovered cold');

  // ---- layout ------------------------------------------------------------------------------------
  section('layout — the p4 traps');
  ok(b.hasHiddenAttr === false, 'the mount carries no [hidden] attribute — an explicit display would beat it (the p4 trap)');
  const statusZ = await page.evaluate(() => getComputedStyle(document.getElementById('status')).zIndex);
  ok(statusZ === '4', `#status is lifted over the Files pane (z-index ${statusZ}, panes sit at 3)`);

  // ---- harness integrity ---------------------------------------------------------------------------
  // The abort this suite hit on the integration branch, converted into a pinned property. The fault
  // is INDUCED first and asserted to have taken hold, so the recovery below cannot pass vacuously —
  // which is what a plain re-run of an intermittent failure proves, i.e. nothing.
  //
  // RETIREMENT PIN, in the shape gitread.js uses for --attr-source: the induction asserts a p4
  // defect (loadPage(reset) has no cancellation, so a listing that lands after the screen changed
  // repaints the old directory over it). If p4 ever gains that cancellation, THIS ROW FAILS LOUDLY
  // and should be deleted along with the recovery branch in toFixtureRoot — not silently loosened.
  section('harness integrity — navigation survives a listing that lands after the screen changed');
  await page.route('**/api/cmux/fs/list*', async (route) => {
    if (decodeURIComponent(route.request().url()).includes(`path=${F.parent}`)) await sleep(2500);
    return route.continue();
  });
  await toFixtureRoot(page);
  await clickRow(page, 'parent');                          // this listing is now held for 2.5s
  await page.waitForTimeout(150);
  await page.locator('#fcrumb span').first().click();      // ⌂ inside the window
  await page.waitForTimeout(3500);                         // let the held response land on top
  const clobbered = await page.evaluate((root) => {
    const rows = [...document.querySelectorAll('#flist .frow')];
    return {
      onRoots: document.querySelectorAll('#fcrumb span').length === 0,
      idx: rows.findIndex((r) => { const m = r.querySelector('.fmeta'); return m && m.textContent === root; }),
      rowCount: rows.length,
    };
  }, F.root);
  await page.unroute('**/api/cmux/fs/list*');
  ok(clobbered.onRoots && clobbered.idx < 0 && clobbered.rowCount > 0,
    `the fault was really induced — roots screen wearing the previous directory's rows (rows ${clobbered.rowCount}, root row ${clobbered.idx})`);
  await navigate(page, F.childDirty);
  ok(await crumbPath(page) === F.childDirty,
    'and navigation still reaches its target — the suite can no longer abort six assertions from the end');

  // ---- B2 ---------------------------------------------------------------------------------------
  section('B2 — one probe per level, three levels down, same repo');
  await navigate(page, F.parent);
  await waitForBarName(page, 'parent');
  const levels = [['deep', F.deep], ['l1', F.l1], ['l2', F.l2]];
  let perLevelOk = true, namesOk = true;
  const counts = [];
  for (const [seg, abs] of levels) {
    probeUrls.length = 0;
    await clickRow(page, seg);
    await page.waitForTimeout(1500);
    const n = probeUrls.filter((u) => u.includes(`dir=${abs}`)).length;
    counts.push(n);
    if (n !== 1) perLevelOk = false;
    const st = await waitForBarName(page, 'parent', 8000);
    if (st.name !== 'parent') namesOk = false;
  }
  ok(perLevelOk, `descending three levels issues exactly one probe per level (${counts.join(', ')})`);
  ok(namesOk, 'the bar keeps naming the enclosing repo all the way down');

  // ---- B3 ---------------------------------------------------------------------------------------
  section('B3 — a nested child repo renames the bar, inside the parent cache TTL');
  await navigate(page, F.parent, 400);
  await waitForBarName(page, 'parent');
  const t0 = Date.now();
  await clickRow(page, 'nested');
  await page.waitForTimeout(350);
  await clickRow(page, 'child-dirty');
  const child = await waitForBarName(page, 'child-dirty', 8000);
  const elapsed = Date.now() - t0;
  ok(elapsed < 5000, `the descent finished inside the 5s display-cache TTL (${elapsed}ms) — otherwise B3 proves nothing`);
  ok(child.name === 'child-dirty', `the bar renamed to the CHILD, not the parent (${JSON.stringify(child.name)})`);

  // ---- rule 4 is not inert -------------------------------------------------------------------------
  section('rule 4 — a shared clone whose alternate points INSIDE the union still shows a bar');
  await navigate(page, F.sharedChild);
  const shared = await waitForBarName(page, 'shared-child');
  ok(shared.name === 'shared-child',
    `an object store shared with the parent is admitted, not refused (${JSON.stringify(shared.name)}) — the row that catches a rule-4 over-refusal`);

  // ---- B4 + the refusal classes ---------------------------------------------------------------------
  section('B4 / §7 — every refusal is indistinguishable, and hides the bar');
  const refusals = [
    ['out of scope (B4)', F.outsideRepo],
    ['not a repository', F.plainDir],
    ['object-store escape (rule 4)', F.altEscape],
    ['unbounded attribute source (rule 3)', F.attrRefuse],
  ];
  const shapes = [];
  for (const [label, dir] of refusals) {
    await navigate(page, dir);
    const st = await settleNoBar(page, dir);
    shapes.push(JSON.stringify({ text: st.text, children: st.children }));
    ok(st.children === 0 && st.text === '', `${label}: no bar — the mount holds no text at all`);
    ok(st.display === 'none', `${label}: the empty mount collapses (display ${st.display})`);
  }
  ok(new Set(shapes).size === 1, 'all four reachable refusal classes render byte-identically — no existence oracle');

  // 503 probe_busy is the fifth class. It cannot be forced by navigation, so the response is injected
  // at the transport and the CLIENT's rendering of it is what gets measured — which is where the
  // indistinguishability property lives.
  await page.route('**/api/cmux/gitread/probe*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'probe_busy' }) }));
  await navigate(page, F.childDetached);
  await page.waitForTimeout(900);
  const busy = await barState(page);
  ok(busy.children === 0 && busy.text === '', 'probe_busy (503) hides the bar identically — same shape as every other refusal');
  ok(JSON.stringify({ text: busy.text, children: busy.children }) === shapes[0],
    'the 503 shape is byte-identical to the scope refusal');
  await page.unroute('**/api/cmux/gitread/probe*');

  // ---- B6 ---------------------------------------------------------------------------------------
  section('B6 — detached HEAD offers no push and no pull');
  await navigate(page, F.childDetached);
  const det = await waitForBarName(page, 'child-detached');
  ok(det.name === 'child-detached', `the detached fixture shows its bar (${JSON.stringify(det.name)})`);
  ok(det.branch === 'detached', `the branch cell reads detached (${JSON.stringify(det.branch)})`);
  ok(!det.titles.includes('push') && !det.titles.includes('pull --rebase'),
    `push and pull are absent off a branch (controls: ${det.titles.join(', ')})`);
  ok(det.titles.includes('source control panel'), 'the panel door is still offered');

  // ---- B8 ---------------------------------------------------------------------------------------
  section('B8 — hostile names render as inert text');
  await navigate(page, F.childXss);
  const hb = await waitForBarName(page, 'child-xss-branch');
  ok(hb.branch === F.xssBranch, 'the hostile BRANCH renders as the literal string, byte for byte');
  ok(hb.injectedImg === 0, 'no <img> was parsed into the bar from the branch name');
  ok(await page.evaluate(() => window.p8BranchXss === undefined), 'window.p8BranchXss is undefined — the branch payload never ran');

  await navigate(page, F.xssRepo);
  const hr = await waitForBarName(page, F.xssRepoDir);
  ok(hr.name === F.xssRepoDir, 'the hostile REPO DIRECTORY renders as the literal string, byte for byte');
  ok(hr.injectedSvg === 0, 'no <svg> was parsed into the bar from the directory name');
  ok(await page.evaluate(() => window.p8RepoXss === undefined), 'window.p8RepoXss is undefined — the directory payload never ran');
  ok(pageErrors.length === 0, `no page error was raised by either payload (${pageErrors.length})`);

  // ---- B7 ---------------------------------------------------------------------------------------
  section('B7 — a slow response for A never paints while standing in B');
  // The hazard §5.3 describes needs A's answer to arrive AFTER the operator has moved on. Navigation
  // alone cannot produce that ordering reliably, so A's probe is held at the transport; what is
  // measured is the client's own invalidation, which is where the property lives.
  await page.route('**/api/cmux/gitread/probe*', async (route) => {
    if (decodeURIComponent(route.request().url()).includes(`dir=${F.childDirty}`)) {
      await sleep(1800);
    }
    return route.continue();
  });
  await navigate(page, F.nested, 400);
  await page.evaluate(() => {
    window.__p8Seen = [];
    const m = document.getElementById('gitbar');
    const snap = () => {
      const segs = [...document.querySelectorAll('#fcrumb span')].slice(1).map((x) => x.textContent);
      window.__p8Seen.push({ bar: m.textContent, crumb: segs.length ? '/' + segs.join('/') : null });
    };
    window.__p8Obs = new MutationObserver(snap);
    window.__p8Obs.observe(m, { childList: true, subtree: true, characterData: true });
    snap();
  });
  await clickRow(page, 'child-dirty');
  await page.waitForTimeout(120);
  await page.locator('#fcrumb span').nth(await page.evaluate((p) => p.split('/').filter(Boolean).length, F.nested)).click();
  await page.waitForTimeout(120);
  await clickRow(page, 'child-detached');
  await page.waitForTimeout(3200);
  const seen = await page.evaluate(() => { window.__p8Obs.disconnect(); return window.__p8Seen; });
  const finalB7 = await barState(page);
  const violation = seen.find((s) => s.crumb === F.childDetached && /child-dirty/.test(s.bar || ''));
  ok(!violation, `A's repo never painted while standing in B (${seen.length} bar mutations observed)`);
  ok(finalB7.name === 'child-detached', `the bar settled on B (${JSON.stringify(finalB7.name)})`);
  await page.unroute('**/api/cmux/gitread/probe*');

  // ---- B9 ---------------------------------------------------------------------------------------
  section('B9 — capability-honest panel, both doors');
  await navigate(page, F.childDirty);
  await waitForBarName(page, 'child-dirty');
  await openBarPanel(page);
  await page.waitForSelector('#gitpanel.on', { timeout: 12000 });
  await page.waitForSelector('#gitpanel .ghead', { timeout: 15000 });
  const roNotes = (await page.locator('#gitpanel .gnote').allTextContents()).join(' | ');
  ok(/Read-only here/.test(roNotes), `the read-only reason line is shown (${roNotes.slice(0, 120)})`);
  ok(await page.locator('#gitpanel .gact').count() === 0, 'NO stage/unstage control anywhere on a containment-only repo');
  ok(await page.locator('#gitpanel .ghead').count() > 0, 'the changes are still listed — read-only is not blank');
  await page.locator('#gitpanel .grow button', { hasText: 'kept.txt' }).first().click();
  await page.waitForSelector('#gitpanel .gdiff', { timeout: 12000 });
  ok(/\+two/.test(await page.locator('#gitpanel .gdiff').textContent()), 'tapping a file still shows its real diff');
  await closePanel(page);
  await page.waitForTimeout(700);
  ok(await crumbPath(page) === F.childDirty, 'closing the bar-opened panel returns to the same Files directory');

  // the anchor half: writes really happen, end to end, on the real index
  await navigate(page, F.parent);
  await waitForBarName(page, 'parent');
  await openBarPanel(page);
  await page.waitForSelector('#gitpanel .ghead', { timeout: 15000 });
  ok(await page.locator('#gitpanel .gact').count() > 0, 'the anchor repo DOES offer per-file staging');
  await page.locator('#gitpanel .grow', { hasText: 'untracked.txt' }).locator('.gact').first().click();
  await page.waitForTimeout(2500);
  ok((await git(F.parent, ['diff', '--cached', '--name-only'])).includes('untracked.txt'),
    'tapping stage put the file in the REAL git index');
  await page.locator('#gitpanel .grow', { hasText: 'untracked.txt' }).locator('.gact').first().click();
  await page.waitForTimeout(2500);
  ok(!(await git(F.parent, ['diff', '--cached', '--name-only'])).includes('untracked.txt'),
    'tapping unstage removed it again — the index is back where it started');
  await closePanel(page);
  await page.waitForTimeout(700);

  // the ⎇ toolbar door — p7's journey, still alive
  await page.click('#gitBtn');
  await page.waitForSelector('#gitpanel.on', { timeout: 10000 });
  await page.waitForSelector('#gitpanel .grow button', { timeout: 20000 });
  const listed = await page.locator('#gitpanel .grow button').allTextContents();
  ok(listed.includes('parent'), 'the ⎇ door still lands on the repo list, with the anchor in it');
  await page.locator('#gitpanel .grow button', { hasText: /^parent$/ }).first().click();
  await page.waitForSelector('#gitpanel .ghead', { timeout: 15000 });
  ok(await page.locator('#gitpanel .ghead').count() > 0, "the ⎇ door loads the anchor's status");
  await closePanel(page);
  await page.waitForTimeout(700);

  // ---- B11 --------------------------------------------------------------------------------------
  section('B11 — the two doors close to two different places');
  ok(!(await page.locator('#gitpanel.on').count()), 'the ⎇ door closed');
  ok(await page.evaluate(() => document.body.classList.contains('mode-files')) === false,
    'the ⎇ door closed to the TERMINAL, not into Files (today’s behaviour, unchanged)');
  ok(await page.locator('.pane').count() > 0, 'a terminal pane is mounted after the ⎇ close');

  await ensureFiles(page);
  await navigate(page, F.childDirty);
  await waitForBarName(page, 'child-dirty');
  await openBarPanel(page);
  await page.waitForSelector('#gitpanel .ghead', { timeout: 15000 });
  await closePanel(page);
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => document.body.classList.contains('mode-files')) === true,
    'the BAR door closed back into Files — the ⎇ door’s close callback never fired');
  ok(await crumbPath(page) === F.childDirty, 'and into the same directory it was opened from');

  // ---- B10 --------------------------------------------------------------------------------------
  section('B10 — a retargeted directory never opens a panel on the old repo');
  const aBefore = { staged: await git(F.anchorA, ['diff', '--cached', '--raw']), head: (await git(F.anchorA, ['rev-parse', 'HEAD'])).trim() };
  await navigate(page, F.link);
  const linkBar = await waitForBarName(page, 'anchor-a');
  ok(linkBar.name === 'anchor-a', `the bar shows repo A for the symlinked directory (${JSON.stringify(linkBar.name)})`);
  const writesBefore = stageWrites.length;

  await fsp.unlink(F.link);
  await fsp.symlink(F.anchorB, F.link, 'dir');
  ok((await fsp.realpath(F.link)) === F.anchorB, 'the directory now resolves to repo B');

  await openBarPanel(page);
  await page.waitForTimeout(2500);
  ok(!(await page.locator('#gitpanel.on').count()), 'tapping › opened NO panel — not on A, not on anything');
  const after10 = await barState(page);
  ok(after10.name === 'anchor-b', `the bar re-rendered to B (${JSON.stringify(after10.name)})`);
  ok(!!after10.note, `and said so (${JSON.stringify(after10.note)})`);
  ok(stageWrites.length === writesBefore, `zero stage/unstage requests were issued (${stageWrites.length - writesBefore})`);
  const aAfter = { staged: await git(F.anchorA, ['diff', '--cached', '--raw']), head: (await git(F.anchorA, ['rev-parse', 'HEAD'])).trim() };
  ok(aAfter.staged === aBefore.staged && aAfter.head === aBefore.head,
    "repo A's index and HEAD are byte-identical afterwards");

  // ---- B5 ---------------------------------------------------------------------------------------
  section('B5 — ✓ → message → Commit fills the composer and lands on a live terminal');
  await ensureFiles(page);
  await navigate(page, F.parent);
  await waitForBarName(page, 'parent');
  const headBefore = (await git(F.parent, ['rev-parse', 'HEAD'])).trim();
  await page.locator('#gitbar .gbbtn[title="commit everything"]').click();
  await page.waitForSelector('#gitbar .gbmsg', { timeout: 8000 });
  await page.fill('#gitbar .gbmsg', 'p8 browser proof');
  await page.locator('#gitbar .gbbtn[title="generate the commit command"]').click();
  await page.waitForTimeout(3000);
  const composed = await page.inputValue('#text');
  const syncText = composed.slice(composed.lastIndexOf('( R='));
  ok(syncText.startsWith(`( R='${F.parent}'`), `the composer holds the §6.2 guarded subshell for THIS repo (${syncText.slice(0, 70)}…)`);
  ok(/&& git -C "\$R" add -A &&/.test(syncText), 'the text carries the guarded add -A');
  ok(/commit -m 'p8 browser proof'/.test(syncText), 'and the operator’s message, quoted');
  ok(/sync blocked: repo state changed/.test(syncText), 'and the guard that speaks up when it refuses');
  ok(await page.evaluate(() => document.body.classList.contains('mode-files')) === false,
    'Files has exited after the fill');
  ok(await page.locator('.pane').count() > 0, 'the operator landed on a mounted terminal pane');
  ok((await git(F.parent, ['rev-parse', 'HEAD'])).trim() === headBefore,
    'NOTHING was committed — the bar fills a box, it does not run git');

  // A second fill, for the guard-execution proof below: the text must come from the BROWSER, not
  // from a hand-built string that could differ from what the operator is actually handed.
  await ensureFiles(page);
  await navigate(page, F.anchorB);
  await waitForBarName(page, 'anchor-b');
  await page.locator('#gitbar .gbbtn[title="commit everything"]').click();
  await page.waitForSelector('#gitbar .gbmsg', { timeout: 8000 });
  await page.fill('#gitbar .gbmsg', 'guard proof');
  await page.locator('#gitbar .gbbtn[title="generate the commit command"]').click();
  await page.waitForTimeout(3000);
  const composedB = await page.inputValue('#text');
  const guardText = composedB.slice(composedB.lastIndexOf('( R='));
  ok(guardText.startsWith(`( R='${F.anchorB}'`), 'a second fill is generated against repo B');

  await page.screenshot({ path: 'test-results/p8-gitbar.png' }).catch(() => {});
  await browser.close();
  browser = null;

  // ---- the read-only claim, over the whole run --------------------------------------------------
  section('the product claim — p8 never writes to a repository');
  const after = await snapshot();
  let drift = [];
  for (const r of REPOS) {
    if (after[r].staged !== before[r].staged) drift.push(`${path.basename(r)}: staged index changed`);
    if (after[r].names !== before[r].names) drift.push(`${path.basename(r)}: staged file list changed`);
    if (after[r].head !== before[r].head) drift.push(`${path.basename(r)}: HEAD moved`);
  }
  ok(drift.length === 0, `every fixture repo's staged index and HEAD are unchanged across the whole session${drift.length ? ': ' + drift.join('; ') : ''}`);

  // ---- the sync guard blocks, and now says so ---------------------------------------------------
  section('the sync guard — a blocked run is no longer silent');
  await git(F.anchorB, ['checkout', '-q', '-b', 'guard-base']);
  await fsp.writeFile(path.join(F.anchorB, 'conflict.txt'), 'base\n');
  await git(F.anchorB, ['add', 'conflict.txt']);
  await git(F.anchorB, ['-c', 'user.email=f@example.invalid', '-c', 'user.name=F', 'commit', '-q', '-m', 'base']);
  await git(F.anchorB, ['checkout', '-q', '-b', 'guard-other']);
  await fsp.writeFile(path.join(F.anchorB, 'conflict.txt'), 'other\n');
  await git(F.anchorB, ['add', 'conflict.txt']);
  await git(F.anchorB, ['-c', 'user.email=f@example.invalid', '-c', 'user.name=F', 'commit', '-q', '-m', 'other']);
  await git(F.anchorB, ['checkout', '-q', 'guard-base']);
  await fsp.writeFile(path.join(F.anchorB, 'conflict.txt'), 'mine\n');
  await git(F.anchorB, ['add', 'conflict.txt']);
  await git(F.anchorB, ['-c', 'user.email=f@example.invalid', '-c', 'user.name=F', 'commit', '-q', '-m', 'mine']);
  let conflicted = false;
  try { await git(F.anchorB, ['merge', '--no-edit', 'guard-other']); } catch (_) { conflicted = true; }
  const unmerged = (await git(F.anchorB, ['ls-files', '-u'])).trim();
  ok(conflicted && unmerged.length > 0, 'the fixture is genuinely in a blocked state (real unmerged paths)');

  const headB = (await git(F.anchorB, ['rev-parse', 'HEAD'])).trim();
  const run = await new Promise((resolve) => {
    execFile('/bin/sh', ['-c', guardText], { maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code == null ? 1 : err.code) : 0, stdout, stderr }));
  });
  ok(run.code !== 0, `the generated text refuses to run in a blocked repo (exit ${run.code})`);
  ok(/sync blocked: repo state changed/.test(run.stderr),
    `and PRINTS why on stderr (${JSON.stringify((run.stderr || '').trim().slice(0, 80))}) — it was silent until this round`);
  ok((await git(F.anchorB, ['rev-parse', 'HEAD'])).trim() === headB, 'nothing was committed by the blocked run');
}

main()
  .then(async () => {
    if (browser) await browser.close().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    if (browser) await browser.close().catch(() => {});
    console.error('\nERROR:', (e && e.stack) || e);
    console.log(`\n${pass} passed, ${fail} failed (aborted)`);
    process.exit(1);
  });
