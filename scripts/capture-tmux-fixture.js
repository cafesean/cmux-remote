#!/usr/bin/env node
'use strict';
// Record REAL tmux captures for test/tmux-grid.test.js (p18 specs.md §6, §15.2).
//
//   node scripts/capture-tmux-fixture.js [outDir]      (default: test/fixtures/tmux)
//
// Each scenario runs in its own throwaway tmux server — `tmux -u -D -S <mkdtemp>/s -f /dev/null`,
// never the default socket — in a 60x8 pane whose program is a fixed sh script. When the script
// reaches its end marker the pane is captured exactly the way lib/tmux-cli.js captures it
// (`capture-pane -p -e`) together with the cursor, and written as <name>.ansi + <name>.json.
// The server is killed and its directory removed afterwards. The committed files are what the grid
// tests read, so those tests need no tmux at all.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COLS = 60;
const ROWS = 8;
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'tmux'));

// Every script ends by printing nothing further and parking in `sleep`, so the cursor stays where
// the last printf left it. `read _` is a step barrier the recorder releases with Enter.
const SCENARIOS = [
  {
    name: 'sgr-basic',
    script: String.raw`printf '\033[1mBOLD\033[0m \033[7mINV\033[0m \033[3;4;9mISU\033[0m\n'
printf '\033[31mred\033[0m \033[42mgreenbg\033[0m \033[93;104mbright\033[0m end'`,
    done: 'end',
  },
  {
    name: 'rgb-256',
    script: String.raw`printf '\033[38;2;177;185;249mRGB-sel\033[0m \033[38;5;246mfield256\033[0m'`,
    done: 'field256',
  },
  {
    name: 'wide-emoji',
    // step 1 prints 日本語X and waits: the recorder reads cursor_x there (the width proof)
    script: String.raw`printf '日本語X'
read _
printf '🙂 x'`,
    step: '日本語X',
    done: '🙂 x',
  },
  {
    name: 'osc8-link',
    script: String.raw`printf '\033]8;;https://example.invalid\033\\link\033]8;;\033\\ after'`,
    done: 'link after',
  },
];

// Same order lib/tmux-cli.js uses: $TMUX_BIN, Homebrew (Apple silicon, then Intel), then PATH.
function resolveTmuxBin() {
  if (process.env.TMUX_BIN) return process.env.TMUX_BIN;
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) if (fs.existsSync(p)) return p;
  return 'tmux';
}
function tmuxEnv() {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', SHELL: '/bin/sh' };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record(bin, sc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p18-fixture-'));
  const socket = path.join(dir, 's');
  const env = tmuxEnv();
  const server = spawn(bin, ['-u', '-D', '-S', socket, '-f', '/dev/null'], { env, stdio: 'ignore' });
  const tmux = (args) => execFileSync(bin, ['-u', '-S', socket, ...args], { env, encoding: 'utf8' });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await sleep(100);
    const scriptFile = path.join(dir, 'scenario.sh');
    fs.writeFileSync(scriptFile, `${sc.script}\nexec sleep 100000\n`);
    tmux(['new-session', '-d', '-s', 'fx', '-x', String(COLS), '-y', String(ROWS), `/bin/sh ${scriptFile}`]);
    const waitFor = async (text) => {
      for (let i = 0; i < 100; i++) {
        if (tmux(['capture-pane', '-p', '-t', 'fx']).includes(text)) return;
        await sleep(50);
      }
      throw new Error(`${sc.name}: never saw ${JSON.stringify(text)}`);
    };
    const meta = { name: sc.name, tmux: tmux(['display', '-p', '#{version}']).trim() };
    if (sc.step) {
      await waitFor(sc.step);
      meta.step_text = sc.step;
      meta.step_cursor_x = Number(tmux(['display', '-p', '-t', 'fx', '#{cursor_x}']).trim());
      tmux(['send-keys', '-t', 'fx', 'Enter']);
    }
    await waitFor(sc.done);
    await sleep(100);
    const capture = tmux(['capture-pane', '-p', '-e', '-t', 'fx']);
    const [w, h, cx, cy, cf, alt] = tmux(['display', '-p', '-t', 'fx',
      '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}']).trim().split(' ').map(Number);
    Object.assign(meta, { columns: w, rows: h, cursor: { column: cx, row: cy, visible: cf === 1 }, alt: alt === 1 });
    fs.writeFileSync(path.join(OUT, `${sc.name}.ansi`), capture);
    fs.writeFileSync(path.join(OUT, `${sc.name}.json`), JSON.stringify(meta, null, 2) + '\n');
    return meta;
  } finally {
    try { tmux(['kill-server']); } catch (_) { /* already gone */ }
    await new Promise((r) => (server.exitCode !== null ? r() : server.on('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const bin = resolveTmuxBin();
  fs.mkdirSync(OUT, { recursive: true });
  for (const sc of SCENARIOS) {
    const meta = await record(bin, sc);
    console.log(`${sc.name}: ${meta.columns}x${meta.rows} cursor ${meta.cursor.column},${meta.cursor.row}${sc.step ? ` step_cursor_x ${meta.step_cursor_x}` : ''}`);
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
