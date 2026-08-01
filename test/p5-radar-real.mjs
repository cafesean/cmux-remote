// Real-data walkthrough of the Radar tab — the REAL server, the REAL collector, the REAL repos.
//
// This is not a CI test and it asserts almost nothing. It is the reproducible recipe for the thing
// that actually decides whether radar is any good: opening it on the real board and doing the real
// job — find what is dangling, read the hero, expand the overflow, copy a cleanup command, tag an
// orphan, read a context popover — with a screenshot at every step.
//
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs \
//   RADAR_DIR=/tmp/radar-real SHOT_DIR=/tmp/shots node test/p5-radar-real.mjs
//
// RADAR_DIR must hold a real config.json (copy ~/.radar/config.json). It is written to — aliases
// and state land there — which is exactly why it should NOT be ~/.radar: a walkthrough must not
// edit the board it is walking.
//
// It boots its own server on an ephemeral port (PORT=0). It never touches a running one.
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_DIR) {
    try { return await import(process.env.PLAYWRIGHT_DIR); } catch (_) { /* fall through */ }
  }
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  console.error('FAIL: set PLAYWRIGHT_DIR to a playwright entry point');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const RADAR_DIR = process.env.RADAR_DIR;
const SHOTS = process.env.SHOT_DIR || join(REPO, '.radar-shots');
if (!RADAR_DIR || !existsSync(join(RADAR_DIR, 'config.json'))) {
  console.error(`FAIL: RADAR_DIR must contain a config.json (got ${RADAR_DIR})`);
  process.exit(1);
}
mkdirSync(SHOTS, { recursive: true });
const TOKEN = (readFileSync(join(REPO, '.env'), 'utf8').match(/^SERVER_TOKEN=(.*)$/m) || [])[1]
  ?.trim().replace(/^['"]|['"]$/g, '');
if (!TOKEN) { console.error('FAIL: no SERVER_TOKEN in .env'); process.exit(1); }

// ---- boot the real server on an ephemeral port ----------------------------------------------------
const child = spawn(process.execPath, [join(REPO, 'server.js')], {
  cwd: REPO,
  env: Object.assign({}, process.env, { PORT: '0', RADAR_ENABLED: '1', RADAR_DIR }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
let port = null;
const ready = new Promise((resolve, reject) => {
  const onData = (b) => {
    const s = String(b);
    serverLog.push(s.trimEnd());
    process.stdout.write('  [server] ' + s);
    const m = s.match(/cmux-remote server on http:\/\/[^:]+:(\d+)/);
    if (m) { port = Number(m[1]); resolve(); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  setTimeout(() => reject(new Error('server did not report a port in 20s')), 20000);
});
await ready;
const BASE = `http://127.0.0.1:${port}`;
console.log(`\nreal server: ${BASE}  ·  RADAR_DIR=${RADAR_DIR}\n`);

const api = (p) => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + TOKEN } });

// The boot scan takes several seconds over ten repos; wait for a real snapshot before looking.
let state = null;
for (let i = 0; i < 60; i++) {
  const r = await api('/api/radar/state');
  if (r.ok) { state = await r.json(); break; }
  await new Promise((r2) => setTimeout(r2, 1000));
}
if (!state) { console.error('FAIL: no snapshot after 60s'); child.kill(); process.exit(1); }

const byType = {};
state.attention.forEach((a) => { byType[a.type] = (byType[a.type] || 0) + 1; });
console.log('REAL BOARD');
console.log('  repos      ', Object.keys(state.repos).length, '·', Object.keys(state.repos).join(', '));
console.log('  epics      ', state.epics.length, `(${state.epics.filter((e) => e.zone === 'active').length} active, ${state.epics.filter((e) => e.zone === 'dormant').length} dormant)`);
console.log('  attention  ', state.attention.length, JSON.stringify(byType));
console.log('  worktrees  ', state.counts.staleWorktrees, 'stale');
console.log('  sources    ', Object.entries(state.sources).map(([k, v]) => `${k}=${v.status}`).join(' '));
console.log('  sessions   ', state.sessions.length);
console.log('');

// ---- walk it like a human ---------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript((t) => { try { localStorage.setItem('cmux_token', t); } catch (_) {} }, TOKEN);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#radarBtn', { timeout: 15000 });

const step = async (n, name, note) => {
  await page.screenshot({ path: join(SHOTS, `real-${n}-${name}.png`), fullPage: true });
  console.log(`  ${n}. ${note}`);
};

// 1 — open the tab
await page.click('#radarBtn');
await page.waitForSelector('body.mode-radar #radar .hero, body.mode-radar #radar .quiet', { timeout: 15000 });
await page.waitForTimeout(600);
console.log('WALKTHROUGH');
await step('01', 'opened', 'opened Radar — hero: ' + JSON.stringify((await page.$$eval('#radar .hero-title', (n) => n.map((x) => x.textContent)))[0] || '(all quiet)'));

// 2 — the badges tell you what radar could not see
const badges = await page.$$eval('#radar .badge', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
console.log('      badges:', badges.length ? badges.join(' | ') : '(none)');

// 3 — the resting screen. THIS is the number the redesign is judged on: what is on the page the
// moment it opens, before a single click.
const resting = await page.evaluate(() => {
  const n = (s) => document.querySelectorAll('#radar ' + s).length;
  return { hero: n('.hero'), queue: n('.q-row'), epicRows: n('.er'), worktreeRows: n('.wt'),
    more: (document.querySelector('#radar .q-more') || {}).textContent || null,
    folds: Array.from(document.querySelectorAll('#radar .fold')).map((x) => x.dataset.fold + '=' + x.getAttribute('aria-expanded')) };
});
console.log('      RESTING SCREEN:', JSON.stringify(resting));
console.log('      rows visible at rest:', resting.hero + resting.queue + resting.epicRows + resting.worktreeRows);

// 3b — the orphan groups. 131 orphans are two rows here; expanding has to reach every one of them.
const groups = await page.$$('#radar [data-role="group-toggle"]');
if (groups.length) {
  await groups[groups.length - 1].click();
  await page.waitForTimeout(800);
  const members = (await page.$$('#radar .q-row.member')).length;
  await step('02', 'orphan-group-expanded', `expanded the last orphan group -> ${members} member rows, each with its own tag`);
  await (await page.$$('#radar [data-role="group-toggle"]'))[groups.length - 1].click();
  await page.waitForTimeout(400);
}

// 3c — the queue overflow, if the board still produces one (a snapshot from an older collector, or
// simply more than 4 non-orphan items).
const moreText = await page.$$eval('#radar .q-more', (ns) => ns.map((n) => n.textContent.trim()));
if (moreText.length) {
  await page.click('#radar .q-more');
  await page.waitForTimeout(700);
  console.log(`      overflow "${moreText[0]}" -> ${(await page.$$('#radar .q-row')).length} queue rows`);
  await page.click('#radar .q-more');
  await page.waitForTimeout(400);
}

// 4 — the moving fold: real epics, real ladders
const foldOpen = async (id) => {
  const b = await page.$(`#radar [data-fold="${id}"]`);
  if (!b) return false;
  if ((await b.getAttribute('aria-expanded')) !== 'true') { await b.click(); await page.waitForTimeout(400); }
  return true;
};
if (await foldOpen('moving')) {
  const rows = await page.$$eval('#radar .er', (ns) => ns.slice(0, 6).map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  await step('03', 'moving-open', `moving fold — ${(await page.$$('#radar .er')).length} epic rows`);
  rows.forEach((r) => console.log('        ' + r));
}

// 5 — the cleanup fold: commands for the human, never executed
if (await foldOpen('worktrees')) {
  const cmds = await page.$$eval('#radar .wt code', (ns) => ns.map((n) => n.textContent.trim()));
  await step('04', 'worktrees-open', `worktrees fold — ${cmds.length} rows`);
  cmds.slice(0, 4).forEach((c) => console.log('        ' + c.slice(0, 150)));
  const copy = await page.$('#radar .wt .q-act');
  if (copy) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await copy.click();
    await page.waitForTimeout(300);
    console.log('        copy button now reads:', (await copy.textContent()).trim());
  }
}

// 6 — read a context/runbook popover
const firstAct = await page.$('#radar .hero .q-act, #radar .q-row .q-act');
if (firstAct) {
  await firstAct.click();
  await page.waitForSelector('#radar .rpop', { timeout: 4000 }).catch(() => {});
  await step('05', 'popover', 'opened the hero action popover');
  const pop = await page.$$eval('#radar .rpop', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  console.log('        ' + (pop[0] || '(none)').slice(0, 240));
  await page.click('#radar .head');
  await page.waitForTimeout(200);
}

// 7 — tag an orphan for real, FROM INSIDE ITS GROUP (writes RADAR_DIR/aliases.json, never ~/.radar).
// This is the property that makes the fold safe: folding must not make the work unreachable.
const flat = [];
for (const a of state.attention) {
  if (Array.isArray(a.items)) for (const m of a.items) flat.push(m);
  else flat.push(a);
}
const orphan = flat.find((a) => a.type === 'orphan');
if (orphan) {
  const toggles = await page.$$('#radar [data-role="group-toggle"]');
  if (toggles.length) { await toggles[0].click(); await page.waitForTimeout(700); }
  const sel = `#radar .q-row[data-key="orp:${orphan.repo}:${orphan.branch}"] .q-act`;
  const row = await page.$(sel);
  if (row) {
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.fill('#radar .rpop input', 'p5-radar');
    await page.click('#radar .rpop button.on');
    await page.waitForTimeout(1400);
    await step('06', 'tagged-orphan-in-group', `tagged ${orphan.repo}:${orphan.branch} -> p5-radar, from inside the group`);
    const aliases = JSON.parse(readFileSync(join(RADAR_DIR, 'aliases.json'), 'utf8'));
    console.log('        aliases.branchOverrides now has:', aliases.branchOverrides[`${orphan.repo}:${orphan.branch}`]);
  } else {
    console.log(`  06. orphan row ${orphan.repo}:${orphan.branch} not found after expanding — skipped`);
  }
}

// 8 — a spec-orphan tag, the S-007 defect-1 route, end to end on the real vault
const specOrphan = flat.find((a) => a.type === 'spec-orphan');
if (specOrphan) {
  const toggles = await page.$$('#radar [data-role="group-toggle"]');
  if (toggles.length) { await toggles[toggles.length - 1].click(); await page.waitForTimeout(900); }
  const sel = `#radar .q-row[data-key="spo:${specOrphan.specFolder}"] .q-act`;
  const row = await page.$(sel);
  if (row) {
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.fill('#radar .rpop input', 'PROJ-108');
    await page.click('#radar .rpop button.on');
    await page.waitForTimeout(1400);
    await step('07', 'tagged-spec-in-group', `tagged spec ${specOrphan.specFolder} -> PROJ-108, from inside the group`);
    const aliases = JSON.parse(readFileSync(join(RADAR_DIR, 'aliases.json'), 'utf8'));
    console.log('        aliases.epics["PROJ-108"] =', JSON.stringify(aliases.epics['PROJ-108']));
  } else {
    console.log(`  07. spec-orphan row ${specOrphan.specFolder} not found after expanding — skipped`);
  }
}

// 9 — the Jump question, answered honestly. A blocked row with no surface must say WHY.
const blockedRows = state.sessions.filter((s) => s.status === 'blocked');
console.log('  08. blocked sessions and their surfaces:');
for (const s of blockedRows) {
  console.log(`        ${s.key.sessionId.slice(0, 8)}  surface=${s.surface ? s.surface.tabUuid : 'null'}  reason=${s.surfaceReason || '—'}  cwd-repo=${s.repo || '—'}`);
}
console.log('        Jump buttons on screen:', (await page.$$('#radar .jump')).length);
console.log('        no-jump reasons on screen:', JSON.stringify(await page.$$eval('#radar .nojump', (ns) => ns.map((n) => n.textContent.trim()))));
console.log('        jiraDrift digest entries:', (state.jiraDrift || []).length);

await page.screenshot({ path: join(SHOTS, 'real-08-final.png'), fullPage: true });
console.log('\n  page errors:', errors.length ? errors.join('\n    ') : 'none');
console.log('  screenshots:', SHOTS);

await browser.close();
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 400));
