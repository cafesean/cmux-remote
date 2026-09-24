'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(REPO, 'public/sw.js'), 'utf8');

test('latest client shell uses the v20 cache generation everywhere', () => {
  assert.match(index, /<script src="\/app\.js\?v=v20-[^"]+"><\/script>/);
  assert.match(index, /serviceWorker\.register\('\/sw\.js\?v=v20'\)/);
  assert.match(sw, /const CACHE = 'cmux-shell-v20';/);
});
