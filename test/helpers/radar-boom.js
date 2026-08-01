'use strict';
// A `--require` preload that poisons radar/collector.js: every method of the collector throws.
//
// This is how the error-boundary claim gets tested against the REAL server.js rather than against a
// hand-mounted stand-in. It seeds require.cache before server.js runs, so `require('./radar/
// collector')` inside radar-server.js hands back this stub — the collector is broken in exactly the
// way a real bug would break it (constructs fine, explodes on use), and the test then asks the one
// question that matters: does /api/cmux/machines still answer?
//
// (This file lives under test/ but declares no tests; `node --test` treats it as a file with zero
// subtests, which passes.)
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, '..', '..', 'radar', 'collector.js');
const boom = () => { throw new Error('BOOM: injected collector failure'); };

const stub = new Module(target, null);
stub.filename = target;
stub.loaded = true;
stub.exports = {
  createCollector: () => ({
    paths: { dir: path.join(__dirname, 'no-such-radar-dir') },
    stats: {},
    scan: boom,
    getState: boom,
    start: boom,
    stop: boom,
    tagBranch: boom,
    setFlag: boom,
    addDecision: boom,
    closeDecision: boom,
    isScanning: () => false,
  }),
  MODULES: [],
};

require.cache[target] = stub;
