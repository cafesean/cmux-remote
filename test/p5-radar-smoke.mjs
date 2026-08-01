// Playwright smoke for the p5 Radar tab (S-007) — against the MOUNTED UI.
//
// Playwright is BORROWED, not depended on: this repo stays npm-install-free, so there is no
// node_modules here to resolve it from. Point PLAYWRIGHT_DIR at any Playwright install you have:
//
//   PLAYWRIGHT_DIR=/path/to/workspace/app-web/node_modules/playwright/index.mjs \
//     node test/p5-radar-smoke.mjs
//
// WHAT IS REAL HERE AND WHAT IS NOT. The page is real: public/index.html, public/app.js and
// public/radar.js are served off disk and boot exactly as they do in production, through the same
// Bearer gate. The API is a harness, because the things S-007 has to prove — a 401 mid-session, a
// dead network, a 422 from a write, a fixture swapped underneath a live page — are precisely the
// states a healthy server will not produce on demand. The server side of those same routes is
// covered separately and for real in test/radar-server.test.js.
//
// The load-bearing assertions are the COLOUR LAW ones. Green may only ever mean action-or-live and
// red may only ever mean urgent; a done ladder segment that drifts to green would make a finished
// stage look like a live one, which is the exact failure the approved mockup exists to prevent. So
// the test walks every rendered element, collects everything painted in either colour, and fails on
// anything outside the allowed set — rather than spot-checking the four elements we remembered.
import { readFileSync, mkdtempSync } from 'fs';
import { createServer } from 'http';
import { extname, join } from 'path';
import { tmpdir } from 'os';

async function loadPlaywright() {
  const tried = [];
  if (process.env.PLAYWRIGHT_DIR) {
    tried.push(process.env.PLAYWRIGHT_DIR);
    try { return await import(process.env.PLAYWRIGHT_DIR); } catch (_) { /* fall through */ }
  }
  tried.push('playwright (bare specifier)');
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  console.error(
    'FAIL: could not load Playwright.\n' +
    '  Tried: ' + tried.join(', ') + '\n' +
    '  Set PLAYWRIGHT_DIR to a playwright entry point, e.g.\n' +
    '    PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p5-radar-smoke.mjs');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PUBLIC = join(REPO, 'public');
const FIXTURES = join(REPO, 'radar', 'fixtures');
const TOKEN = 'smoke-token';
const SHOTS = process.env.SHOT_DIR || mkdtempSync(join(tmpdir(), 'p5-radar-shots-'));

const ACCENT = 'rgb(46, 230, 160)';    // --raccent #2ee6a0 — action / live ONLY
const ALERT = 'rgb(255, 93, 100)';     // --ralert  #ff5d64 — urgent ONLY

const load = (n) => JSON.parse(readFileSync(join(FIXTURES, n), 'utf8'));
const FULL = load('state.full.json');
const DEGRADED = load('state.degraded.json');
const EMPTY = load('state.empty.json');
const OVERFLOW = load('state.overflow.json');

let failed = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || detail === undefined ? '' : '\n        ' + detail));
  if (!ok) failed++;
}
const eq = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---- harness server ------------------------------------------------------------------------------
// Real static files, stubbed API, and one mutable knob per behaviour the test needs to force.

const CT = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const TREE = {
  'machine-a': [{
    ref: 'w0', id: 'ws-a', title: 'workspace', selected: true,
    tabs: [{ id: 'tab-a-1', ref: 'w0/t1', title: 'app-web', type: 'terminal', selected: true }],
  }],
  // The tab the full fixture's blocked session names. Jump has to land exactly here.
  'machine-b': [{
    ref: 'w1', id: 'ws-b', title: 'p61', selected: true,
    tabs: [{ id: 'f2b0a1c4-0000-4000-8000-000000000001', ref: 'w1/t3', title: 'p61 session', type: 'terminal', selected: true }],
  }],
};

const ctl = {
  state: FULL,
  stateMode: 'ok',      // ok | 401 | 500 | 503 | dead
  postMode: 'ok',       // ok | 422
  postDelayMs: 0,
  posts: [],
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // static: the REAL page
  const staticFile = p === '/' || p === '/index.html' ? 'index.html'
    : ['/app.js', '/radar.js', '/sw.js', '/manifest.webmanifest', '/icon-180.png'].includes(p) ? p.slice(1)
      : p.startsWith('/vendor/') ? p.slice(1) : null;
  if (staticFile) {
    try {
      const data = readFileSync(join(PUBLIC, staticFile));
      res.writeHead(200, { 'content-type': CT[extname(staticFile)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(data);
    } catch (_) { res.writeHead(404); return res.end('nope'); }
  }

  // Same gate as the real server: a Bearer header, or ?token= for EventSource (which cannot set
  // headers). And radar's extra rule on top of it — radar refuses ?token= outright, because none of
  // its routes is an EventSource and a token in a URL lands in history and every access log.
  const auth = req.headers.authorization || '';
  const okHeader = auth === 'Bearer ' + TOKEN;
  const okQuery = u.searchParams.get('token') === TOKEN;
  if (p.startsWith('/api/radar/')) {
    if (u.searchParams.has('token')) return sendJson(res, 401, { error: 'token_in_url' });
    if (!okHeader) return sendJson(res, 401, { error: 'unauthorized' });
  } else if (!okHeader && !okQuery) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (p === '/api/cmux/bootstrap') {
    return sendJson(res, 200, {
      machines: [{ id: 'machine-a', label: 'machine-a' }, { id: 'machine-b', label: 'machine-b' }],
      machine: 'machine-a', workspaces: TREE['machine-a'],
    });
  }
  if (p === '/api/cmux/tree') return sendJson(res, 200, { workspaces: TREE[u.searchParams.get('machine')] || [] });
  if (p === '/api/cmux/grid') return sendJson(res, 200, { same: 1 });
  if (p === '/api/cmux/grid-stream') { res.writeHead(404); return res.end(); }

  if (p === '/api/radar/state' && req.method === 'GET') {
    if (ctl.stateMode === 'dead') { req.destroy(); return; }
    if (ctl.stateMode === '401') return sendJson(res, 401, { error: 'unauthorized' });
    if (ctl.stateMode === '500') return sendJson(res, 500, { error: 'radar_error', message: 'collector exploded' });
    if (ctl.stateMode === '503') return sendJson(res, 503, { error: 'no_snapshot', message: 'radar has not published a snapshot yet' });
    return sendJson(res, 200, ctl.state);
  }
  if (p.startsWith('/api/radar/') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (_) {}
      ctl.posts.push({ path: p, body: parsed });
      if (ctl.postMode === '422') return sendJson(res, 422, { error: 'unprocessable', message: 'unknown repo app-web' });
      sendJson(res, 200, { ok: true });
    }, ctl.postDelayMs));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- page helpers --------------------------------------------------------------------------------

const browser = await chromium.launch();

async function newPage(opts = {}) {
  const context = await browser.newContext(Object.assign({ viewport: { width: 900, height: 1000 } }, opts));
  const page = await context.newPage();
  // Script errors only. "Failed to load resource" is the BROWSER reporting an HTTP status, and
  // several of the tests below deliberately serve 401/500/503/dead — counting those would make the
  // failure-path tests unable to pass by construction.
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    errors.push('console: ' + t);
  });
  await page.addInitScript((t) => { try { localStorage.setItem('cmux_token', t); } catch (_) {} }, TOKEN);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  // The radar chip lives in the TOOLBAR beside Files, not the tab strip: after the multi-pane
  // merge the strip is one-pane-only, and radar is not workspace-scoped, so a strip chip would
  // vanish in split view.
  await page.waitForSelector('#radarBtn', { timeout: 8000 });
  return { page, context, errors };
}

const openRadar = async (page) => {
  await page.click('#radarBtn');
  await page.waitForSelector('body.mode-radar #radar .head', { timeout: 5000 });
  await page.waitForTimeout(250);
};
// The same function the 60s interval calls — invoking it directly is how a one-minute cadence gets
// tested in a few hundred milliseconds without faking a clock.
const forceTick = async (page) => {
  await page.evaluate(() => window.cmuxRadar.instance.refresh());
  await page.waitForTimeout(150);
};
const texts = (page, sel) => page.$$eval(sel, (ns) => ns.map((n) => n.textContent.trim()));
// The folds are TOGGLES with a persisted default, so a blind click is as likely to close the
// section as to open it — the same trap the p4 Files smoke documents for the 📁 control.
async function ensureFold(page, id, want) {
  const sel = `#radar [data-fold="${id}"]`;
  const btn = await page.$(sel);
  if (!btn) return false;
  if ((await btn.getAttribute('aria-expanded')) !== String(want)) {
    await btn.click();
    await page.waitForTimeout(200);
  }
  return true;
}
// Same trap for the queue overflow: it is one button that both expands and collapses, and its
// state persists across a re-render.
async function ensureQueue(page, want) {
  const btn = await page.$('#radar .q-more');
  if (!btn) return false;
  const expanded = (await btn.textContent()).trim().startsWith('−');
  if (expanded !== want) { await btn.click(); await page.waitForTimeout(250); }
  return true;
}
const shot = async (page, name) => { await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); };

// Collect every element painted in a given colour, as `tag.class` — the colour-law oracle.
async function paintedWith(page, colour) {
  return page.evaluate((c) => {
    const hits = [];
    document.querySelectorAll('#radar *').forEach((n) => {
      const s = getComputedStyle(n);
      const where = [];
      if (s.color === c) where.push('color');
      if (s.backgroundColor === c) where.push('bg');
      if (s.borderTopColor === c || s.borderLeftColor === c) where.push('border');
      if (where.length) {
        hits.push((n.tagName.toLowerCase() + '.' + (n.className || '').toString().trim().replace(/\s+/g, '.')).replace(/\.$/, '') + '[' + where.join(',') + ']');
      }
    });
    return hits;
  }, colour);
}

// =================================================================================================
console.log('\n── full fixture: zones, colour law, queue cap ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  eq('hero renders the NOW label', (await texts(page, '#radar .now-label'))[0], 'NOW');
  const heroTitle = (await texts(page, '#radar .hero-title'))[0];
  check('hero is the blocked session (attention[0], sorted by the spec)', heroTitle === 'Answer the PROJ-108 session', heroTitle);
  const heroMeta = (await texts(page, '#radar .hero-meta'))[0];
  check('hero meta carries wait, notification type, machine and the cache deadline',
    /waiting/.test(heroMeta) && /permission_prompt/.test(heroMeta) && /machine-b/.test(heroMeta)
    && /(cache dies in ≈\d+ min|cache window has closed)/.test(heroMeta), heroMeta);

  // Naming an unmapped blocked session. Observed on the real board: hook events without a usable
  // cwd leave repo and epic null, and the hero read "Answer the cccea42e session" — a hex prefix on
  // the one row whose whole job is to say where to go, with no Jump button beside it either.
  {
    const unmapped = JSON.parse(JSON.stringify(FULL));
    unmapped.attention[0].epic = null;
    unmapped.sessions[0].epic = null;
    unmapped.sessions[0].repo = null;
    unmapped.sessions[0].transcriptPath = '$HOME/.claude/projects/-Users-you-code-workspace/cccea42e-9636-4152-9236-c391690f197a.jsonl';
    const prev = ctl.state; ctl.state = unmapped;
    await forceTick(page);
    const t = (await texts(page, '#radar .hero-title'))[0];
    const m = (await texts(page, '#radar .hero-meta'))[0];
    eq('an unmapped blocked session is named by its project directory, not a hex prefix',
      t, 'Answer the workspace session');
    check('and the short session id moves into the meta so two sessions stay distinguishable',
      /9c7fd9a7/.test(m), m);

    // last resort only: no epic, no repo, no transcript -> the prefix is still better than nothing
    unmapped.sessions[0].transcriptPath = null;
    ctl.state = JSON.parse(JSON.stringify(unmapped));
    await forceTick(page);
    eq('with nothing at all to go on it falls back to the id, never to a guess',
      (await texts(page, '#radar .hero-title'))[0], 'Answer the 9c7fd9a7 session');
    ctl.state = prev; await forceTick(page);
  }

  // The approximation marker is not decoration — cacheExpiresAt is last-submit + 60min, and §M2
  // requires it to render as the estimate it is. Asserted on a synthetic future deadline so the
  // fixture's own age cannot make the check vacuous.
  {
    const live = JSON.parse(JSON.stringify(FULL));
    live.attention[0].deadline = new Date(Date.now() + 17 * 60000).toISOString();
    const prev = ctl.state; ctl.state = live;
    await forceTick(page);
    const m = (await texts(page, '#radar .hero-meta'))[0];
    check('a live deadline renders with the ≈ the spec requires', /cache dies in ≈1[67] min/.test(m), m);
    ctl.state = prev; await forceTick(page);
  }

  // queue: 8 remaining items, 4 shown, one overflow control
  eq('queue shows exactly 4 rows', (await page.$$('#radar .q-row')).length, 4);
  eq('overflow control counts the rest', (await texts(page, '#radar .q-more'))[0], '+4 more');
  await page.click('#radar .q-more');
  await page.waitForTimeout(150);
  eq('expanding shows every queued item', (await page.$$('#radar .q-row')).length, 8);
  eq('expanded control collapses again', (await texts(page, '#radar .q-more'))[0], '− collapse');
  await page.click('#radar .q-more');
  await page.waitForTimeout(150);
  eq('collapse returns to 4', (await page.$$('#radar .q-row')).length, 4);

  // ---- COLOUR LAW ----
  const green = await paintedWith(page, ACCENT);
  const red = await paintedWith(page, ALERT);
  const greenOk = green.every((g) => /^(div\.scope|span\.t|button\.jump|span\.when\.live)\b/.test(g));
  check('GREEN appears ONLY on the sweep, the wordmark, Jump and `live now`', greenOk, green.join('\n        '));
  const redOk = red.every((r) => /^(span\.now-label|div\.hero|b|span\.step\.bad)\b/.test(r));
  check('RED appears ONLY on the NOW label, the hero frame, the deadline and a violation cell', redOk, red.join('\n        '));

  await ensureFold(page, 'moving', true);
  const doneCell = await page.$eval('#radar .step.done', (n) => getComputedStyle(n).backgroundColor);
  check('a DONE ladder segment is neutral — never green, never red', doneCell !== ACCENT && doneCell !== ALERT, doneCell);
  const stateShapes = await page.$$eval('#radar .ladder .step', (ns) => {
    const out = {};
    ns.forEach((n) => {
      const s = getComputedStyle(n);
      out[n.dataset.state] = s.backgroundColor + '|' + s.borderTopColor + '|' + (s.backgroundImage === 'none' ? 'flat' : 'hatch');
    });
    return out;
  });
  const distinct = new Set(Object.values(stateShapes));
  check('done / current / todo / unknown / violation are each visually distinct',
    distinct.size === Object.keys(stateShapes).length, JSON.stringify(stateShapes, null, 2));
  check('unknown is hatched, so it can never read as progress or as done',
    !stateShapes.unknown || /hatch/.test(stateShapes.unknown), JSON.stringify(stateShapes.unknown));

  // An epic known only to Jira has lastActivityAt = the epoch sentinel. On the real board that
  // rendered as "20665d" — a fabricated measurement. It must read as absent, not as 56 years.
  {
    const jiraOnly = JSON.parse(JSON.stringify(FULL));
    jiraOnly.epics[0].lastActivityAt = new Date(0).toISOString();
    jiraOnly.epics[0].signals = ['jira-in-progress'];
    const prev = ctl.state; ctl.state = jiraOnly;
    await forceTick(page);
    await ensureFold(page, 'moving', true);
    const when = await page.$eval('#radar .er[data-epic="PROJ-108"] .when', (n) => n.textContent.trim());
    eq('an epoch lastActivityAt renders as absent, never as an age', when, '—');
    ctl.state = prev; await forceTick(page); await ensureFold(page, 'moving', true);
  }

  // A hatched deploy cell must be explainable. mod-deploy keeps adding reasons a probe cannot be
  // trusted (branchMismatch, deployAgeStale, an unreachable sha); they belong in the tooltip, not
  // as more badges on a surface that was approved for being calm.
  {
    const withReasons = JSON.parse(JSON.stringify(FULL));
    const dev = withReasons.repos['app-web'].deploy.dev;
    dev.branchMismatch = true;
    dev.shaKnownLocally = false;
    dev.deployAgeStale = true;
    dev.ageDays = 143;
    const prev = ctl.state; ctl.state = withReasons;
    await forceTick(page);
    await ensureFold(page, 'moving', true);
    const tip = await page.$eval('#radar .er[data-epic="PROJ-108"] .step[data-cell="deployedDev"]', (n) => n.title);
    check('a deploy cell explains itself in the tooltip, per repo',
      /app-web:/.test(tip) && /different branch/.test(tip) && /not reachable locally/.test(tip) && /143d ago/.test(tip),
      JSON.stringify(tip));
    check('and the cell itself stays one plain rectangle — no extra chrome',
      (await page.$$('#radar .er[data-epic="PROJ-108"] .step[data-cell="deployedDev"] *')).length === 0);
    ctl.state = prev; await forceTick(page); await ensureFold(page, 'moving', true);
  }

  // Cleanup output is COMMANDS FOR THE HUMAN. A dirty worktree gets a warning and no command —
  // and it has to be visibly a different group, or the header count reads as wrong.
  await ensureFold(page, 'worktrees', true);
  const cmds = await texts(page, '#radar .wt:not(.dirty):not(.sub) code');
  check('a stale worktree offers an exact removal command, for the human to run',
    cmds.length === 1 && /^\/usr\/bin\/git -C .* worktree remove /.test(cmds[0]), JSON.stringify(cmds));
  check('a dirty worktree gets a labelled warning group and NO command',
    /not cleanup-ready, no command offered/.test((await texts(page, '#radar .wt.sub code'))[0] || '')
    && (await page.$$('#radar .wt.dirty .q-act')).length === 0,
    JSON.stringify(await texts(page, '#radar .wt.sub code')));
  eq('the fold count counts only what is actually removable',
    (await page.$eval('#radar [data-fold="worktrees"] .n', (n) => n.textContent)), '1');
  await ensureFold(page, 'worktrees', false);

  await shot(page, '01-full-fixture');
  check('no page errors on the full fixture', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── overflow fixture: 125 spec-orphans (defect 3) ──');
// =================================================================================================
{
  ctl.state = OVERFLOW; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  eq('the board really is at the real-world scale', OVERFLOW.attention.length, 132);
  const hero = (await texts(page, '#radar .hero-title'))[0];
  check('the hero is still the ONE mergeable, not one of 125 spec-orphans',
    hero === 'Merge app-connectors into develop', hero);
  eq('queue is still capped at 4 rows', (await page.$$('#radar .q-row')).length, 4);
  eq('overflow names the true remainder', (await texts(page, '#radar .q-more'))[0], '+127 more');

  await page.click('#radar .q-more');
  await page.waitForTimeout(400);
  eq('expanded shows all 131 queued items', (await page.$$('#radar .q-row')).length, 131);
  const first = await texts(page, '#radar .q-row .q-text');
  check('sort holds at scale: orphan branches before spec-orphans', /Tag orphan branch/.test(first[0]) && /Tag orphan spec/.test(first[first.length - 1]), first[0] + ' … ' + first[first.length - 1]);
  const bodyScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('131 rows do not blow out the layout horizontally', bodyScroll);
  await shot(page, '02-overflow-125-spec-orphans');
  await page.click('#radar .q-more');
  await page.waitForTimeout(200);
  eq('and it collapses back to 4', (await page.$$('#radar .q-row')).length, 4);

  check('no page errors at 132 attention items', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── grouped orphans: 131 rows become 2 (real-board fix) ──');
// =================================================================================================
// The overflow fixture above is the FLAT shape — what an older collector published, and still a
// valid thing to render. This is the shape derive.js produces now: same 131 orphans, folded by type
// into two expandable rows. The three properties that make the fold safe are checked here, because
// a fold that loses work is worse than the clutter it replaced: the COUNT stays true, every member
// is reachable in one click, and tagging a member still works from inside the group.
{
  const grouped = JSON.parse(JSON.stringify(OVERFLOW));
  const loose = grouped.attention.filter((a) => a.type !== 'orphan' && a.type !== 'spec-orphan');
  const branchOrphans = grouped.attention.filter((a) => a.type === 'orphan');
  const specOrphans = grouped.attention.filter((a) => a.type === 'spec-orphan');
  grouped.attention = loose.concat([
    { type: 'orphan-group', count: branchOrphans.length, items: branchOrphans, actions: [{ kind: 'expand' }] },
    { type: 'spec-orphan-group', count: specOrphans.length, items: specOrphans, actions: [{ kind: 'expand' }] },
  ]);
  ctl.state = grouped; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  eq('131 orphans occupy exactly 2 attention rows', grouped.attention.length, OVERFLOW.attention.length - 129);
  const rows = await texts(page, '#radar .q-row .q-text');
  // hero (the one mergeable) + these two. 131 orphans, two rows, no overflow control.
  eq('the whole resting queue below the hero is 2 rows', rows.length, 2);
  check('and no "+N more" is needed at all', (await page.$$('#radar .q-more')).length === 0);
  check('the group row names the true count, not a page of it',
    rows.some((r) => /Triage 125 untagged spec folders/.test(r)), JSON.stringify(rows));

  // EXPAND: every member is one click away, each with its own tag button.
  const toggle = await page.$$('#radar [data-role="group-toggle"]');
  eq('each group carries an expand control', toggle.length, 2);
  await toggle[1].click();
  await page.waitForTimeout(300);
  const members = await page.$$('#radar .q-row.member');
  eq('expanding reveals every member — nothing was dropped', members.length, specOrphans.length);
  eq('each member keeps its own tag action', (await page.$$('#radar .q-row.member .q-act')).length, specOrphans.length);
  const noHscroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('an expanded group does not blow out the layout horizontally', noHscroll);
  await shot(page, '02b-orphan-groups-expanded');

  // TAG FROM INSIDE THE GROUP: the mutation contract has to reach a member row, or the fold has
  // made the work unreachable in practice while looking reachable.
  ctl.posts.length = 0;
  await (await page.$('#radar .q-row.member .q-act')).click();
  await page.waitForSelector('#radar .rpop input', { timeout: 3000 });
  await page.fill('#radar .rpop input', 'PROJ-108');
  await page.click('#radar .rpop button.on');
  // Checked BEFORE mutate()'s 400 ms confirm-fetch: this is the optimistic half of the contract,
  // and the whole point of the refetch is that server truth then replaces it.
  await page.waitForTimeout(150);
  check('tagging a member posts the member, not the group',
    ctl.posts.length === 1 && ctl.posts[0].path === '/api/radar/tag' && ctl.posts[0].body.kind === 'spec',
    JSON.stringify(ctl.posts));
  const afterTag = await page.$$('#radar .q-row.member');
  eq('the tagged member optimistically leaves the group', afterTag.length, specOrphans.length - 1);
  check('and the group count drops with it — the fold never shows a stale number',
    /Triage 124 untagged spec folders/.test((await texts(page, '#radar .q-row .q-text'))[1] || ''),
    JSON.stringify(await texts(page, '#radar .q-row .q-text')));

  // Server truth lands (the harness still serves all 125) and replaces the optimistic view.
  await page.waitForTimeout(500);
  const toggles = await page.$$('#radar [data-role="group-toggle"]');
  await toggles[1].click();
  await page.waitForTimeout(250);
  eq('collapsing puts it back to one row', (await page.$$('#radar .q-row.member')).length, 0);

  check('no page errors through the grouped path', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── dirty worktrees: one line, not nineteen ──');
// =================================================================================================
// The cleanup fold's actionable content is the removal commands. On the real board 19 read-only
// dirty paths pushed them off the top. The dirty block is now a count that expands.
{
  const many = JSON.parse(JSON.stringify(FULL));
  const repo = Object.keys(many.repos)[0];
  many.repos[repo].worktrees = many.repos[repo].worktrees.concat(
    Array.from({ length: 18 }, (_, i) => ({
      path: `/path/to/workspace/repo-${i}/.claude/worktrees/wt-${i}`,
      branch: `feature/thing-${i}`, dirty: { staged: 0, unstaged: 2, untracked: 1 },
      stale: false, staleReason: null, cleanupCommand: null,
    })));
  ctl.state = many; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);
  await ensureFold(page, 'worktrees', true);

  eq('19 dirty worktrees render as ZERO path rows by default', (await page.$$('#radar .wt.dirty')).length, 0);
  check('replaced by one counted line',
    /19 worktrees have uncommitted work/.test((await texts(page, '#radar .wt.sub code'))[0] || ''),
    JSON.stringify(await texts(page, '#radar .wt.sub code')));
  const cmdRows = await page.$$('#radar .wt:not(.dirty):not(.sub) code');
  check('so the runnable cleanup commands are what the fold opens on', cmdRows.length >= 1);
  await shot(page, '02c-dirty-worktrees-folded');

  await page.click('#radar [data-fold="dirty"]');
  await page.waitForTimeout(250);
  eq('and every path is still one click away', (await page.$$('#radar .wt.dirty')).length, 19);
  check('none of them is offered a command — dirty is never cleanup-ready',
    (await page.$$('#radar .wt.dirty .q-act')).length === 0);
  await page.click('#radar [data-fold="dirty"]');
  await page.waitForTimeout(200);
  eq('collapses again', (await page.$$('#radar .wt.dirty')).length, 0);

  check('no page errors through the cleanup fold', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── no-Jump: the REASON, not "unknown" ──');
// =================================================================================================
// "no tab — surface unknown" is a shrug on the one row whose whole job is to say where to go.
// The live board's actual reason is `ambiguous-tabs:4` — one workspace, four terminals, and
// `cmux tree` carries no per-tab cwd — which is a fact you can act on.
{
  const reasons = [
    ['ambiguous-tabs:4', /4 tabs in that workspace/],
    ['no-workspace-for-cwd', /no cmux workspace covers this directory/],
    ['shared-cwd', /two sessions share this directory/],
    ['no-cwd', /no cwd/],
    [null, /no tab — surface unknown/],
  ];
  const { page, errors } = await newPage();
  await openRadar(page);
  for (const [reason, want] of reasons) {
    const st = JSON.parse(JSON.stringify(FULL));
    const item = st.attention.find((a) => a.type === 'blocked');
    item.actions = [];
    item.surfaceReason = reason;
    const sess = st.sessions.find((x) => x.key.sessionId === item.sessionKey.sessionId);
    if (sess) { sess.surface = null; sess.surfaceReason = reason; }
    ctl.state = st;
    await forceTick(page);
    await page.waitForTimeout(150);
    const txt = (await texts(page, '#radar .nojump'))[0] || '';
    check(`surfaceReason ${reason || '(absent)'} renders its reason`, want.test(txt), txt);
    eq(`surfaceReason ${reason || '(absent)'} still shows NO Jump button`, (await page.$$('#radar .hero .jump')).length, 0);
  }
  await shot(page, '02d-nojump-reason');
  check('no page errors through the no-Jump reasons', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── degraded fixture: badges ──');
// =================================================================================================
{
  ctl.state = DEGRADED; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  const badges = (await texts(page, '#radar .badge')).map((b) => b.replace(/\s+/g, ' '));
  const has = (re) => badges.some((b) => re.test(b));
  check('machine-offline badge', has(/machine-b bridge offline/), badges.join(' | '));
  check('per-source error badge (git)', has(/^git error/), badges.join(' | '));
  check('per-source error badge (deploy)', has(/^deploy error/), badges.join(' | '));
  check('per-source stale badge (sessions)', has(/^sessions stale/), badges.join(' | '));
  check('per-source error badge (config)', has(/^config error/), badges.join(' | '));
  check('snapshot-age badge fires past 2x cadence', has(/snapshot .* old/), badges.join(' | '));
  const title = await page.$eval('#radar .badge[title]', (n) => n.title);
  check('a source badge carries the real error message', /.+/.test(title), title);
  check('badges are neutral — a dead token is not urgent', !(await paintedWith(page, ALERT)).some((x) => /badge/.test(x)));

  // degraded has an empty attention array: quiet, but NOT the same as "never scanned"
  eq('an empty queue on a degraded board still reads all quiet', (await texts(page, '#radar .quiet .big'))[0], 'all quiet');
  await shot(page, '03-degraded-badges');
  check('no page errors on the degraded fixture', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── empty fixture + the never-scanned case ──');
// =================================================================================================
{
  ctl.state = EMPTY; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  eq('empty board shows the all-quiet state', (await texts(page, '#radar .quiet .big'))[0], 'all quiet');
  eq('the sweep is present in the empty state', (await page.$$('#radar .quiet .scope')).length, 1);
  eq('no hero', (await page.$$('#radar .hero')).length, 0);
  eq('no queue rows', (await page.$$('#radar .q-row')).length, 0);
  eq('no folds — nothing to fold', (await page.$$('#radar .fold')).length, 0);
  await shot(page, '04-empty-all-quiet');

  // 503: never scanned. This must NOT look like an empty board (spec §2).
  ctl.stateMode = '503';
  await forceTick(page);
  eq('a board that was never computed says so, instead of claiming all quiet',
    (await texts(page, '#radar .quiet .big'))[0], 'no snapshot yet');
  await shot(page, '05-no-snapshot-yet');

  check('no page errors on the empty fixture', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── state-fetch failure contract + 401 re-auth ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);
  const heroBefore = (await texts(page, '#radar .hero-title'))[0];

  // network dies mid-session
  ctl.stateMode = 'dead';
  await forceTick(page);
  const badgesAfter = (await texts(page, '#radar .badge')).join(' | ');
  check('the last snapshot keeps rendering after a failed fetch',
    (await texts(page, '#radar .hero-title'))[0] === heroBefore, (await texts(page, '#radar .hero-title'))[0]);
  check('a "state stale — fetch failed" badge appears, with an age',
    /state stale — fetch failed/.test(badgesAfter) && /\d+m/.test(badgesAfter), badgesAfter);
  await shot(page, '06-fetch-failed-stale-badge');

  // the same tick the timer runs also HEALS — that is the whole retry policy, no backoff
  ctl.stateMode = 'ok';
  await forceTick(page);
  check('the next tick retries and clears the badge',
    !(await texts(page, '#radar .badge')).join(' ').includes('fetch failed'));
  eq('the poll cadence is the 60s the spec asks for', await page.evaluate(() => window.cmuxRadar.POLL_MS), 60000);

  // 401 -> re-auth prompt
  ctl.stateMode = '401';
  await page.evaluate(() => { window.__prompted = 0; window.prompt = () => { window.__prompted++; return null; }; });
  await forceTick(page);
  const authBadge = (await texts(page, '#radar .badge')).join(' | ');
  check('401 raises an auth-expiry badge', /auth expired/.test(authBadge), authBadge);
  await page.click('#radar .badge button');
  eq('and its control actually asks for a token', await page.evaluate(() => window.__prompted), 1);
  check('the last snapshot survives a 401 too', (await texts(page, '#radar .hero-title'))[0] === heroBefore);
  await shot(page, '07-401-reauth');

  ctl.stateMode = 'ok';
  check('no page errors through the failure paths', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── mutations: optimistic, revert, inline error chip ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = 'ok'; ctl.postMode = 'ok'; ctl.posts = [];
  const { page, errors } = await newPage();
  await openRadar(page);
  await ensureQueue(page, true);                // show every queued row

  // --- tag a branch orphan, success. The row must go BEFORE the response lands.
  ctl.postDelayMs = 700;
  const orphanRow = '#radar .q-row[data-key="orp:app-web:fix-tooltip-jitter"]';
  await page.click(orphanRow + ' .q-act');
  await page.fill('#radar .rpop input', 'PROJ-112');
  await page.click('#radar .rpop button.on');
  await page.waitForTimeout(200);               // still in flight
  eq('the tagged orphan disappears optimistically, before the server answers',
    (await page.$$(orphanRow)).length, 0);
  await page.waitForTimeout(900);
  const tagPost = ctl.posts.find((x) => x.path === '/api/radar/tag');
  check('the branch tag posts the branch shape',
    tagPost && tagPost.body.kind === 'branch' && tagPost.body.repo === 'app-web' && tagPost.body.epic === 'PROJ-112',
    JSON.stringify(tagPost));

  // --- tag failure: the row must come BACK, with the server's message inline
  ctl.postDelayMs = 0; ctl.postMode = '422';
  const other = '#radar .q-row[data-key="orp:app-web:feat/set-dark-mode-globally"]';
  await page.click(other + ' .q-act');
  await page.fill('#radar .rpop input', 'PROJ-999');
  await page.click('#radar .rpop button.on');
  await page.waitForTimeout(400);
  eq('a rejected tag puts the row back', (await page.$$(other)).length, 1);
  const chip = (await texts(page, '#radar .chip'))[0];
  check('and shows the server message as an inline chip', /unknown repo app-web/.test(chip || ''), chip);
  check('the failure chip is red — a lost write IS urgent',
    (await paintedWith(page, ALERT)).some((x) => /chip/.test(x)));
  await shot(page, '08-mutation-revert-chip');

  // --- spec-orphan tag posts the OTHER shape (the S-007 defect-1 route)
  ctl.postMode = 'ok'; ctl.posts = [];
  ctl.state = OVERFLOW;
  await forceTick(page);
  await ensureQueue(page, true);
  const specRow = '#radar .q-row[data-key="spo:p10-search"]';
  await page.click(specRow + ' .q-act');
  await page.fill('#radar .rpop input', 'PROJ-108');
  await page.click('#radar .rpop button.on');
  await page.waitForTimeout(300);
  const specPost = ctl.posts.find((x) => x.path === '/api/radar/tag');
  check('the spec tag posts kind:spec with the folder — not a branchOverride that can never match',
    specPost && specPost.body.kind === 'spec' && specPost.body.specFolder === 'p10-search' && specPost.body.epic === 'PROJ-108',
    JSON.stringify(specPost));

  // --- duplicate specFolder: real, and it used to collapse two rows into one identity.
  // The operator's vault has TWO `p1-foundation` folders under different projects, and a spec-orphan item
  // carries only the folder name — so both rows keyed the same and tagging one made both vanish.
  {
    const dup = JSON.parse(JSON.stringify(FULL));
    dup.attention = dup.attention.filter((a) => a.type !== 'orphan' && a.type !== 'spec-orphan');
    dup.attention.push({ type: 'spec-orphan', specFolder: 'p1-foundation', actions: [{ kind: 'tag' }] });
    dup.attention.push({ type: 'spec-orphan', specFolder: 'p1-foundation', actions: [{ kind: 'tag' }] });
    const prev = ctl.state; ctl.state = dup; ctl.posts = [];
    await forceTick(page);
    await ensureQueue(page, true);
    eq('two identically-named spec folders render as two rows', (await page.$$('#radar .q-row[data-key^="spo:p1-foundation"]')).length, 2);
    const keys = await page.$$eval('#radar .q-row[data-key^="spo:p1-foundation"]', (ns) => ns.map((n) => n.dataset.key));
    check('and they get DISTINCT row identities', keys[0] !== keys[1], JSON.stringify(keys));
    await page.click(`#radar .q-row[data-key="${keys[0]}"] .q-act`);
    await page.fill('#radar .rpop input', 'PROJ-108');
    await page.click('#radar .rpop button.on');
    await page.waitForTimeout(250);
    eq('tagging one removes exactly one — not both', (await page.$$('#radar .q-row[data-key^="spo:p1-foundation"]')).length, 1);
    ctl.state = prev; await forceTick(page); await ensureQueue(page, true);
  }

  // --- close a decision
  ctl.state = FULL; ctl.posts = [];
  await forceTick(page);
  await page.click('#radar .q-row[data-key="dec:site-org2-provider-row"] .q-act');
  await page.waitForSelector('#radar .rpop button.on');
  await page.click('#radar .rpop button.on');
  await page.waitForTimeout(300);
  check('closing a decision hits the close route',
    ctl.posts.some((x) => x.path === '/api/radar/decisions/site-org2-provider-row/close'),
    JSON.stringify(ctl.posts.map((x) => x.path)));
  eq('and the row leaves the queue', (await page.$$('#radar .q-row[data-key="dec:site-org2-provider-row"]')).length, 0);

  // --- assert a flag from the ladder cell
  ctl.posts = [];
  await forceTick(page);
  await ensureFold(page, 'moving', true);
  await page.click('#radar .er[data-epic="PROJ-108"] .step.flagcell');
  await page.waitForSelector('#radar .rpop');
  const flagButtons = await texts(page, '#radar .rpop .btns button');
  check('the flag popover offers exactly on / off / n-a', JSON.stringify(flagButtons) === JSON.stringify(['on', 'off', 'n/a']), JSON.stringify(flagButtons));
  await page.click('#radar .rpop .btns button:first-child');
  await page.waitForTimeout(300);
  const flagPost = ctl.posts.find((x) => x.path === '/api/radar/flag');
  check('asserting a flag posts epic + state', flagPost && flagPost.body.epic === 'PROJ-108' && flagPost.body.state === 'on', JSON.stringify(flagPost));
  eq('and the ladder cell updates optimistically',
    await page.$eval('#radar .er[data-epic="PROJ-108"] .step.flagcell', (n) => n.dataset.state), 'done');

  // --- open a decision (the fourth mutation)
  ctl.posts = [];
  await page.click('#radar .newdec');
  await page.fill('#radar .rpop input:nth-of-type(1)', 'Pick the merge order');
  await page.click('#radar .rpop button.on');
  await page.waitForTimeout(300);
  const decPost = ctl.posts.find((x) => x.path === '/api/radar/decide');
  check('opening a decision posts a title', decPost && decPost.body.title === 'Pick the merge order', JSON.stringify(decPost));

  // --- read-only popovers really are read-only
  await forceTick(page);
  await page.click('#radar .q-row[data-key="mrg:BETA-147"] .q-act');
  await page.waitForSelector('#radar .rpop');
  const runbookButtons = await texts(page, '#radar .rpop button');
  eq('the runbook popover offers nothing but close', JSON.stringify(runbookButtons), JSON.stringify(['close']));
  check('and says it is read-only', /read-only/.test((await texts(page, '#radar .rpop .ro'))[0] || ''));
  await page.keyboard.press('Escape').catch(() => {});
  await page.click('#radar .head');
  await page.waitForTimeout(100);
  await page.click('#radar .q-row[data-key="rv:app-api:prod"] .q-act');
  await page.waitForSelector('#radar .rpop');
  eq('the violation context popover is read-only too', JSON.stringify(await texts(page, '#radar .rpop button')), JSON.stringify(['close']));

  ctl.postMode = 'ok'; ctl.postDelayMs = 0;
  check('no page errors through the mutation paths', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── jump ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = 'ok';
  const { page, errors } = await newPage();
  await openRadar(page);

  check('the hero carries a green Jump button', (await page.$$('#radar .hero .jump')).length === 1);
  await page.click('#radar .hero .jump');
  await page.waitForTimeout(1600);              // machine switch + tree load + select
  const landed = await page.evaluate(() => ({
    mode: document.body.className,
    host: document.getElementById('hostLabel').textContent,
    onTab: [...document.querySelectorAll('#tabs .tab.on')].map((t) => t.textContent.replace(/×$/, '').trim()),
  }));
  check('Jump leaves radar and lands on the named tab, on the named machine',
    !/mode-radar/.test(landed.mode) && landed.host === 'machine-b' && landed.onTab.join() === 'p61 session',
    JSON.stringify(landed));
  await shot(page, '09-jump-landed');

  // surface:null upstream => the attention item has no jump action => NO button, and a reason
  const noSurface = JSON.parse(JSON.stringify(FULL));
  noSurface.attention[0].actions = [];
  noSurface.sessions[0].surface = null;
  ctl.state = noSurface;
  await page.click('#radarBtn');
  await page.waitForSelector('body.mode-radar');
  await forceTick(page);
  eq('surface:null means NO Jump button at all', (await page.$$('#radar .hero .jump')).length, 0);
  check('and the hero says why instead', /surface unknown/.test((await texts(page, '#radar .nojump'))[0] || ''), (await texts(page, '#radar .nojump'))[0]);
  await shot(page, '10-no-jump-surface-null');

  ctl.state = FULL;
  check('no page errors through jump', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// =================================================================================================
console.log('\n── fold persistence + reduced motion ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = 'ok';
  const { page, context } = await newPage();
  await openRadar(page);
  // EVERY fold starts closed on a first visit. `moving` was the one exception and it is the whole
  // reason this section changed: on the real board it dumped 44 epic rows onto the resting screen.
  const openBefore = await page.$$eval('#radar .fold', (ns) => ns.map((n) => n.dataset.fold + '=' + n.getAttribute('aria-expanded')));
  check('every fold — moving INCLUDED — starts closed on a first visit',
    openBefore.every((f) => f.endsWith('=false')), JSON.stringify(openBefore));
  await page.click('#radar [data-fold="parked"]');
  await page.waitForTimeout(150);
  await page.click('#radar [data-fold="moving"]');
  await page.waitForTimeout(150);
  await page.click('#radar [data-fold="moving"]');
  await page.waitForTimeout(150);
  const toggled = await page.$$eval('#radar .fold', (ns) => ns.map((n) => n.dataset.fold + '=' + n.getAttribute('aria-expanded')));
  check('folds toggle', toggled.includes('parked=true') && toggled.includes('moving=false'), JSON.stringify({ openBefore, toggled }));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#radarBtn');
  await openRadar(page);
  const afterReload = await page.$$eval('#radar .fold', (ns) => ns.map((n) => n.dataset.fold + '=' + n.getAttribute('aria-expanded')));
  check('and survive a reload (localStorage)', afterReload.includes('parked=true') && afterReload.includes('moving=false'), JSON.stringify(afterReload));

  // A DELIBERATE preference for an open `moving` must survive too — the new default is a default,
  // not a policy. (Toggle it open, reload, still open.)
  await page.click('#radar [data-fold="moving"]');
  await page.waitForTimeout(150);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#radarBtn');
  await openRadar(page);
  const kept = await page.$$eval('#radar .fold', (ns) => ns.map((n) => n.dataset.fold + '=' + n.getAttribute('aria-expanded')));
  check('a deliberate "keep moving open" preference is respected across reloads',
    kept.includes('moving=true'), JSON.stringify(kept));

  // ...and the ONE-TIME migration only ever drops the contaminated `moving` key. A v1 blob (no _v)
  // carrying moving:true was written as a SIDE EFFECT of toggling some other fold, back when moving
  // defaulted open; it cannot be told apart from a preference, so it is discarded exactly once.
  // Every other fold's stored value survives the migration untouched.
  await page.evaluate(() => localStorage.setItem('p5radar:folds',
    JSON.stringify({ moving: true, parked: true, worktrees: false, queue: false })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#radarBtn');
  await openRadar(page);
  const migrated = await page.$$eval('#radar .fold', (ns) => ns.map((n) => n.dataset.fold + '=' + n.getAttribute('aria-expanded')));
  check('legacy fold blob: moving is reset once, every other preference survives',
    migrated.includes('moving=false') && migrated.includes('parked=true'), JSON.stringify(migrated));
  await context.close();

  const reduced = await newPage({ reducedMotion: 'reduce' });
  await openRadar(reduced.page);
  const anim = await reduced.page.evaluate(() => getComputedStyle(document.querySelector('#radar .scope'), '::after').animationName);
  eq('prefers-reduced-motion stops the sweep', anim, 'none');
  const normal = await newPage({ reducedMotion: 'no-preference' });
  await openRadar(normal.page);
  const anim2 = await normal.page.evaluate(() => getComputedStyle(document.querySelector('#radar .scope'), '::after').animationName);
  check('and it does sweep otherwise (so the assertion above means something)', anim2 === 'rsweep', anim2);
  await reduced.context.close();
  await normal.context.close();
}

// =================================================================================================
console.log('\n── radar cannot break cmux ──');
// =================================================================================================
{
  ctl.state = FULL; ctl.stateMode = '500';
  const { page, errors } = await newPage();
  await openRadar(page);
  await page.waitForTimeout(300);
  await page.click('#radarBtn');               // toggle back out
  await page.waitForTimeout(400);
  const alive = await page.evaluate(() => ({
    mode: document.body.className,
    tabs: document.querySelectorAll('#tabs .tab').length,
    radarPane: !!document.getElementById('radar'),
  }));
  check('a radar API that only 500s leaves the terminal UI fully usable',
    !/mode-radar/.test(alive.mode) && alive.tabs >= 2, JSON.stringify(alive));
  check('no unhandled page errors from a 500ing radar', errors.length === 0, errors.join('\n        '));
  await page.context().close();
}

// Before the multi-pane merge the chip was BUILT only when radarUI existed, so a missing radar.js
// could not leave one behind. The chip now ships in index.html, so that guarantee is a removal at
// boot instead — and an untested removal is how a dead control reaches the toolbar.
{
  ctl.state = FULL; ctl.stateMode = 'ok';
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Serve radar.js as a 404 — the "stale cache / bad deploy" case, not a syntax error.
  await page.route('**/radar.js*', (route) => route.fulfill({ status: 404, body: '' }));
  await page.addInitScript((t) => { try { localStorage.setItem('cmux_token', t); } catch (_) {} }, TOKEN);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tabs .tab', { timeout: 8000 });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    chip: !!document.getElementById('radarBtn'),
    files: !!document.getElementById('filesBtn'),
    tabs: document.querySelectorAll('#tabs .tab').length,
    mode: document.body.className,
  }));
  check('radar.js missing => the toolbar chip is REMOVED, not left dead', after.chip === false, JSON.stringify(after));
  check('radar.js missing => the terminal UI is untouched', after.files === true && after.tabs >= 2 && !/mode-radar/.test(after.mode), JSON.stringify(after));
  check('radar.js missing => no page errors', errors.length === 0, errors.join('\n        '));
  await context.close();
}

// =================================================================================================
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\nscreenshots: ${SHOTS}`);
console.log(`${results.length - failed}/${results.length} checks passed`);
if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
console.log('p5 radar smoke: OK');
