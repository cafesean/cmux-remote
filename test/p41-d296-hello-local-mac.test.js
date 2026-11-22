'use strict';
// p41 D296 — /api/pair/hello carries localMac: an opaque per-Mac id. localMachine is a registry id
// ('default' on every single-Mac Bridge), so two Macs both said 'default' and the app's "same Mac" match
// replaced one Mac's server record with the other's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const { createPairing } = require('../lib/pairing');

const mk = (o) => { const d = fs.mkdtempSync(os.tmpdir() + '/d296p-'); return createPairing({ file: d + '/devices.json', idFile: d + '/server-id', log: { log() {}, warn() {}, error() {} }, ...o }); };

test('D296: hello carries localMac when the server serves a local Mac', () => {
  const h = mk({ localMachine: 'default', localMac: () => 'a1b2c3' }).hello();
  assert.equal(h.localMachine, 'default');
  assert.equal(h.localMac, 'a1b2c3');
});

test('D296: no local Mac (a relay) -> no localMac', () => {
  const h = mk({ localMachine: () => null, localMac: () => 'a1b2c3' }).hello();
  assert.equal(h.localMac, undefined);
});
