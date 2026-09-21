'use strict';
// p18 STORY-006 — radar pane identity on the tmux backend (specs.md §8).
//
// A Claude session in a tmux pane has no CMUX_SURFACE_ID, so its hook recorded no tab and radar had
// to guess from a cwd. TMUX_PANE + CMUX_TMUX_EPOCH mint the same id the bridge's tree reports for that
// pane. The integration case runs the REAL hook-receiver.js inside a pane of a throwaway tmux server
// (private mkdtemp socket) and compares what it recorded with the emulator's tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const receiver = require('../radar/hook-receiver');
const ids = require('../lib/tmux-ids');
const { startTmux, tmuxBinary, waitFor } = require('./helpers/tmux-server');

const skip = tmuxBinary() ? false : 'tmux not installed';
const RECEIVER = path.join(__dirname, '..', 'radar', 'hook-receiver.js');

test('CMUX_SURFACE_ID keeps precedence over the tmux identity', () => {
  assert.equal(receiver.cmuxIdentity({ CMUX_SURFACE_ID: 'S-1', TMUX_PANE: '%3', CMUX_TMUX_EPOCH: '1' }).surfaceId, 'S-1');
  assert.equal(receiver.cmuxIdentity({ CMUX_PANEL_ID: 'P-9', TMUX_PANE: '%3', CMUX_TMUX_EPOCH: '1' }).surfaceId, 'P-9');
});

test('TMUX_PANE + CMUX_TMUX_EPOCH + a matching server pid -> the minted surface id; missing or malformed -> ""', () => {
  const OK = { TMUX_PANE: '%3', CMUX_TMUX_EPOCH: '1789991468', CMUX_TMUX_PID: '777', TMUX: '/private/tmp/t/s,777,0' };
  assert.equal(receiver.cmuxIdentity(OK).surfaceId, ids.mint(4, 1789991468, 3));
  for (const env of [
    { TMUX_PANE: '%3' },
    { CMUX_TMUX_EPOCH: '1789991468' },
    { TMUX_PANE: '%3', CMUX_TMUX_EPOCH: '1789991468' },             // no pid proof (review fix 2)
    { ...OK, TMUX_PANE: '3' },
    { ...OK, TMUX_PANE: '%x' },
    { ...OK, CMUX_TMUX_EPOCH: 'abc' },
    { ...OK, TMUX: '/private/tmp/t/inner,778,0' },                   // a tmux started inside the pane
    { TMUX_PANE: '', CMUX_TMUX_EPOCH: '' },
    {},
  ]) {
    assert.deepEqual(receiver.cmuxIdentity(env), { surfaceId: '', tabId: '', workspaceId: '' }, JSON.stringify(env));
  }
});

test('in a real tmux pane after ensure(), the hook records exactly the tab id the emulator\'s tree reports', { skip }, async () => {
  const srv = await startTmux({ cols: 100, rows: 30 });
  try {
    const cli = srv.cli();
    const tree = () => new Promise((resolve, reject) => cli.exec(['tree', '--all', '--json', '--id-format', 'both'], { timeout: 8000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)))));
    await tree();                                                    // ensure(): epoch variable, then "main"
    const pane = (await srv.runOk(['new-window', '-d', '-t', 'main:', '-P', '-F', '#{pane_id}'])).trim();
    const radarDir = path.join(srv.dir, 'radar');
    const envFile = path.join(srv.dir, 'pane-env.txt');
    // the pane's OWN environment, as a hook process in it would see it …
    await srv.type(pane, `printf '%s|%s|%s|%s\\n' "$TMUX_PANE" "$CMUX_TMUX_EPOCH" "$CMUX_TMUX_PID" "$TMUX" > '${envFile}'`);
    // … and the real receiver, run by that pane's shell exactly as Claude Code would run a hook
    await srv.type(pane, `printf '{"session_id":"p18-s1","hook_event_name":"Stop"}' | RADAR_DIR='${radarDir}' '${process.execPath}' '${RECEIVER}'`);
    const [tmuxPane, epoch, serverPid, tmuxVar] = (await waitFor(() => fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes('|') && fs.readFileSync(envFile, 'utf8'),
      { what: 'the pane environment' })).trim().split('|');
    assert.equal(tmuxPane, pane);
    assert.equal(epoch, String(await srv.startTime()));

    const t = await tree();
    const tab = t.windows.flatMap((w) => w.workspaces).flatMap((ws) => ws.panes).find((p) => p.ref === `pane:${pane.slice(1)}`).surfaces[0];
    assert.equal(serverPid, (await srv.runOk(['display', '-p', '#{pid}'])).trim());
    assert.equal(receiver.cmuxIdentity({ TMUX_PANE: tmuxPane, CMUX_TMUX_EPOCH: epoch, CMUX_TMUX_PID: serverPid, TMUX: tmuxVar }).surfaceId, tab.id);

    const evDir = path.join(radarDir, 'events');
    const rec = await waitFor(() => {
      if (!fs.existsSync(evDir)) return null;
      for (const f of fs.readdirSync(evDir)) {
        for (const line of fs.readFileSync(path.join(evDir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.sessionId === 'p18-s1' || ev.session_id === 'p18-s1') return ev;
        }
      }
      return null;
    }, { what: 'the hook event' });
    assert.equal(rec.surfaceId, tab.id);
  } finally {
    await srv.stop();
  }
});

test('radar/hook-receiver.js gains no child_process require and spawns nothing', () => {
  const src = fs.readFileSync(RECEIVER, 'utf8');
  assert.ok(!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(src));
  assert.ok(!/\b(spawn|execFile|execSync|spawnSync|execFileSync)\s*\(/.test(src));
});
