'use strict';
// D183: a configured start folder that is a symlink is returned AS GIVEN (the mini vault symlink
// resolves to a real mount path that a host process guard kills); dedupe still uses
// the real folder; the server's own releases/<sha> dirs are never suggested.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sd = require('../lib/start-dir');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd183-')));
const real = path.join(root, 'Obsidian'); fs.mkdirSync(real);
const link = path.join(root, 'vault'); fs.symlinkSync(real, link);
const rel = path.join(root, 'releases', '815240155057', 'bin'); fs.mkdirSync(rel, { recursive: true });
const home = path.join(root, 'home'); fs.mkdirSync(home);

test('validStartDir keeps the symlink spelling, still checks the target is a dir', () => {
  assert.equal(sd.validStartDir(link), link);
  assert.equal(sd.validStartDir(link + '/../vault'), link);
  fs.writeFileSync(path.join(root, 'f'), '');
  fs.symlinkSync(path.join(root, 'f'), path.join(root, 'flink'));
  assert.equal(sd.validStartDir(path.join(root, 'flink')), null);
});

test('startDirs: configured symlink shown as given, real-path duplicate dropped, release dirs filtered', () => {
  const out = sd.startDirs({ extras: [link, real], workspaceCwds: [rel], home });
  const paths = out.map((d) => d.path);
  assert.ok(paths.includes(link), JSON.stringify(paths));
  assert.ok(!paths.includes(real), 'real path is a duplicate of the link');
  assert.ok(!paths.some((p) => /\/releases\//.test(p)), JSON.stringify(paths));
});

test('workspace/pane cwd at the resolved path maps back to the configured symlink alias (and subdirs)', () => {
  const sub = path.join(real, 'Projects'); fs.mkdirSync(sub, { recursive: true });
  assert.equal(sd.validStartDir(real, [link]), link);
  assert.equal(sd.validStartDir(sub, [link]), path.join(link, 'Projects'));
  assert.equal(sd.validStartDir(real, []), real);   // no alias configured: unchanged
  const out = sd.startDirs({ workspaceCwds: [real, rel], extras: [link], home });
  assert.deepEqual(out.filter((d) => d.path.includes('Obsidian')), [], JSON.stringify(out));
  assert.equal(out[0].path, link);
  assert.equal(out[0].source, 'workspace');
});
