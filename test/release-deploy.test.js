// Sandbox tests for scripts/cmux-remote-deploy.sh and scripts/cmux-remote-ctl.sh.
//
// The whole point of the env overrides in scripts/lib/cmux-launchd.sh is that the
// deploy can be exercised without touching the real one: SUPPORT and AGENTS dirs
// are temp directories, launchctl is a stub that records what it was asked to do,
// and the health probe is either disabled or pointed at a dead port.
//
// The archive still comes from the real repo, so these tests assert the property
// that matters: a release contains exactly the tracked content of a commit, plus
// the .env it was handed.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = path.join(REPO, 'scripts', 'cmux-remote-deploy.sh');
const CTL = path.join(REPO, 'scripts', 'cmux-remote-ctl.sh');
const PREFIX = 'com.test.cmux-remote';
const LABELS = [`${PREFIX}.bridge`, `${PREFIX}.server`];

let box; // sandbox root, rebuilt per test

const PLIST = (label, workdir) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array><string>/usr/bin/true</string></array>
\t<key>WorkingDirectory</key>
\t<string>${workdir}</string>
</dict>
</plist>
`;

// Stands in for launchctl: `list` reports both agents loaded (so prefix
// auto-discovery has something to find), every call is appended to a log, and
// kickstart fails on demand.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$1" in
  list)
    printf '4759\\t0\\t${PREFIX}.bridge\\n'
    printf '4761\\t0\\t${PREFIX}.server\\n'
    ;;
  kickstart) [ -n "\${STUB_KICKSTART_FAIL:-}" ] && exit 1 ;;
esac
exit 0
`;

function sandbox({ withPlists = true, workdir = '/nonexistent/initial' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmux-deploy-'));
  const support = path.join(root, 'support');
  const agents = path.join(root, 'agents');
  fs.mkdirSync(path.join(support, 'releases'), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  if (withPlists) {
    for (const l of LABELS) fs.writeFileSync(path.join(agents, `${l}.plist`), PLIST(l, workdir));
  }
  const stub = path.join(root, 'launchctl-stub');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  const env = path.join(root, 'fixture.env');
  fs.writeFileSync(env, 'SERVER_TOKEN=fixture-token\nBRIDGE_SECRET=fixture-secret\n');
  return { root, support, agents, stub, env, log: path.join(root, 'stub.log') };
}

function run(script, args, { extraEnv = {}, expectFail = false } = {}) {
  const env = {
    ...process.env,
    HOME: box.root,
    CMUX_REMOTE_SUPPORT_DIR: box.support,
    CMUX_REMOTE_AGENTS_DIR: box.agents,
    CMUX_REMOTE_LABEL_PREFIX: PREFIX,
    CMUX_LAUNCHCTL: box.stub,
    CMUX_REMOTE_HEALTH_URL: '', // probe disabled unless a test overrides it
    STUB_LOG: box.log,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync('bash', [script, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (expectFail) assert.fail(`expected failure, got:\n${stdout}`);
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (!expectFail) assert.fail(`unexpected failure:\n${out}`);
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', out };
  }
}

const deploy = (args, opts) => run(DEPLOY, args, opts);
const ctl = (args, opts) => run(CTL, args, opts);
const stubLog = () => (fs.existsSync(box.log) ? fs.readFileSync(box.log, 'utf8') : '');
const pointer = (f) => (fs.existsSync(path.join(box.support, f)) ? fs.readFileSync(path.join(box.support, f), 'utf8').trim() : null);
const workdirOf = (label) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :WorkingDirectory', path.join(box.agents, `${label}.plist`)], {
    encoding: 'utf8',
  }).trim();

const sha = (ref) => execSync(`git -C ${REPO} rev-parse --short=12 ${ref}`, { encoding: 'utf8' }).trim();
const trackedAt = (ref) =>
  execSync(`git -C ${REPO} ls-tree -r --name-only ${ref}`, { encoding: 'utf8', maxBuffer: 1e9 }).split('\n').filter(Boolean);

beforeEach(() => { box = sandbox(); });
after(() => { /* temp dirs are left to the OS; each run uses a fresh mkdtemp */ });

test('the scripts parse', () => {
  for (const s of [DEPLOY, CTL, path.join(REPO, 'scripts', 'lib', 'cmux-launchd.sh')]) {
    execFileSync('bash', ['-n', s]);
  }
});

test('deploy refuses when the worktree is dirty, and names the count', () => {
  // Guarantee dirt regardless of the checkout's state.
  const scratch = path.join(REPO, '.deploy-test-dirt');
  fs.writeFileSync(scratch, 'dirt\n');
  try {
    const r = deploy(['deploy', 'HEAD', '--env', box.env], { expectFail: true });
    assert.match(r.out, /uncommitted worktree entries/);
    assert.match(r.out, /--ignore-dirty/);
    assert.equal(fs.readdirSync(path.join(box.support, 'releases')).length, 0, 'nothing exported');
  } finally {
    fs.unlinkSync(scratch);
  }
});

test('deploy exports exactly the tracked content of the commit, plus the .env', () => {
  const head = sha('HEAD');
  deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env]);
  const dir = path.join(box.support, 'releases', head);

  const walk = (d, base = d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      e.isDirectory() ? walk(f, base, out) : out.push(path.relative(base, f));
    }
    return out;
  };
  const inRelease = new Set(walk(dir));
  const expected = new Set(trackedAt('HEAD'));

  assert.ok(inRelease.delete('.env'), '.env was carried in');
  assert.deepEqual([...inRelease].filter((f) => !expected.has(f)), [], 'no untracked file reached the release');
  assert.deepEqual([...expected].filter((f) => !inRelease.has(f)), [], 'every tracked file reached the release');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), fs.readFileSync(box.env, 'utf8'));
});

test('deploy repoints both plists, flips the pointer, and RELOADS both agents', () => {
  const head = sha('HEAD');
  const dir = path.join(box.support, 'releases', head);
  const out = deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env]).stdout;

  assert.equal(workdirOf(LABELS[0]), dir);
  assert.equal(workdirOf(LABELS[1]), dir);
  assert.equal(pointer('CURRENT_RELEASE'), dir);
  for (const l of LABELS) {
    const q = l.replace(/\./g, '\\.');
    assert.match(stubLog(), new RegExp(`bootout gui/\\d+/${q}`));
    assert.match(stubLog(), new RegExp(`bootstrap gui/\\d+ .*${q}\\.plist`));
  }
  assert.match(out, new RegExp(`live: ${head}`));
});

// The regression that made two deploys ship nothing. launchd caches the job spec
// at bootstrap; `kickstart -k` relaunches from that cache, so a WorkingDirectory
// edited on disk is ignored and both agents come back in the PREVIOUS release —
// while the plists, the pointer and `ctl status` all read as the new one, and the
// health probe passes against the old code. Only the process cwd tells the truth.
test('deploy never repoints a plist and then merely kickstarts — launchd would ignore the edit', () => {
  deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env]);
  const log = stubLog();
  const bootstrapAt = log.indexOf('bootstrap');
  assert.ok(bootstrapAt >= 0, 'a deploy must bootstrap the agents so the new plist is read');
  const kick = log.indexOf('kickstart');
  assert.ok(kick < 0, `a deploy must not rely on kickstart to pick up a plist change: ${log}`);
});

test('a second deploy of the same commit is refused unless forced', () => {
  deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env]);
  const r = deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env], { expectFail: true });
  assert.match(r.out, /already exists/);
  deploy(['deploy', 'HEAD', '--ignore-dirty', '--force', '--env', box.env]); // --force re-exports
});

test('the next deploy carries the live .env forward and records the previous release', () => {
  const first = path.join(box.support, 'releases', sha('HEAD~1'));
  const second = path.join(box.support, 'releases', sha('HEAD'));
  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env]);
  deploy(['deploy', 'HEAD', '--ignore-dirty']); // no --env: must come from the live release

  assert.equal(pointer('CURRENT_RELEASE'), second);
  assert.equal(pointer('PREVIOUS_RELEASE'), first);
  assert.equal(fs.readFileSync(path.join(second, '.env'), 'utf8'), fs.readFileSync(box.env, 'utf8'));
});

test('deploy refuses when there is no .env to carry and none given', () => {
  const r = deploy(['deploy', 'HEAD', '--ignore-dirty'], { expectFail: true });
  assert.match(r.out, /no \.env to carry forward/);
  assert.equal(fs.readdirSync(path.join(box.support, 'releases')).length, 0, 'nothing exported');
});

test('a failed health probe rolls back to the previous release', () => {
  const first = path.join(box.support, 'releases', sha('HEAD~1'));
  const second = path.join(box.support, 'releases', sha('HEAD'));

  // A bad release is one that does not come up — so the probe has to answer for
  // whichever release the pointer currently names. A probe that fails
  // unconditionally makes the rollback target look broken too, and proves
  // nothing about the rollback. This one reads the pointer the deploy just
  // wrote and calls only the older release healthy.
  const healthCmd = `[ "$(cat '${path.join(box.support, 'CURRENT_RELEASE')}')" = '${first}' ]`;
  const probe = { CMUX_REMOTE_HEALTH_CMD: healthCmd, CMUX_REMOTE_HEALTH_TRIES: '2' };

  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env], { extraEnv: probe });
  assert.equal(pointer('CURRENT_RELEASE'), first, 'the good release went live');

  const r = deploy(['deploy', 'HEAD', '--ignore-dirty'], { extraEnv: probe, expectFail: true });
  assert.match(r.out, /health probe FAILED — rolling back/);
  assert.match(r.out, /rolled back to/);
  assert.equal(pointer('CURRENT_RELEASE'), first, 'pointer is back on the previous release');
  assert.equal(workdirOf(LABELS[1]), first, 'plists are back on the previous release');
  assert.ok(fs.existsSync(second), 'the failed release stays on disk for inspection');
});

test('when the rollback target is also unhealthy, deploy says the deploy is DOWN', () => {
  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env]);
  const r = deploy(['deploy', 'HEAD', '--ignore-dirty'], {
    // Port 1 refuses connections, so nothing can pass — new release or old.
    extraEnv: { CMUX_REMOTE_HEALTH_URL: 'http://127.0.0.1:1/', CMUX_REMOTE_HEALTH_TRIES: '1' },
    expectFail: true,
  });
  assert.match(r.out, /rollback to .* also failed — the deploy is DOWN/);
});

test('rollback swaps live and previous, and is itself undoable', () => {
  const first = path.join(box.support, 'releases', sha('HEAD~1'));
  const second = path.join(box.support, 'releases', sha('HEAD'));
  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env]);
  deploy(['deploy', 'HEAD', '--ignore-dirty']);

  deploy(['rollback']);
  assert.equal(pointer('CURRENT_RELEASE'), first);
  assert.equal(pointer('PREVIOUS_RELEASE'), second);
  assert.equal(workdirOf(LABELS[0]), first);

  deploy(['rollback']); // rolling back the rollback
  assert.equal(pointer('CURRENT_RELEASE'), second);
  assert.equal(pointer('PREVIOUS_RELEASE'), first);
});

test('rollback refuses when there is nothing recorded to roll back to', () => {
  const r = deploy(['rollback'], { expectFail: true });
  assert.match(r.out, /no PREVIOUS_RELEASE recorded/);
});

test('prune drops old releases but never the live or previous one', () => {
  const releases = path.join(box.support, 'releases');
  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env]);

  // Dated into the future so they sort ahead of both real releases: that is what
  // pushes the live and previous ones OUT of the KEEP window, which is the only
  // way their exemption gets tested rather than assumed.
  const dummies = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'];
  const future = Date.now() / 1000 + 3600;
  for (const name of dummies) {
    fs.mkdirSync(path.join(releases, name));
    fs.writeFileSync(path.join(releases, name, 'marker'), name);
    fs.utimesSync(path.join(releases, name), future, future);
  }

  deploy(['deploy', 'HEAD', '--ignore-dirty'], { extraEnv: { CMUX_REMOTE_KEEP: '1' } });

  const left = fs.readdirSync(releases);
  assert.ok(left.includes(sha('HEAD')), 'live release kept despite being outside KEEP');
  assert.ok(left.includes(sha('HEAD~1')), 'previous release kept — it is the rollback target');
  assert.equal(left.filter((n) => dummies.includes(n)).length, 1, 'stale releases beyond KEEP pruned');
});

test('deploy refuses a ref that is not a commit', () => {
  const r = deploy(['deploy', 'no-such-ref-xyz', '--ignore-dirty', '--env', box.env], { expectFail: true });
  assert.match(r.out, /not a commit/);
});

test('list marks the live and previous releases', () => {
  deploy(['deploy', 'HEAD~1', '--ignore-dirty', '--env', box.env]);
  deploy(['deploy', 'HEAD', '--ignore-dirty']);
  const out = deploy(['list']).stdout;
  assert.match(out, new RegExp(`${sha('HEAD')}\\s+LIVE`));
  assert.match(out, new RegExp(`${sha('HEAD~1')}\\s+previous`));
});

test('ctl resolves the label prefix from launchd when the env does not name one', () => {
  deploy(['deploy', 'HEAD', '--ignore-dirty', '--env', box.env]);
  const out = ctl(['status'], { extraEnv: { CMUX_REMOTE_LABEL_PREFIX: '' } }).stdout;
  assert.match(out, new RegExp(`prefix\\s+${PREFIX}`), 'discovered from the stub launchctl list');
  assert.match(out, new RegExp(`bridge\\s+4759`), 'pid read from the loaded-agent line');
});

test('ctl status flags an agent that is running out of the working tree', () => {
  for (const l of LABELS) fs.writeFileSync(path.join(box.agents, `${l}.plist`), PLIST(l, REPO));
  const out = ctl(['status']).stdout;
  assert.match(out, /!! bridge is running out of the WORKING TREE/);
  assert.match(out, /!! server is running out of the WORKING TREE/);
});

test('ctl restart never mentions ports, and only kickstarts', () => {
  ctl(['restart']);
  const log = stubLog();
  assert.match(log, /kickstart -k/);
  assert.ok(!/bootout|submit|remove/.test(log), `restart must not load, unload or submit: ${log}`);
});

test('ctl stop boots out rather than killing', () => {
  ctl(['stop']);
  const log = stubLog();
  for (const l of LABELS) assert.match(log, new RegExp(`bootout gui/\\d+/${l.replace(/\./g, '\\.')}`));
  assert.ok(!/kill/.test(log), 'KeepAlive would relaunch a mere kill');
});

// `stop` ends with "bring them back with: ctl start", and prefix discovery reads
// the LOADED agents — which stop just unloaded. Discovery therefore has to fall
// back to the plist files, or the documented recovery path cannot run at all.
test('ctl start still resolves the prefix after stop unloaded everything', () => {
  const empty = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$STUB_LOG"\nexit 0\n`;
  fs.writeFileSync(box.stub, empty, { mode: 0o755 });   // `list` now reports nothing loaded
  // run() throws on a non-zero exit, so reaching the assertions IS the pass.
  const r = ctl(['start'], { extraEnv: { CMUX_REMOTE_LABEL_PREFIX: '' } });
  assert.ok(r.ok, 'start must work from a fully stopped state');
  assert.match(r.stdout, new RegExp(`prefix\\s+${PREFIX}`), 'the prefix came from the plist files, not launchctl list');
  for (const l of LABELS) {
    assert.match(stubLog(), new RegExp(`bootstrap gui/\\d+ .*${l.replace(/\./g, '\\.')}\\.plist`));
  }
});
