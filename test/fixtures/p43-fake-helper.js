'use strict';
// Fake hm-screen-stream for test/p43-screen-stream.test.js: no capture, no input. Behaviour from FAKE_HELPER_MODE.
const S = require('../../lib/screen-stream');
const B = process.env.FAKE_HELPER_MODE || 'ok';
const out = (o) => process.stdout.write(S.frame(S.encodePacket({ type: 5, gen: 0, seq: 0 }, Buffer.from(JSON.stringify(o)))));
let buf = '';
let gen = null;   // like InputCore.admit: input of another gen than the last start is stale
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const op = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (op.op === 'start') { gen = op.gen; out({ kind: 'started' }); process.stdout.write(S.frame(S.encodePacket({ type: 1, gen: op.gen, seq: 0 }, Buffer.from('idr')))); }
    if (op.op === 'input') { if (B === 'die_on_input') process.exit(3); if (gen != null && op.gen !== gen) { for (const it of op.items) out({ kind: 'failed', epoch: op.epoch, seq: it.seq, why: 'stale' }); continue; } for (const it of op.items) out({ kind: 'posted', epoch: op.epoch, seq: it.seq }); }
    if (op.op === 'release') out({ kind: 'released', epoch: op.epoch });
    if (op.op === 'stop') process.exit(0);
  }
});
