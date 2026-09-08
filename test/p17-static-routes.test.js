// Every client module index.html loads must have a route in server.js's static ALLOW-LIST.
//
// This has now failed three times the same way — p7 wrote the warning, p8 shipped gitbar.js dark
// anyway, and p17 shipped sidebar.js dark on top of it. The failure is silent by construction: the
// script 404s, the defensive `if (window.cmuxX)` mount in app.js skips the feature, and everything
// else on the page still works. Only a browser run notices, and a browser run is not what a
// developer reaches for after adding one <script> tag.
//
// So the allow-list gets a mechanical check instead of a comment. Same for the service worker's
// SHELL list: a module that is not precached is not offline-available, which is the other half of
// the same mistake.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

// "/sidebar.js?v=…" → "/sidebar.js". Absolute same-origin sources only; a vendored path under
// /vendor/ is covered by server.js's prefix route, not by a line of its own.
const scripts = [...HTML.matchAll(/<script[^>]*\ssrc="(\/[^"]+)"/g)]
  .map((m) => m[1].split('?')[0])
  .filter((p) => !p.startsWith('/vendor/'));

test('the fixture finds the script tags at all', () => {
  assert.ok(scripts.length >= 5, 'expected several module scripts, got ' + JSON.stringify(scripts));
  assert.ok(scripts.includes('/app.js'), 'app.js is always loaded');
  assert.ok(scripts.includes('/sidebar.js'), 'p17 loads the sidebar module');
});

for (const src of scripts) {
  test(`server.js serves ${src} (allow-list, not a directory)`, () => {
    const file = src.slice(1);
    assert.ok(SERVER.includes(`u.pathname === '${src}'`),
      `server.js has no route for ${src} — the module 404s and the feature ships dark`);
    assert.ok(SERVER.includes(`serveStatic(req, res, '${file}')`),
      `the ${src} route must serve ${file}`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', file)),
      `public/${file} does not exist`);
  });
}

// Not every module is precached — menuparse/git/gitbar deliberately go straight to the network, so
// only what SHELL claims is checked here. The invariant is sw.js's own: a precached script that the
// network-first branch never names leaves its copy sitting unread in Cache Storage.
const shellPaths = (() => {
  const m = /const SHELL = \[([^\]]*)\]/.exec(SW);
  assert.ok(m, 'sw.js must declare a SHELL list');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

test('the sidebar module is precached and network-first', () => {
  assert.ok(shellPaths.includes('/sidebar.js'), 'sw.js SHELL is missing /sidebar.js');
  assert.ok(SW.includes("path === '/sidebar.js'"), 'sw.js must serve /sidebar.js network-first');
});

for (const src of shellPaths.filter((p) => p.endsWith('.js'))) {
  test(`${src} is precached AND read back by the network-first branch`, () => {
    assert.ok(SW.includes(`path === '${src}'`),
      `${src} is in SHELL but the network-first branch never names it — the cached copy is dead weight`);
    assert.ok(scripts.includes(src), `${src} is precached but index.html never loads it`);
  });
}
