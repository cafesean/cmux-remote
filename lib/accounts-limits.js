'use strict';
// p41 S2c — server-side limits for the Claude account routes (in memory, sliding windows).
//   mutation(callerKey, machine): setup + delete, 10 per hour per caller AND 30 per hour per machine.
//   fresh(callerKey): `fresh=1` list reads at most once per 3 s per caller (else served cached).
// callerKey = sha256 of the credential the request authenticated with (never the credential).
const crypto = require('crypto');

const SETUP_PER_CALLER_PER_HOUR = 10;   // accountSetupRate
const SETUP_PER_MACHINE_PER_HOUR = 30;  // accountSetupRateMachine
const FRESH_MIN_MS = 3000;              // accountFreshMinMs (per caller)
const HOUR = 3600 * 1000;
const MAX_KEYS = 10000;                 // bound the maps; oldest keys go first

function createAccountLimits({ now } = {}) {
  const clock = now || Date.now;
  const byCaller = new Map(), byMachine = new Map(), freshAt = new Map();
  const trim = (m) => { while (m.size > MAX_KEYS) m.delete(m.keys().next().value); };
  const recent = (m, k, t) => (m.get(k) || []).filter((x) => t - x < HOUR);
  return {
    mutation(callerKey, machine) {
      const t = clock();
      const c = recent(byCaller, callerKey, t), mm = recent(byMachine, machine, t);
      if (c.length >= SETUP_PER_CALLER_PER_HOUR || mm.length >= SETUP_PER_MACHINE_PER_HOUR) {
        byCaller.set(callerKey, c); byMachine.set(machine, mm);
        return false;
      }
      c.push(t); mm.push(t);
      byCaller.set(callerKey, c); byMachine.set(machine, mm);
      trim(byCaller); trim(byMachine);
      return true;
    },
    fresh(callerKey) {
      const t = clock();
      const last = freshAt.get(callerKey);
      if (last != null && t - last < FRESH_MIN_MS) return false;
      freshAt.delete(callerKey); freshAt.set(callerKey, t); trim(freshAt);
      return true;
    },
  };
}
const callerKeyOf = (credential) => crypto.createHash('sha256').update(String(credential || '')).digest('hex');

module.exports = { createAccountLimits, callerKeyOf, SETUP_PER_CALLER_PER_HOUR, SETUP_PER_MACHINE_PER_HOUR, FRESH_MIN_MS };
