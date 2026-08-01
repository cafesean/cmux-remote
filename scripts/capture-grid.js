#!/usr/bin/env node
'use strict';
// capture-grid — record real cmux render grids as test fixtures (p7 §6.0).
//
// The p7 live-menu detector cannot be designed from reasoning: the question "how does Claude Code
// mark the selected row in its / menu" is empirical, and getting it wrong fires chips on every idle
// Claude tab (war-game F1) or on none at all (F2). This tool captures the grids so the rules are
// measured instead of guessed, and so V1 can re-run them forever without a Mac in the loop.
//
// SAFETY — the whole reason this is a script and not an ad-hoc shell loop:
//   * Keys are ONLY ever sent to a surface this process created. sendText/sendKey refuse any UUID
//     that is not in `owned`. The operator works on this machine; a stray keypress lands in a live agent.
//   * Scratch workspaces are created with `--focus false` so the operator's window never jumps.
//   * Every scratch workspace is closed on exit, including on throw and on SIGINT.
//   * Capturing from an EXISTING surface is read-only (`terminal.replay`) and always allowed —
//     that is how the idle-Claude negative fixture is taken without touching a real session.
//
// Surfaces are addressed by UUID, never by ref: refs are window-context-relative and do not resolve
// from a detached process (p1 lesson, and this script may run from anywhere).

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'grids');
const UUID_RE = /^[0-9A-Fa-f-]{36}$/;

const owned = new Set();        // surface UUIDs this process created — the write allow-list
const scratchWorkspaces = [];   // workspace UUIDs to tear down

function cmux(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(CMUX_BIN, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`cmux ${args[0]} failed: ${String(stderr || err.message).slice(0, 300)}`));
      resolve(stdout || '');
    });
  });
}
const rpc = async (method, params) => JSON.parse(await cmux(['rpc', method, JSON.stringify(params)]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tree ---------------------------------------------------------------------------------------

async function tree() {
  const j = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
  const out = [];
  for (const win of j.windows || []) {
    for (const ws of win.workspaces || []) {
      // A workspace's surfaces hang off its panes (`pane.surfaces[]`), and only `--id-format both`
      // puts UUIDs there at all — with the default format these carry refs only, which do not
      // resolve outside the caller's window context.
      const tabs = [];
      for (const pane of ws.panes || []) {
        for (const sf of pane.surfaces || []) {
          tabs.push({
            id: sf.id, ref: sf.ref, title: sf.title || '',
            type: sf.surface_type || (sf.is_browser_surface ? 'browser' : 'terminal'),
            pane: pane.id,
          });
        }
      }
      out.push({ id: ws.id, ref: ws.ref, name: ws.title || ws.name || '', tabs });
    }
  }
  return out;
}

const flatSurfaces = (ws) => ws.flatMap((w) => w.tabs.map((t) => ({ ...t, workspace: w.id, wsName: w.name })));

// ---- scratch workspace lifecycle ----------------------------------------------------------------

async function newScratch(cwd) {
  const before = await tree();
  const beforeWs = new Set(before.map((w) => w.id));
  const args = ['new-workspace', '--focus', 'false'];
  if (cwd) args.push('--cwd', cwd);
  await cmux(args);
  await sleep(900);                                  // the surface's shell needs a moment to exist
  const after = await tree();
  const created = after.find((w) => !beforeWs.has(w.id));
  if (!created) throw new Error('scratch workspace did not appear in the tree');
  const surface = created.tabs[0];
  if (!surface || !UUID_RE.test(surface.id)) throw new Error('scratch workspace has no addressable surface');
  scratchWorkspaces.push(created.id);
  owned.add(surface.id);
  return { workspace: created.id, surface: surface.id };
}

async function teardown() {
  for (const ws of scratchWorkspaces.splice(0)) {
    try { await cmux(['close-workspace', '--workspace', ws], 8000); } catch (e) { console.error(`teardown: ${e.message}`); }
  }
}

// ---- input (owned surfaces only) -----------------------------------------------------------------

function assertOwned(surface) {
  if (!owned.has(surface)) throw new Error(`refusing to send input to a surface this run did not create: ${surface}`);
}
async function sendText(surface, text) { assertOwned(surface); await cmux(['send', '--surface', surface, '--', text]); }
async function sendKey(surface, key) { assertOwned(surface); await cmux(['send-key', '--surface', surface, '--', key]); }

// ---- capture -------------------------------------------------------------------------------------

// Read-only: allowed against ANY surface, including the operator's live ones.
async function grabGrid(surface) {
  const d = await rpc('terminal.replay', { surface_id: surface });
  const rg = d && d.render_grid;
  if (!rg) throw new Error('no render_grid in replay');
  return rg;
}

// Fixtures keep only the viewport (scrollback is noise for menu detection, and a Claude session's
// scrollback is the operator's real work — it must not land in a checked-in file).
function viewportOnly(rg) {
  return {
    columns: rg.columns,
    rows: rg.rows,
    active_screen: rg.active_screen,
    cursor: rg.cursor,
    styles: rg.styles,
    row_spans: rg.row_spans,
  };
}

async function saveFixture(name, rg, meta) {
  await fsp.mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  const body = { name, meta: meta || {}, grid: viewportOnly(rg) };
  await fsp.writeFile(file, JSON.stringify(body, null, 1) + '\n', 'utf8');
  const marked = countMarked(body.grid);
  console.log(`saved ${path.relative(process.cwd(), file)}  (${body.grid.rows} rows, ${body.grid.styles.length} styles, ${marked.inverse} inverse, ${marked.bg} non-default-bg, cursor row ${body.grid.cursor && body.grid.cursor.row})`);
  return file;
}

// Quick signal census, printed at capture time so a bad capture is obvious immediately rather than
// three steps later when the detector "mysteriously" fails.
function countMarked(grid) {
  const byId = new Map((grid.styles || []).map((s) => [s.id, s]));
  const bgCount = new Map();
  for (const sp of grid.row_spans || []) {
    const st = byId.get(sp.style_id);
    if (st) bgCount.set(st.background, (bgCount.get(st.background) || 0) + 1);
  }
  let defaultBg = null, best = -1;
  for (const [bg, n] of bgCount) if (n > best) { best = n; defaultBg = bg; }
  const rowsInverse = new Set(), rowsBg = new Set();
  for (const sp of grid.row_spans || []) {
    const st = byId.get(sp.style_id);
    if (!st) continue;
    if (st.inverse) rowsInverse.add(sp.row);
    if (st.background !== defaultBg) rowsBg.add(sp.row);
  }
  return { inverse: rowsInverse.size, bg: rowsBg.size, defaultBg };
}

// Wait until the grid stops changing (two identical reads) or `maxMs` elapses. Fixed sleeps are
// what produced the first mangled capture: a shell that is still printing its banner will happily
// accept keystrokes and interleave them with its own output.
async function settleGrid(surface, maxMs) {
  const deadline = Date.now() + (maxMs || 2500);
  let prev = null;
  while (Date.now() < deadline) {
    let sig;
    try { sig = JSON.stringify((await grabGrid(surface)).row_spans || []); } catch (_) { sig = null; }
    if (sig && sig === prev) return true;
    prev = sig;
    await sleep(300);
  }
  return false;
}

// ---- CLI -------------------------------------------------------------------------------------

async function cmdList() {
  const ws = await tree();
  for (const w of ws) {
    console.log(`workspace ${w.id}  ${w.name || '(unnamed)'}`);
    for (const t of w.tabs) console.log(`   ${t.id}  ${t.type.padEnd(9)} ${t.title}`);
  }
}

// Capture from an existing surface, read-only. This is how the idle-Claude fixture is taken.
async function cmdCapture(surface, name) {
  if (!UUID_RE.test(surface)) throw new Error('surface must be a UUID');
  const rg = await grabGrid(surface);
  await saveFixture(name, rg, { source: 'existing-surface', readOnly: true });
}

// Run a scripted scenario in a scratch workspace. steps: [{text}|{key}|{wait}|{shot}]
async function runScenario(name, steps, opts) {
  const { surface } = await newScratch((opts && opts.cwd) || process.env.HOME);
  // A brand-new surface's shell is not ready to receive input immediately — the first capture
  // attempt landed its keystrokes before the login banner and recorded a mangled command line.
  // Wait for the grid to stop changing rather than guessing a fixed delay.
  await settleGrid(surface, (opts && opts.settle) || 2500);
  let shot = 0;
  for (const step of steps) {
    if (step.text != null) await sendText(surface, step.text);
    if (step.key != null) await sendKey(surface, step.key);
    if (step.wait != null) await sleep(step.wait);
    if (step.shot) {
      const rg = await grabGrid(surface);
      const fixName = shot === 0 ? name : `${name}-${shot + 1}`;
      await saveFixture(fixName, rg, { source: 'scratch-scenario', scenario: name, step: step.shot });
      shot++;
    }
  }
  return surface;
}

const SCENARIOS = {
  // --- negatives: ordinary terminal output that must NOT look like a menu -----------------------
  // NOTE: no backslash escapes in any scenario text. `cmux send` interprets sequences like \n and
  // will split the command across lines mid-typing — the first capture attempt submitted half a
  // printf and recorded a broken shell. Multiple `echo`s joined by `;` express the same thing with
  // nothing for cmux to interpret.
  'neg-numbered-prose': [
    { text: "clear; echo 'Here are the steps:'; echo '1. first thing'; echo '2. second thing'; echo '3. third thing'; echo 'and some trailing prose'", wait: 300 },
    { key: 'enter', wait: 1200 }, { shot: 'after' },
  ],
  'neg-git-log-graph': [
    { text: 'git -C ${HOME} log --graph --oneline -20 | cat', wait: 200 },
    { key: 'enter', wait: 1500 }, { shot: 'after' },
  ],
  'neg-ls-columns': [
    { text: 'ls /usr/bin | head -60', wait: 200 },
    { key: 'enter', wait: 1200 }, { shot: 'after' },
  ],
  // --- zsh completion, single column (long names force one per row) ------------------------------
  // The first Tab completes the longest common prefix; the MENU only appears on the second Tab (or
  // the first, when there is no common prefix to add). Both scenarios press twice, and both need a
  // prefix with several matches — a unique match just completes silently and records nothing.
  // 🕳️ `zstyle ':completion:*' menu select` ALONE DOES NOTHING. The interactive menu lives in the
  // `zsh/complist` module; without `zmodload zsh/complist` zsh prints an inert multi-column list
  // with no highlighted row and no arrow navigation. The first capture proved it: 0 inverse rows,
  // 0 non-default backgrounds, nothing to walk. The README prerequisite needs both lines.

  'zsh-menu-single': [
    { text: 'zmodload zsh/complist; autoload -Uz compinit; compinit -u; zstyle ":completion:*" menu select', wait: 300 },
    { key: 'enter', wait: 3000 }, { text: 'clear', wait: 200 }, { key: 'enter', wait: 800 },
    { text: 'ls /usr/share/', wait: 500 },
    { key: 'tab', wait: 1200 }, { key: 'tab', wait: 1500 }, { shot: 'menu-open' },
    { key: 'down', wait: 900 }, { shot: 'moved-down' },
  ],
  // --- zsh completion, multi column (short names pack several per row) ---------------------------
  'zsh-menu-multi': [
    { text: 'zmodload zsh/complist; autoload -Uz compinit; compinit -u; zstyle ":completion:*" menu select', wait: 300 },
    { key: 'enter', wait: 3000 }, { text: 'clear', wait: 200 }, { key: 'enter', wait: 800 },
    { text: 'ls /usr/', wait: 500 },
    { key: 'tab', wait: 1200 }, { key: 'tab', wait: 1500 }, { shot: 'menu-open' },
    { key: 'right', wait: 900 }, { shot: 'moved-right' },
  ],
  // --- Claude Code: the primary target. Needs a real session, so it runs in a scratch workspace
  // and never touches the operator's. `claude` inside cmux resolves to the cmux shim; that is fine, it only
  // injects settings. Nothing is ever submitted — we type the trigger character and read the grid.
  'claude-idle': [
    { text: 'claude', wait: 300 }, { key: 'enter', wait: 12000 }, { shot: 'idle-input-box' },
  ],
  'claude-slash': [
    { text: 'claude', wait: 300 }, { key: 'enter', wait: 12000 }, { shot: 'idle-input-box' },
    { text: '/', wait: 2500 }, { shot: 'slash-menu' },
    { key: 'down', wait: 1200 }, { shot: 'slash-menu-moved' },
  ],
  'claude-at': [
    { text: 'claude', wait: 300 }, { key: 'enter', wait: 12000 },
    { text: '@', wait: 3000 }, { shot: 'at-picker' },
    { key: 'down', wait: 1200 }, { shot: 'at-picker-moved' },
  ],
  // --- the DEFAULT zsh behaviour: an inert candidate list, no highlight. Must render no chips. ----
  'neg-shell-startup': [
    { wait: 4000 }, { shot: 'startup' },
  ],
  'neg-zsh-list-plain': [
    { text: 'clear', wait: 200 }, { key: 'enter', wait: 600 },
    { text: 'ls /usr/share/', wait: 500 },
    { key: 'tab', wait: 1200 }, { key: 'tab', wait: 1500 }, { shot: 'list-open' },
  ],
};

async function cmdScenario(name) {
  const steps = SCENARIOS[name];
  if (!steps) throw new Error(`unknown scenario ${name}. known: ${Object.keys(SCENARIOS).join(', ')}`);
  await runScenario(name, steps, {});
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list') return cmdList();
  if (cmd === 'capture') return cmdCapture(rest[0], rest[1]);
  if (cmd === 'scenario') return cmdScenario(rest[0]);
  if (cmd === 'scenarios') return console.log(Object.keys(SCENARIOS).join('\n'));
  console.log(`usage:
  capture-grid.js list                      list workspaces and surface UUIDs
  capture-grid.js capture <uuid> <name>     read-only grab from an EXISTING surface
  capture-grid.js scenario <name>           run a scripted scenario in a scratch workspace
  capture-grid.js scenarios                 list scenario names`);
}

let exiting = false;
const bail = async (code) => { if (exiting) return; exiting = true; await teardown(); process.exit(code); };
process.on('SIGINT', () => bail(130));
process.on('SIGTERM', () => bail(143));

main()
  .then(() => bail(0))
  .catch(async (e) => { console.error(`ERROR: ${e.message}`); await bail(1); });

module.exports = { countMarked, viewportOnly };
