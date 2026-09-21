// p19 browser smoke: the REAL page, reached only through a TCP→UNIX relay, on a server and a bridge
// that both listen on UNIX sockets (specs.md §9, §15.2).
//
//   tmux      a throwaway server on a private socket (test/helpers/tmux-server.js)
//   bridge.js BACKEND=tmux, BRIDGE_SOCKET=<run>/bridge.sock            — no TCP port
//   server.js SERVER_SOCKET=<run>/server.sock, CMUX_MACHINE_URL=unix:<run>/bridge.sock — no TCP port
//   relay     net.createServer on 127.0.0.1:<ephemeral> piping every connection to server.sock:
//             the stand-in for cloudflared's `service: unix:` origin
// <run> is one fresh 0700 fs.mkdtempSync directory. Both children start from scratch working
// directories so no .env is read. Nothing is stubbed; what the page does is checked in tmux itself.
// Never touches the default tmux socket, :8799 / :8080, or the ports p18's smoke uses.
//
// Playwright is BORROWED, not depended on — this repo stays npm-install-free:
//   PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p19-socket-smoke.mjs
// Optional: P19_SMOKE_SHOT=/path/to/shot.png (default: a file in os.tmpdir()).
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { startTmux, waitFor } = require('./helpers/tmux-server.js');

async function loadPlaywright() {
  const p = process.env.PLAYWRIGHT_DIR;
  if (!p) {
    console.error('FAIL: PLAYWRIGHT_DIR is not set.\n  PLAYWRIGHT_DIR=/path/to/node_modules/playwright/index.mjs node test/p19-socket-smoke.mjs');
    process.exit(1);
  }
  if (!fs.existsSync(p)) { console.error(`FAIL: PLAYWRIGHT_DIR=${p} does not exist`); process.exit(1); }
  try { return await import(p); } catch (e) {
    console.error(`FAIL: could not load Playwright from ${p}: ${(e && e.message) || e}`);
    process.exit(1);
  }
}

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SECRET = crypto.randomBytes(12).toString('hex');
const TOKEN = crypto.randomBytes(12).toString('hex');
const TAG = crypto.randomBytes(3).toString('hex').toUpperCase();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (ok || extra === undefined ? '' : '  [' + extra + ']'));
  if (!ok) failed++;
};
const tcpListeners = (pid) => spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();

const { chromium } = await loadPlaywright();
const srv = await startTmux({ cols: 120, rows: 36 });
if (!srv) { console.error('FAIL: tmux not installed'); process.exit(1); }
const scratch = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p19-${name}-`)));
  fs.chmodSync(d, 0o700);
  return d;
};
const run = scratch('run');
const bridgeCwd = scratch('bridge');
const serverCwd = scratch('server');
const filesDir = scratch('files');
const BSOCK = path.join(run, 'bridge.sock');
const SSOCK = path.join(run, 'server.sock');
const FILE = `p19-smoke-${TAG}.txt`;
const FILE_BYTES = Buffer.from(`p19 socket smoke ${TAG}\n${crypto.randomBytes(512).toString('base64')}\n`);
fs.writeFileSync(path.join(filesDir, FILE), FILE_BYTES);

function boot(file, cwd, env, ready) {
  const child = spawn(process.execPath, [path.join(REPO, file)], { cwd, env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(`[${file}] ${d}`); });
  const up = waitFor(() => ready.test(out), { timeout: 15000, what: `${file} to listen` });
  return { child, up, out: () => out };
}
const bridge = boot('bridge.js', bridgeCwd, {
  BRIDGE_SOCKET: BSOCK, BRIDGE_SECRET: SECRET, FS_ROOTS: filesDir,
  BACKEND: 'tmux', TMUX_SOCKET: srv.socket, TMUX_BIN: srv.tmuxBin,
}, /cmux-remote bridge on unix:\S+\n/);

let server, relay, browser;
const relayed = { conns: 0 };
try {
  await bridge.up;
  server = boot('server.js', serverCwd, {
    SERVER_SOCKET: SSOCK, SERVER_TOKEN: TOKEN,
    CMUX_MACHINE_URL: `unix:${BSOCK}`, CMUX_MACHINE_SECRET: SECRET,
    CMUX_MACHINE_LABEL: 'socket-smoke', CMUX_CONFIG: '', CMUX_MACHINES: '',
  }, /cmux-remote server on unix:\S+ with 1 machine\(s\)/);
  await server.up;
  check('bridge announced its socket', bridge.out().includes(`cmux-remote bridge on unix:${BSOCK}\n`));
  check('server announced its socket and the unix: machine', server.out().includes(`cmux-remote server on unix:${SSOCK} with 1 machine(s)`));
  for (const [s, name] of [[BSOCK, 'bridge'], [SSOCK, 'server']]) {
    const st = fs.lstatSync(s);
    check(`${name} socket is a 0600 socket of ours`, st.isSocket() && (st.mode & 0o777) === 0o600 && st.uid === process.getuid(),
      (st.mode & 0o777).toString(8));
  }

  // the cloudflared stand-in: TCP in, UNIX socket out, bytes untouched
  relay = net.createServer((c) => {
    relayed.conns++;
    const u = net.connect(SSOCK);
    c.pipe(u); u.pipe(c);
    const kill = () => { c.destroy(); u.destroy(); };
    c.on('error', kill); u.on('error', kill); c.on('close', kill); u.on('close', kill);
  });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  const RELAY = relay.address().port;
  console.log(`relay 127.0.0.1:${RELAY} -> unix:${SSOCK}`);

  // tmux names a window after its running command; the smoke's workspace is named after the session
  await waitFor(async () => (await srv.run(['list-sessions', '-F', '#{session_name}'])).stdout.trim() === 'main', { what: 'main' });
  await srv.runOk(['rename-window', '-t', 'main:0', 'main']);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') { consoleErrors.push(m.text()); console.log('[console] error: ' + m.text()); } });
  page.on('pageerror', (e) => { console.log('FAIL — page error: ' + e.message); failed++; });
  const dlUrls = [];
  page.on('download', (d) => dlUrls.push(d.url()));
  // domcontentloaded, never networkidle — the app holds long-lived SSE connections open
  await page.goto(`http://127.0.0.1:${RELAY}/#token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pane', { timeout: 10000 });

  // 1. the workspace list shows `main`
  const listed = await page.waitForFunction(() => [...document.querySelectorAll('#side .siderow.ws .sidelabel')].some((l) => l.textContent === 'main'),
    null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('the workspace list shows `main`', listed,
    await page.evaluate(() => [...document.querySelectorAll('#side .siderow.ws .sidelabel')].map((l) => l.textContent).join(' | ')));

  // 2. output printed in tmux appears in the mirror (SSE through the relay and both sockets)
  const marker = `P19-MARK-${TAG}`;
  await srv.type('main:0', `echo ${marker}-OUT`);
  const t0 = Date.now();
  const seen = await page.waitForFunction((m) => [...document.querySelectorAll('.pane')].some((p) => p.innerText.includes(m)),
    `${marker}-OUT`, { timeout: 10000 }).then(() => true).catch(() => false);
  check('a marker printed into tmux appears in the mirror within 10 s', seen, `after ${Date.now() - t0} ms`);

  // 3. compose + submit lands in tmux
  const composed = `P19-COMPOSE-${TAG}`;
  await page.fill('#text', `echo ${composed}`);
  await page.locator('#send').dispatchEvent('pointerdown');
  const landed = await waitFor(async () => new RegExp(`^${composed}$`, 'm').test(await srv.capture('main:0')), { timeout: 8000, what: 'the composed command output' })
    .then(() => true).catch(() => false);
  check('compose text + submit lands in tmux (capture-pane shows its output)', landed, (await srv.capture('main:0')).trim().split('\n').slice(-4).join(' | '));

  const shot = process.env.P19_SMOKE_SHOT || path.join(os.tmpdir(), `p19-socket-smoke-${TAG}.png`);
  await page.screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);

  // 4. a file downloaded through the Files tab is byte-identical
  await page.locator('header #filesBtn').click();
  await page.waitForSelector('#files .frow', { timeout: 10000 });
  await page.locator('#files .frow', { hasText: filesDir }).first().click();
  await page.waitForSelector(`#flist .frow:has-text("${FILE}")`, { timeout: 10000 });
  await page.locator('#flist .frow', { hasText: FILE }).first().click();
  await page.waitForFunction(() => !/^Loading/.test(document.getElementById('fvbody').textContent || ''), null, { timeout: 15000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.locator('#fvdl').click()]);
  const got = fs.readFileSync(await dl.path());
  check('the file downloaded through the Files tab matches the one on disk', sha(got) === sha(FILE_BYTES), `${got.length} bytes`);
  check('the download URL carries a ticket, never SERVER_TOKEN', dlUrls.length > 0 && dlUrls.every((u) => u.includes('ticket=') && !u.includes(TOKEN)), dlUrls[0]);

  // 5. neither child holds a TCP listener; everything reached them through the relay
  check('the bridge holds no TCP listener', tcpListeners(bridge.child.pid) === '', tcpListeners(bridge.child.pid));
  check('the server holds no TCP listener', tcpListeners(server.child.pid) === '', tcpListeners(server.child.pid));
  check('the page came through the relay', relayed.conns > 0, `${relayed.conns} connections`);
  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  console.log('FAIL — ' + ((e && e.stack) || e));
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (relay) relay.close();
  for (const p of [server && server.child, bridge.child]) { try { if (p) p.kill('SIGTERM'); } catch (_) {} }
  await srv.stop().catch(() => {});
  for (const d of [run, bridgeCwd, serverCwd, filesDir]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
