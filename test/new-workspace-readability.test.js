'use strict';
// A detached bridge can create an unfocused workspace whose terminal surface is not initialized.
// The mirror immediately selects the returned workspace, so creation must focus it before replying.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { bootBridge } = require('./helpers/bridge-child');

const WIN = 'ffffffff-1111-4111-8111-111111111111';
const WS = 'aaaaaaaa-1111-4111-8111-111111111111';
const PANE = 'bbbbbbbb-2222-4222-8222-222222222222';
const SURFACE = 'cccccccc-3333-4333-8333-333333333333';

const EMPTY_TREE = { windows: [{ id: WIN, ref: 'window:1', workspaces: [] }] };
const CREATED_TREE = { windows: [{ id: WIN, ref: 'window:1', workspaces: [{
  id: WS, ref: 'workspace:1', title: 'Terminal', selected: true,
  panes: [{ id: PANE, ref: 'pane:1', index: 0, focused: true,
    selected_surface_id: SURFACE,
    surfaces: [{ id: SURFACE, ref: 'surface:1', title: 'Terminal', type: 'terminal', selected: true, selected_in_pane: true }],
  }],
}] }] };

const FAKE_CMUX = '#!' + process.execPath + '\n' + String.raw`
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const op = args[0] || '';
const treeFile = process.env.FAKE_CMUX_TREE;
if (op === 'tree') { process.stdout.write(fs.readFileSync(treeFile)); process.exit(0); }
if (op === 'list-status') process.exit(0);
if (op === 'new-workspace') {
  fs.appendFileSync(process.env.FAKE_CMUX_LOG, JSON.stringify(args) + '\n');
  fs.writeFileSync(treeFile, process.env.FAKE_CMUX_CREATED_TREE);
  process.stdout.write('OK workspace:1\n');
  process.exit(0);
}
process.exit(1);
`;

let bridge, cwd, logFile, treeFile;
before(async () => {
  cwd = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cmux-new-workspace-')));
  const bin = path.join(cwd, 'fake-cmux');
  logFile = path.join(cwd, 'calls.jsonl');
  treeFile = path.join(cwd, 'tree.json');
  await fsp.writeFile(bin, FAKE_CMUX, { mode: 0o755 });
  await fsp.writeFile(logFile, '');
  await fsp.writeFile(treeFile, JSON.stringify(EMPTY_TREE));
  bridge = await bootBridge({ cwd, env: {
    CMUX_BIN: bin,
    FAKE_CMUX_LOG: logFile,
    FAKE_CMUX_TREE: treeFile,
    FAKE_CMUX_CREATED_TREE: JSON.stringify(CREATED_TREE),
  } });
});
after(async () => { if (bridge) await bridge.stop(); });

test('new workspace is focused so its terminal is initialized before the mirror selects it', async () => {
  const r = await fetch(`${bridge.base}/cmux/new-workspace`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  const args = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  const focus = args.indexOf('--focus');
  assert.ok(focus >= 0, `new-workspace omitted --focus: ${args.join(' ')}`);
  assert.equal(args[focus + 1], 'true', 'unfocused workspaces can have unreadable terminal surfaces');
});
