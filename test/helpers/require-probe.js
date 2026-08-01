'use strict';
// A `--require` preload that logs every module request the process makes, to $REQUIRE_PROBE_OUT.
//
// It exists to prove a NEGATIVE: that with RADAR_ENABLED unset, nothing under radar/ is ever
// loaded. A route returning 404 cannot prove that — a 404 is equally consistent with radar being
// fully loaded and merely declining to answer. The require graph is the only witness that the
// "zero radar code paths active" rollback claim is structural rather than aspirational.
//
// (This file lives under test/ but declares no tests; `node --test` treats it as a file with zero
// subtests, which passes.)
const Module = require('module');
const fs = require('fs');

const out = process.env.REQUIRE_PROBE_OUT;
if (out) {
  const orig = Module._load;
  Module._load = function (request) {
    try { fs.appendFileSync(out, `${request}\n`); } catch (_) { /* probing must never break the run */ }
    return orig.apply(this, arguments);
  };
}
