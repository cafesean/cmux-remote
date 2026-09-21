'use strict';
// p18 STORY-005 — capabilities reach the page, and the page gates on them (specs.md §7).
//
// The server half boots a REAL server.js (test/helpers/server-boot.js) in front of a stub bridge — an
// HTTP server answering /cmux/tree, the pattern of test/p17-fleet.test.js — because the question is
// what the shipped server relays. The page half is a source scan of public/app.js (pattern:
// test/p8-client-wiring.test.js) plus an evaluation of canBrowser() itself. The last test keeps the
// public repo free of deployment identifiers (p12 principle 5).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { bootServer, call } = require('./helpers/server-boot');

const REPO = path.join(__dirname, '..');
const TMUX_CAPS = { backend: 'tmux', browser: false, sidebarStatus: false, tabsInPane: false };
const TREE = { workspaces: [{ ref: 'workspace:1', id: 'W1', title: 'one', selected: true,
  tabs: [{ id: 'S1', ref: 'surface:1', title: 'sh', type: 'terminal', selected: true, pane: 'P1', paneRef: 'pane:1', inPane: true, status: '' }],
  panes: [{ ref: 'pane:1', id: 'P1', index: 0, focused: true, selected: 'S1', tabs: ['S1'] }] }] };

function stubBridge(secret, caps) {
  const srv = http.createServer((req, res) => {
    const ok = req.headers['x-bridge-secret'] === secret;
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { ...TREE, ...(caps ? { capabilities: caps } : {}) } : { error: 'forbidden' }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  })));
}

test('server: bootstrap and fleet carry a bridge\'s capabilities, and omit the key for a bridge that sends none', async (t) => {
  const withCaps = await stubBridge('s1', TMUX_CAPS);
  const without = await stubBridge('s2', null);
  const srv = await bootServer({ env: {
    SERVER_TOKEN: 'tok', CMUX_MACHINE_URL: '', CMUX_CONFIG: '',
    CMUX_MACHINES: JSON.stringify([
      { id: 'tmuxbox', label: 'Headless', baseUrl: withCaps.base, secret: 's1' },
      { id: 'oldbox', label: 'Pre-p18', baseUrl: without.base, secret: 's2' },
    ]) } });
  t.after(async () => { await srv.stop(); await withCaps.close(); await without.close(); });

  const b1 = await call(srv.base, 'GET', '/api/cmux/bootstrap?machine=tmuxbox', { token: 'tok' });
  assert.equal(b1.status, 200);
  assert.deepEqual(b1.json.capabilities, TMUX_CAPS);
  assert.equal(b1.json.workspaces.length, 1);
  const b2 = await call(srv.base, 'GET', '/api/cmux/bootstrap?machine=oldbox', { token: 'tok' });
  assert.equal(b2.status, 200);
  assert.ok(!('capabilities' in b2.json), JSON.stringify(b2.json));
  assert.deepEqual(Object.keys(b2.json).sort(), ['machine', 'machines', 'workspaces']);   // exactly today's body

  const f = await call(srv.base, 'GET', '/api/cmux/fleet', { token: 'tok' });
  assert.equal(f.status, 200);
  const by = Object.fromEntries(f.json.machines.map((m) => [m.id, m]));
  assert.deepEqual(by.tmuxbox.capabilities, TMUX_CAPS);
  assert.equal(by.tmuxbox.ok, true);
  assert.ok(!('capabilities' in by.oldbox), JSON.stringify(by.oldbox));
  assert.equal(by.oldbox.ok, true);
  // /api/cmux/tree relays the bridge body whole, so it carries them too
  const tr = await call(srv.base, 'GET', '/api/cmux/tree?machine=tmuxbox', { token: 'tok' });
  assert.deepEqual(tr.json.capabilities, TMUX_CAPS);
});

test('page: state.caps, canBrowser(), and both browser entry points gated on it', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
  assert.match(src, /\n\s+caps: \{\},/, 'state.caps');
  // filled from bootstrap and from every fleet beat
  assert.match(src, /if \(boot\.capabilities && state\.machine\) state\.caps\[state\.machine\] = boot\.capabilities;/);
  assert.match(src, /for \(const m of machines\) if \(m\.capabilities\) state\.caps\[m\.id\] = m\.capabilities;/);
  // the tab strip's +🌐 is only pushed when the machine can browse
  assert.match(src, /if \(canBrowser\(\)\) kids\.push\(mk\('\+🌐', 'New browser tab', \(\) => doNewBrowser\(\)\)\);/);
  assert.equal((src.match(/kids\.push\(mk\('\+🌐'/g) || []).length, 1, 'no ungated second push');
  // the pane menu hides "+ Browser tab here" inside openPaneMenu
  const m = /function openPaneMenu\(btn, paneId\) \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(m, 'openPaneMenu exists');
  assert.match(m[1], /const nbb = \$\('paneNewBrowser'\); if \(nbb\) nbb\.hidden = !canBrowser\(\);/);
  const html = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="paneNewBrowser"/);
});

test('page: canBrowser() is true with no capabilities (pre-p18 bridge) and false only for browser:false', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
  const m = /const canBrowser = \(\) => \{ (.*) \};\n/.exec(src);
  assert.ok(m, 'canBrowser definition');
  // eslint-disable-next-line no-new-func
  const canBrowser = (state) => new Function('state', m[1])(state);
  assert.equal(canBrowser({ machine: 'a', caps: {} }), true);
  assert.equal(canBrowser({ machine: 'a', caps: { b: { browser: false } } }), true);
  assert.equal(canBrowser({ machine: 'a', caps: { a: { backend: 'cmux', browser: true } } }), true);
  assert.equal(canBrowser({ machine: 'a', caps: { a: TMUX_CAPS } }), false);
  assert.equal(canBrowser({ machine: null, caps: {} }), true);
});

test('docs: README has the headless tmux section with its settings and the features it loses', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const at = readme.indexOf('### Headless backend (tmux)');
  assert.ok(at > readme.indexOf('## Configuration') && at < readme.indexOf('## Running as a background service'), 'under ## Configuration');
  const sec = readme.slice(at, readme.indexOf('\n## ', at));
  for (const v of ['BACKEND', 'TMUX_BIN', 'TMUX_SOCKET', 'TMUX_SESSION']) assert.ok(sec.includes('`' + v + '`'), v);
  for (const lost of ['No browser tabs', 'No sidebar statuses', 'One tab per pane', 'do not survive a reboot']) assert.ok(sec.includes(lost), lost);
  assert.match(sec, /tmux socket is a full shell for its user/);
  assert.match(sec, /\| workspace \| window \|/);
  const env = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
  for (const v of ['# BACKEND=tmux', '# TMUX_BIN=', '# TMUX_SOCKET=', '# TMUX_SESSION=main']) assert.ok(env.includes(v), v);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:tmux'], 'node --test test/tmux-*.test.js');
  assert.ok(!('dependencies' in pkg) && !('devDependencies' in pkg), 'zero dependencies');
});

test('public repo: no deployment identifiers in the docs, lib/, the fixture script or any p18 test file', () => {
  const IDENT = /jetdevs|172\.16\.|\bray\b|\bstanley\b|cmux-claude|co\.jetdevs/i;
  const files = ['README.md', '.env.example', 'scripts/capture-tmux-fixture.js',
    ...fs.readdirSync(path.join(REPO, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ...fs.readdirSync(path.join(REPO, 'test')).filter((f) => /^(tmux-.*\.test\.js|radar-tmux-identity\.test\.js|p18-.*\.mjs)$/.test(f)).map((f) => `test/${f}`),
    ...['tmux-server.js', 'fake-cmux.js', 'shape.js', 'grid-to-ansi.js'].map((f) => `test/helpers/${f}`),
    ...fs.readdirSync(path.join(REPO, 'test', 'fixtures', 'tmux')).map((f) => `test/fixtures/tmux/${f}`),
  ];
  assert.ok(files.includes('test/tmux-capabilities.test.js') && files.includes('lib/tmux-cli.js'));
  for (const f of files) {
    let src = fs.readFileSync(path.join(REPO, f), 'utf8');
    // this very file has to spell the pattern out to test for it
    if (f === 'test/tmux-capabilities.test.js') src = src.replace(/const IDENT = [^\n]*\n/, '');
    const m = IDENT.exec(src);
    assert.equal(m, null, `${f}: ${m && JSON.stringify(src.slice(Math.max(0, m.index - 40), m.index + 40))}`);
  }
});
