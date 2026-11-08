'use strict';
// p41 D206b — every console line the server / bridge writes (launchd -> *.log / *.err.log) starts with an
// ISO-8601 UTC timestamp, so a slow or failing request can be lined up with load and with the other log.
// install() patches console.log/info/warn/error once per process; LOG_TS=0 leaves console untouched.
const METHODS = ['log', 'info', 'warn', 'error'];
let installed = false;

function stamp(args, now = () => new Date()) {
  const ts = now().toISOString();
  if (typeof args[0] === 'string') return [ts + ' ' + args[0], ...args.slice(1)];   // keeps %s formats working
  return [ts, ...args];
}

function install({ env = process.env, target = console, now } = {}) {
  if (env.LOG_TS === '0') return false;
  if (target === console && installed) return true;
  for (const m of METHODS) {
    const orig = target[m].bind(target);
    target[m] = (...args) => orig(...stamp(args, now));
  }
  if (target === console) installed = true;
  return true;
}

module.exports = { install, stamp };
