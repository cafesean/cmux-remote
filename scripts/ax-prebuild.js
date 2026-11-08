#!/usr/bin/env node
'use strict';
// p41 D206 — build the AX helper (native/ax-dialogs.swift) into its per-source-hash cache slot BEFORE the
// agents restart, so a new bridge finds the binary ready instead of compiling under load on first use.
// Same build as lib/ax-helper.js ensure() (nice 15, AX_HELPER_BUILD_TIMEOUT_MS). Never fails a deploy:
// exit 0 always; a failed build only means the bridge builds lazily as before.
const { createAxHelper } = require('../lib/ax-helper');
createAxHelper({ env: { ...process.env, AX_HELPER_BIN: '' }, log: (m) => console.log(m) }).ensure()
  .then((r) => { console.log(r.bin ? `ax-prebuild: ready ${r.bin}` : `ax-prebuild: skipped (${r.err})`); })
  .catch(() => {}).finally(() => process.exit(0));
