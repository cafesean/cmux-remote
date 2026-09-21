'use strict';
// A fixture-serving fake `cmux` executable for bridge children (CMUX_BIN=<it>), so the p18 contract
// test can boot a REAL bridge.js on the cmux backend with no cmux app (pattern: test/close-scope.test.js).
//
// It answers every argv form the non-browser routes build, in cmux's own shapes:
//   tree            2 workspaces, 3 single-surface panes (ws 1: two panes side by side), UUID ids
//   list-windows / workspace list   current_directory = a real temp dir (fs roots, completions)
//   list-status     'claude_code=Running icon=bolt.fill'
//   rpc pane.list   two side-by-side pixel frames
//   rpc terminal.replay   test/fixtures/grids/claude-slash-2.json wrapped as { seq: 7, render_grid }
//   read-screen     a few lines of text
//   split-off       cmux's real refusal for a single-surface pane (exit 1)
//   anything else   'OK' (mutations), '{}' for the other rpc methods
//
// (Declares no tests; `node --test` treats a file with zero subtests as a pass.)
const fs = require('fs');
const path = require('path');

const IDS = {
  window: 'f0f0f0f0-1111-4111-8111-000000000001',
  wsA: 'aaaaaaa1-1111-4111-8111-111111111111',
  wsB: 'bbbbbbb1-1111-4111-8111-111111111111',
  paneA1: 'aaaaaaa1-2222-4222-8222-222222222221',
  paneA2: 'aaaaaaa1-2222-4222-8222-222222222222',
  paneB1: 'bbbbbbb1-2222-4222-8222-222222222221',
  sfA1: 'aaaaaaa1-3333-4333-8333-333333333331',
  sfA2: 'aaaaaaa1-3333-4333-8333-333333333332',
  sfB1: 'bbbbbbb1-3333-4333-8333-333333333331',
};

function writeFakeCmux(dir, opts) {
  const o = opts || {};
  const cwd = o.cwd || dir;
  const grid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'grids', 'claude-slash-2.json'), 'utf8')).grid;
  const data = { IDS, cwd, replay: { seq: 7, render_grid: grid } };
  const file = path.join(dir, 'fake-cmux');
  const src = '#!' + process.execPath + '\n' + String.raw`'use strict';
const D = ${JSON.stringify(data)};
const I = D.IDS;
const args = process.argv.slice(2);
const has = (a) => args.includes(a);
const sf = (id, ref) => ({ id, ref, title: ref, type: 'terminal', selected: true, selected_in_pane: true });
const pane = (id, ref, index, s) => ({ id, ref, index, focused: index === 0, selected_surface_id: s.id, selected_surface_ref: s.ref, surfaces: [s] });
function answer(op) {
  if (op === 'tree') return { windows: [{ id: I.window, ref: 'window:1', workspaces: [
    { id: I.wsA, ref: 'workspace:1', title: 'alpha', selected: true, panes: [
      pane(I.paneA1, 'pane:1', 0, sf(I.sfA1, 'surface:1')), pane(I.paneA2, 'pane:2', 1, sf(I.sfA2, 'surface:2')) ] },
    { id: I.wsB, ref: 'workspace:2', title: 'beta', selected: false, panes: [ pane(I.paneB1, 'pane:3', 0, sf(I.sfB1, 'surface:3')) ] },
  ] }] };
  if (op === 'list-windows') return [{ id: I.window, ref: 'window:1' }];
  if (op === 'workspace' && args[1] === 'list') return { workspaces: [
    { id: I.wsA, ref: 'workspace:1', title: 'alpha', custom_title: 'alpha', current_directory: D.cwd },
    { id: I.wsB, ref: 'workspace:2', title: 'beta', custom_title: '', current_directory: D.cwd } ] };
  if (op === 'list-status') return 'claude_code=Running icon=bolt.fill\n';
  if (op === 'rpc' && args[1] === 'pane.list') return { container_frame: { x: 0, y: 0, width: 1200, height: 800 }, panes: [
    { id: I.paneA1, ref: 'pane:1', index: 0, focused: true, columns: 70, rows: 40, pixel_frame: { x: 240, y: 30, width: 560, height: 740 },
      selected_surface_id: I.sfA1, selected_surface_ref: 'surface:1', surface_ids: [I.sfA1], surface_refs: ['surface:1'] },
    { id: I.paneA2, ref: 'pane:2', index: 1, focused: false, columns: 50, rows: 40, pixel_frame: { x: 804, y: 30, width: 396, height: 740 },
      selected_surface_id: I.sfA2, selected_surface_ref: 'surface:2', surface_ids: [I.sfA2], surface_refs: ['surface:2'] } ] };
  if (op === 'rpc' && args[1] === 'terminal.replay') return D.replay;
  if (op === 'rpc') return '{}';
  if (op === 'read-screen') return has('--scrollback') ? 'one\ntwo\nthree' : 'one\ntwo\nthree\n';
  if (op === 'split-off') return { fail: 'Error: invalid_state: splitting off would leave the source pane empty\n' };
  if (op === 'new-surface') return 'OK surface:9 pane:1 workspace:1\n';
  if (op === 'new-workspace') return 'OK workspace:9\n';
  return 'OK\n';
}
const v = answer(args[0] || '');
// write, THEN exit: a pipe write is asynchronous, and process.exit() would cut a big answer short
if (v && typeof v === 'object' && typeof v.fail === 'string') process.stderr.write(v.fail, () => process.exit(1));
else process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v), () => process.exit(0));
`;
  fs.writeFileSync(file, src, { mode: 0o755 });
  return { file, ids: IDS, grid };
}

module.exports = { writeFakeCmux, IDS };
