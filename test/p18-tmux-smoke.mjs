// p18 browser smoke: the REAL page, through the REAL server, on a REAL tmux-backed bridge.
//
// A throwaway tmux server (`tmux -u -D -S <mkdtemp>/s -f /dev/null`, test/helpers/tmux-server.js),
// bridge.js with BACKEND=tmux on :8897 and server.js on :8096, both from scratch working directories
// so no .env is ever read. Nothing is stubbed: what the page shows is what tmux holds, and what the
// page does is checked in tmux itself. Never touches the default tmux socket or :8799 / :8080.
//
// Playwright is BORROWED, not depended on — this repo stays npm-install-free:
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p18-tmux-smoke.mjs
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { startTmux, waitFor } = require('./helpers/tmux-server.js');

async function loadPlaywright() {
  const tried = [];
  if (process.env.PLAYWRIGHT_DIR) {
    tried.push(process.env.PLAYWRIGHT_DIR);
    try { return await import(process.env.PLAYWRIGHT_DIR); } catch (_) { /* fall through */ }
  }
  tried.push('playwright (bare specifier)');
  try { return await import('playwright'); } catch (_) { /* fall through */ }
  console.error('FAIL: could not load Playwright. Tried: ' + tried.join(', ') +
    '\n  PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p18-tmux-smoke.mjs');
  process.exit(1);
}

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BRIDGE_PORT = 8897, SERVER_PORT = 8096;
const SECRET = crypto.randomBytes(12).toString('hex');
const TOKEN = crypto.randomBytes(12).toString('hex');
const TAG = crypto.randomBytes(3).toString('hex').toUpperCase();

let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || extra === undefined ? '' : '  [' + extra + ']'));
  if (!ok) failed++;
};

// Fail fast rather than share a port with something else (e.g. another smoke run).
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
for (const p of [BRIDGE_PORT, SERVER_PORT]) {
  if (!(await portFree(p))) { console.error(`FAIL: port ${p} is in use — refusing to run`); process.exit(1); }
}

const { chromium } = await loadPlaywright();
const srv = await startTmux({ cols: 120, rows: 36 });
if (!srv) { console.error('FAIL: tmux not installed'); process.exit(1); }
const scratch = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p18-smoke-${name}-`)));
const bridgeCwd = scratch('bridge');
const serverCwd = scratch('server');

function boot(file, cwd, env, ready) {
  const child = spawn(process.execPath, [path.join(REPO, file)], { cwd, env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(`[${file}] ${d}`); });
  const up = waitFor(() => ready.test(out), { timeout: 15000, what: `${file} to listen` });
  return { child, up, out: () => out };
}
const bridge = boot('bridge.js', bridgeCwd, {
  BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_HOST: '127.0.0.1', BRIDGE_SECRET: SECRET,
  BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin,
}, /cmux-remote bridge on /);
const server = boot('server.js', serverCwd, {
  PORT: String(SERVER_PORT), HOST: '127.0.0.1', SERVER_TOKEN: TOKEN,
  CMUX_MACHINE_URL: `http://127.0.0.1:${BRIDGE_PORT}`, CMUX_MACHINE_SECRET: SECRET,
  CMUX_MACHINE_LABEL: 'tmux-smoke', CMUX_CONFIG: '', CMUX_MACHINES: '',
}, /cmux-remote server on /);

let browser;
try {
  await bridge.up;
  await server.up;
  // the bridge's boot-time ensure() made `main`; give its window a name the page can be searched for
  await waitFor(async () => (await srv.run(['list-sessions', '-F', '#{session_name}'])).stdout.trim() === 'main', { what: 'main' });
  const WS_NAME = `p18-smoke-${TAG}`;
  await srv.runOk(['rename-window', '-t', 'main:0', WS_NAME]);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console] error: ' + m.text()); });
  page.on('pageerror', (e) => { console.log('FAIL — page error: ' + e.message); failed++; });
  await page.goto(`http://127.0.0.1:${SERVER_PORT}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 10000 });

  // 1. the tmux window is listed as a workspace
  await page.waitForFunction((n) => document.body.innerText.includes(n), WS_NAME, { timeout: 8000 })
    .then(() => check('the tmux window is listed as a workspace', true))
    .catch(() => check('the tmux window is listed as a workspace', false));

  // 2. output printed in tmux appears in the mirror
  const marker = `P18-MARK-${TAG}`;
  await srv.type('main:0', `echo ${marker}-OUT`);
  const t0 = Date.now();
  const seen = await page.waitForFunction((m) => [...document.querySelectorAll('.pane')].some((p) => p.innerText.includes(m)),
    `${marker}-OUT`, { timeout: 5000 }).then(() => true).catch(() => false);
  check('a marker printed into the tmux pane appears in the mirror within 5 s', seen, `after ${Date.now() - t0} ms`);

  // 3. compose + submit lands in tmux (and runs: the echo's own output line appears)
  const composed = `P18-COMPOSE-${TAG}`;
  await page.fill('#text', `echo ${composed}`);
  await page.locator('#send').dispatchEvent('pointerdown');
  const landed = await waitFor(async () => /^P18-COMPOSE-\w+$/m.test(await srv.capture('main:0')) && (await srv.capture('main:0')).includes(composed), { timeout: 6000, what: 'the composed command output' })
    .then(() => true).catch(() => false);
  check('compose text + submit lands in the tmux pane', landed, (await srv.capture('main:0')).trim().split('\n').slice(-4).join(' | '));

  // 4. the page has no browser entry points on a tmux machine
  const addButtons = await page.locator('.tab.add').allInnerTexts();
  check('the tab strip rendered its add button (sanity for the next check)', addButtons.includes('+'), JSON.stringify(addButtons));
  check("no '+🌐' button exists", (await page.locator('button', { hasText: '+🌐' }).count()) === 0, JSON.stringify(addButtons));

  // 4b. no radar on a tmux machine: both chips are MOUNTED (radar.js and inbox.js loaded) and hidden
  for (const id of ['radarBtn', 'inboxBtn']) {
    const chip = page.locator('#' + id);
    const n = await chip.count();
    check(`#${id} is mounted but hidden`, n === 1 && await chip.isHidden(), `count=${n}`);
  }

  // 5. the pane menu: '+ Browser tab here' hidden, the terminal entry still offered
  await page.locator('.pane').first().locator('.pact').first().click();
  await page.waitForSelector('#splitMenu:not([hidden])', { timeout: 3000 });
  check('the pane menu opened', await page.locator('#splitMenu').isVisible());
  check("'#paneNewBrowser' is hidden when the pane menu is open", await page.locator('#paneNewBrowser').isHidden());
  check("'+ Terminal tab here' is still offered", await page.locator('#paneNewTab').isVisible());

  // 6. split right from the pane menu makes a real tmux pane
  await page.locator('#splitMenu button[data-split="right"]').click();
  const split = await waitFor(async () => (await srv.runOk(['list-panes', '-t', 'main:0', '-F', '#{pane_id}'])).trim().split('\n').length === 2,
    { timeout: 6000, what: 'the split' }).then(() => true).catch(() => false);
  check('split-right from the pane menu makes list-panes count 2', split);
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2, null, { timeout: 8000 })
    .then(() => check('the mirror shows both panes', true)).catch(() => check('the mirror shows both panes', false));
  const shot = path.join(os.tmpdir(), `p18-tmux-smoke-${TAG}.png`);
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);
} catch (e) {
  console.log('FAIL — ' + ((e && e.stack) || e));
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of [server.child, bridge.child]) { try { p.kill('SIGTERM'); } catch (_) {} }
  await srv.stop().catch(() => {});
  for (const d of [bridgeCwd, serverCwd]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
