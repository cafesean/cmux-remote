'use strict';
// p41 D116: the upload cap fits a phone video; the relay timeout grows with the body.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_UPLOAD_MAX_BYTES, uploadMaxBytes, uploadRelayTimeoutMs } = require('../lib/upload-limits');

test('default cap is 512 MB; UPLOAD_MAX_BYTES overrides; junk falls back', () => {
  assert.equal(DEFAULT_UPLOAD_MAX_BYTES, 512 * 1024 * 1024);
  assert.equal(uploadMaxBytes({}), DEFAULT_UPLOAD_MAX_BYTES);
  assert.equal(uploadMaxBytes({ UPLOAD_MAX_BYTES: '1048576' }), 1048576);
  assert.equal(uploadMaxBytes({ UPLOAD_MAX_BYTES: 'x' }), DEFAULT_UPLOAD_MAX_BYTES);
  assert.equal(uploadMaxBytes({ UPLOAD_MAX_BYTES: '0' }), DEFAULT_UPLOAD_MAX_BYTES);
});

test('relay timeout: 60 s floor, +1 s per MB', () => {
  assert.equal(uploadRelayTimeoutMs(0), 60000);
  assert.equal(uploadRelayTimeoutMs(10), 61000);
  assert.equal(uploadRelayTimeoutMs(512 * 1024 * 1024), 60000 + 512000);
});
