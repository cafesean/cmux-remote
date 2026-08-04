'use strict';
// p11 S-007 — the CLI surfaces, and the contract regression Gate 2 verification caught.
//
// THE RENDERING RULE UNDER TEST: native status and canonical status are shown TOGETHER, always.
// The tracker stays the authority; radar's projection is a derived opinion, and a surface that
// showed only the projection would quietly promote it to truth. Same reason a null route must name
// its cause — "unresolved" alone is a shrug, and the cause is the actionable half.
//
// THE CONTRACT REGRESSION: p11 first added `agile` INSIDE loadJiraConfig's returned `cfg`, silently
// widening an object that existing code and tests compare against. "Additive" has to hold at every
// boundary, not only at state.json — a new key inside an existing object is a change to that
// object. The settings now travel as a sibling field, and the shape is pinned below so it cannot
// drift again.
const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { main } = require('../radar/radar-cli');
const { loadJiraConfig } = require('../radar/mod-jira');
const store = require('../radar/store');

function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, stdout: () => out.join(''), stderr: () => err.join('') };
}

const WORKREF = (over) => Object.assign({
  urn: 'urn:work:jira:PROJ-1', source: 'jira', sourceId: 'PROJ-1', kind: 'epic', title: 'a thing',
  status: { native: 'Ready for Code Review', nativeCategory: 'indeterminate', canonical: 'active' },
  cluster: 'PROJ-1', links: [], selectable: true,
  route: { kind: 'resume', sessionId: 'sess-aaaaaaaa', machine: 'leader-1', reason: 'idle 600s' },
}, over);

async function withState(workRefs, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p11-cli-'));
  await store.writeJsonAtomic(path.join(dir, 'state.json'), {
    v: 1, generatedAt: new Date().toISOString(), collectorId: 'leader-1', machines: [],
    sources: {}, counts: {}, repos: {}, epics: [], sessions: [], attention: [],
    handoffs: [], handoffRecovery: null, role: 'leader', jiraDrift: [], workRefs,
  });
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

test('radar work renders NATIVE and CANONICAL status together', async () => {
  await withState([WORKREF()], async (dir) => {
    const c = capture();
    const code = await main(['work', '--dir', dir], c.io);
    assert.strictEqual(code, 0);
    const s = c.stdout();
    assert.match(s, /Ready for Code Review/, "the tracker's own word must be visible");
    assert.match(s, /active/, "radar's projection must be visible");
    assert.match(s, /resume sess-aaa/);
  });
});

test('radar work marks selectable rows and can filter to them', async () => {
  const refs = [WORKREF(), WORKREF({ urn: 'urn:work:jira:PROJ-2', sourceId: 'PROJ-2', selectable: false, status: { native: 'To Do', nativeCategory: 'new', canonical: 'inbox' } })];
  await withState(refs, async (dir) => {
    const all = capture();
    await main(['work', '--dir', dir], all.io);
    assert.match(all.stdout(), /2 shown · 1 selectable of 2/);

    const only = capture();
    await main(['work', '--selectable', '--dir', dir], only.io);
    assert.ok(!only.stdout().includes('PROJ-2'), 'the unselectable row is filtered out');
  });
});

test('radar work says so plainly when there is nothing intaken', async () => {
  await withState([], async (dir) => {
    const c = capture();
    assert.strictEqual(await main(['work', '--dir', dir], c.io), 0);
    assert.match(c.stdout(), /no WorkRefs/);
  });
});

test('radar route names the CAUSE when there is no route', async () => {
  const busy = WORKREF({ route: { kind: null, sessionId: null, machine: null, reason: 'cluster-running' } });
  await withState([busy], async (dir) => {
    const c = capture();
    assert.strictEqual(await main(['route', 'urn:work:jira:PROJ-1', '--dir', dir], c.io), 0);
    const s = c.stdout();
    assert.match(s, /route\s+none/);
    assert.match(s, /reason\s+cluster-running/, 'the cause is the actionable half');
    assert.match(s, /tracker says\s+Ready for Code Review/);
  });
});

test('radar route on an unknown urn exits 2 rather than rendering an empty success', async () => {
  await withState([WORKREF()], async (dir) => {
    const c = capture();
    assert.strictEqual(await main(['route', 'urn:work:jira:NOPE-9', '--dir', dir], c.io), 2);
    assert.match(c.stderr(), /no WorkRef/);
  });
});

test('radar route with no urn is a usage error, not a crash', async () => {
  await withState([], async (dir) => {
    const c = capture();
    assert.strictEqual(await main(['route', '--dir', dir], c.io), 2);
  });
});

// ---- the contract regression Gate 2 caught -----------------------------------------------------

test('loadJiraConfig returns the ORIGINAL cfg shape exactly — agile travels as a sibling', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-p11-cfg-'));
  const p = path.join(dir, 'config.json');
  try {
    await store.writeJsonAtomic(p, { configVersion: 1, jira: { baseUrl: 'https://jira.example.com/', projects: ['PROJ'] } });
    const r = await loadJiraConfig(p);
    // Exactly the three p5 keys. A fourth key here is the regression, whether or not any current
    // test happens to compare the whole object.
    assert.deepStrictEqual(Object.keys(r.cfg).sort(), ['baseUrl', 'projects', 'tokenRef']);
    assert.deepStrictEqual(r.cfg, { baseUrl: 'https://jira.example.com', tokenRef: 'JIRA_API_TOKEN', projects: ['PROJ'] });
    assert.deepStrictEqual(r.agile, { enabled: false, maxIssuesPerScan: 500 }, 'the p11 settings are a sibling, not a new key inside cfg');

    await store.writeJsonAtomic(p, { configVersion: 1, jira: { baseUrl: 'https://jira.example.com', projects: ['PROJ'], agile: { enabled: true, maxIssuesPerScan: 25 } } });
    const on = await loadJiraConfig(p);
    assert.deepStrictEqual(Object.keys(on.cfg).sort(), ['baseUrl', 'projects', 'tokenRef'], 'still exactly three, even when agile is configured');
    assert.deepStrictEqual(on.agile, { enabled: true, maxIssuesPerScan: 25 });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
