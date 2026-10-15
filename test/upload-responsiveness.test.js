'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { bootBridge } = require('./helpers/bridge-child');

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmux-upload-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const post = (base, name, body = 'upload bytes') => fetch(base + '/cmux/upload', {
  method: 'POST', headers: { 'x-file-name': name }, body,
  signal: AbortSignal.timeout(5000),
});

for (const stage of ['mkdir', 'writeFile']) {
  test(`stalled upload ${stage} does not block unrelated HTTP requests`, async (t) => {
    const dir = await scratch(t);
    const uploadDir = path.join(dir, 'uploads');
    const preload = path.join(dir, 'stall.cjs');
    // Deliberately simulate a stalled disk in a disposable child. Sync calls block
    // its event loop; async calls stay pending while HTTP must remain responsive.
    await fs.writeFile(preload, `
      const fs = require('fs');
      const fsp = require('fs/promises');
      const root = ${JSON.stringify(uploadDir)};
      const stage = ${JSON.stringify(stage)};
      const sync = fs[stage + 'Sync'];
      fs[stage + 'Sync'] = function(p, ...args) {
        if (String(p).startsWith(root)) {
          process.stdout.write('UPLOAD_STALLED\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return sync.call(this, p, ...args);
      };
      const asyncOp = fsp[stage];
      fsp[stage] = function(p, ...args) {
        if (String(p).startsWith(root)) {
          process.stdout.write('UPLOAD_STALLED\\n');
          return new Promise(() => {});
        }
        return asyncOp.call(this, p, ...args);
      };
    `);
    const b = await bootBridge({ cwd: dir, env: { UPLOAD_DIR: uploadDir, NODE_OPTIONS: `--require=${preload}` } });
    t.after(() => b.stop());
    const stalled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('upload never reached injected stall')), 5000);
      b.child.stdout.on('data', function check() {
        if (b.stdout().includes('UPLOAD_STALLED')) { clearTimeout(timer); b.child.stdout.off('data', check); resolve(); }
      });
    });
    const controller = new AbortController();
    const upload = fetch(b.base + '/cmux/upload', { method: 'POST', body: 'x', signal: controller.signal }).catch(() => {});
    try {
      await stalled;
      const r = await fetch(b.base + '/nothing', { signal: AbortSignal.timeout(1500) });
      assert.equal(r.status, 404);
    } finally { controller.abort(); await upload; }
  });
}

test('concurrent uploads use exclusive names and cannot overwrite symlinks or FIFOs', async (t) => {
  const dir = await scratch(t);
  const uploads = path.join(dir, 'uploads');
  const day = path.join(uploads, new Date().toISOString().slice(0, 10));
  await fs.mkdir(day, { recursive: true });
  const protectedFile = path.join(dir, 'protected.txt');
  await fs.writeFile(protectedFile, 'keep');
  await fs.symlink(protectedFile, path.join(day, 'note.txt'));
  execFileSync('/usr/bin/mkfifo', [path.join(day, 'note-1.txt')]);
  const b = await bootBridge({ cwd: dir, env: { UPLOAD_DIR: uploads } });
  t.after(() => b.stop());
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(b.base, 'note.txt', `body-${i}`)));
  const rows = await Promise.all(responses.map(async r => { assert.equal(r.status, 200); return r.json(); }));
  assert.equal(new Set(rows.map(r => r.path)).size, rows.length);
  for (let i = 0; i < rows.length; i++) assert.equal(await fs.readFile(rows[i].path, 'utf8'), `body-${i}`);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep');
  assert.ok((await fs.lstat(path.join(day, 'note-1.txt'))).isFIFO());
  assert.ok(rows.every(r => r.bytes === 6));
});
