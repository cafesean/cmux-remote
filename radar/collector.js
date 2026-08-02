'use strict';
// collector — the orchestrator. Runs each module, merges the fragments, publishes state.json.
//
// PARTIAL-FAILURE PUBLICATION (spec §3, binding). A module failure NEVER blocks publication:
//
//     data     = last-good, PER FRAGMENT (the failed module's slice is carried forward unchanged)
//     metadata = always fresh (sources.<module> carries this scan's {status, observedAt, error})
//
// So a scan where mod-git dies still publishes a NEW snapshot: yesterday's repo facts, today's
// error badge. The whole-file last-good rule applies to exactly one case — the atomic publication
// itself failing, in which case nothing is written and the previous state.json stands.
//
// Every module runs inside its own try/catch. A corrupt config, a corrupt state file, a repo that
// is not a repo: all of them produce error SOURCES, never a crash. The collector must never be
// able to take down the process that hosts it.
const os = require('os');
const path = require('path');
const { loadConfig } = require('./config');
const { collectGit } = require('./mod-git');
const { collectSessions } = require('./mod-sessions');
const { collectDeploy } = require('./mod-deploy');
const { collectJira } = require('./mod-jira');
const { collectSpecs, applySpecTag } = require('./mod-specs');
const { classifyBlocked } = require('./classify');
const { createPusher } = require('./push');
const { derive, flattenAttention } = require('./derive');
const store = require('./store');

// P1 implements `git`. The rest are declared here so their absence renders as an explicit
// `disabled` source rather than as silence — a consumer can always tell "no data" from "no module".
// S-004/S-005/S-008/S-009 add their impl to DEFAULT_MODULES and the orchestration below is unchanged.
const MODULES = ['git', 'sessions', 'deploy', 'jira', 'specs'];
// One entry per line so that stories landing modules in parallel touch disjoint lines.
const DEFAULT_MODULES = {
  git: collectGit,
  sessions: collectSessions,
  deploy: collectDeploy,
  jira: collectJira,
  specs: collectSpecs,
};

// A REFUSAL is "your request names something radar does not know" — a stale UI, a typo, a snapshot
// that has not been taken yet. It is the caller's problem and maps to 422. Anything else thrown out
// of a mutation (disk full, a bug in here) is radar's problem and must surface as 500: a fault
// wearing a 4xx tells the caller to fix their input when the thing to fix is this process.
class RadarRefusal extends Error {
  constructor(message) { super(message); this.name = 'RadarRefusal'; this.radarRefusal = true; }
}
const refuse = (message) => new RadarRefusal(message);
const isRefusal = (e) => !!(e && e.radarRefusal === true);

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'decision';

// Rebuild each module's fragment from the last published snapshot. state.json is the durable
// carry-forward store, which is what makes carry-forward survive a process restart too.
function fragmentsFromState(state) {
  const out = { git: { repos: {} }, deploy: { repos: {} }, sessions: { sessions: [], machines: null }, jira: { epics: {} }, specs: { specOrphans: [], epics: {} } };
  if (!state || !state.repos) return out;
  for (const id of Object.keys(state.repos)) {
    const r = state.repos[id];
    out.git.repos[id] = {
      path: r.path, defaultBranches: r.defaultBranches, branches: r.branches,
      worktrees: r.worktrees, deploy: null, fetch: r.fetch,
    };
    if (r.deploy) out.deploy.repos[id] = r.deploy;
  }
  out.sessions = { sessions: state.sessions || [], machines: state.machines || null };

  // jira + specs were NOT carried forward. Any scan that did not run those modules — `--no-fetch`,
  // or the 60s session-only sweep — republished them as empty WHILE `sources.jira` / `sources.specs`
  // were carried forward as `ok`. On the real board that silently dropped 34 jiraDrift rows and
  // reset every spec ladder cell, under a green badge: data loss reported as health, which is the
  // one thing this collector's partial-failure contract exists to prevent.
  out.jira.drift = Array.isArray(state.jiraDrift) ? state.jiraDrift : [];
  for (const e of (state.epics || [])) {
    if (e && e.key && e.jira) out.jira.epics[e.key] = e.jira;
    // The ladder cell is the only spec fact state.json keeps. `done` came from a GO verdict,
    // `partial` from a folder without one; `none`/`unknown` mean there was nothing to carry.
    // `folders` cannot be reconstructed and is not read by derive — only `stage` is.
    if (e && e.key && e.ladder) {
      if (e.ladder.spec === 'done') out.specs.epics[e.key] = { stage: 'done', folders: [] };
      else if (e.ladder.spec === 'partial' || e.ladder.spec === 'current') out.specs.epics[e.key] = { stage: 'draft', folders: [] };
    }
  }
  // Spec-orphans survive in attention[], where groups fold members inside `items`.
  const orphans = [];
  for (const it of (state.attention || [])) {
    if (!it) continue;
    if (it.type === 'spec-orphan') orphans.push({ specFolder: it.specFolder, project: it.project || null });
    else if (it.type === 'spec-orphan-group' && Array.isArray(it.items)) {
      for (const m of it.items) if (m && m.type === 'spec-orphan') orphans.push({ specFolder: m.specFolder, project: m.project || null });
    }
  }
  out.specs.specOrphans = orphans;
  return out;
}

function createCollector(opts) {
  const o = opts || {};
  const radarDir = o.radarDir || store.defaultRadarDir();
  const paths = {
    dir: radarDir,
    config: o.configPath || path.join(radarDir, 'config.json'),
    state: path.join(radarDir, 'state.json'),
    aliases: path.join(radarDir, 'aliases.json'),
    decisions: path.join(radarDir, 'decisions.json'),
    events: path.join(radarDir, 'events'),
  };
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const collectorIdOverride = o.collectorId || null;
  // Injectable so a test can make a module throw and prove the carry-forward contract, and so the
  // P2 modules can be wired in without touching the orchestration loop.
  const modules = Object.assign({}, DEFAULT_MODULES, o.modules || {});
  // p9 §5.2.6. Injectable for the same reason `modules` is: a test must be able to make the stage
  // throw and prove the sweep still publishes.
  const classifyStage = typeof o.classifyBlocked === 'function' ? o.classifyBlocked : classifyBlocked;

  let inflight = null;
  let timer = null;
  let sweepTimer = null;
  let lastState = null;
  const stats = { scans: 0, coalesced: 0, lastDurationMs: null, lastScanAt: null, sweeps: 0, pushed: 0 };

  async function readLastState() {
    if (lastState) return lastState;
    const r = await store.readJson(paths.state, null);
    if (r.ok && r.value && r.value.v === 1) { lastState = r.value; return lastState; }
    return null;
  }

  async function runScan(runOpts) {
    const ro = runOpts || {};
    const t0 = Date.now();
    const now = clock();
    const observedAt = new Date(now).toISOString();
    const warnings = [];

    // --- inputs. Each read is independently degradable.
    const { config, source: configSource } = await loadConfig(paths.config, now);
    const collectorId = collectorIdOverride || config.collectorId || os.hostname();

    const aliasesRead = await store.readJson(paths.aliases, {});
    const decisionsRead = await store.readJson(paths.decisions, []);
    const configIssues = [];
    if (configSource.error) configIssues.push(configSource.error);
    if (!aliasesRead.ok) configIssues.push(aliasesRead.error);
    if (!decisionsRead.ok) configIssues.push(decisionsRead.error);
    const sources = {};
    sources.config = configIssues.length ? { status: 'error', observedAt, error: configIssues.join('; ') } : { status: 'ok', observedAt };

    const aliases = aliasesRead.ok && aliasesRead.value && typeof aliasesRead.value === 'object' ? aliasesRead.value : {};
    const decisions = decisionsRead.ok && Array.isArray(decisionsRead.value) ? decisionsRead.value : [];

    const prev = await readLastState();
    const carried = fragmentsFromState(prev);
    const fragments = {};

    // --- modules. One try/catch each; the fragment falls back to last-good, the source stays fresh.
    // `only` (the 60 s session sweep) runs a SUBSET: the skipped modules keep both their fragment
    // and their previous source metadata, because we did not re-observe them and inventing a fresh
    // observedAt for data we did not look at would be a small lie that compounds.
    const only = Array.isArray(ro.only) && ro.only.length ? ro.only : null;
    for (const name of MODULES) {
      const impl = modules[name];
      if (only && only.indexOf(name) === -1) {
        fragments[name] = carried[name];
        sources[name] = (prev && prev.sources && prev.sources[name]) || { status: impl ? 'stale' : 'disabled', observedAt };
        continue;
      }
      if (!impl) {
        fragments[name] = carried[name];
        sources[name] = { status: 'disabled' };
        continue;
      }
      try {
        // `fragments` carries what earlier modules in MODULES order already produced. mod-deploy
        // needs mod-git's branch tips to answer ancestry; mod-jira needs them to know which epic
        // keys exist. Later modules see earlier fragments; earlier ones see carry-forward.
        // `prev` is this module's own last-good fragment (mod-sessions carries sessions forward
        // across a bridge outage); `collectorId` names the leader for push producer-fencing.
        const r = await impl({ config, aliases, decisions, now, fetch: ro.fetch !== false, paths, fragments, prev: carried[name], collectorId });
        // A module that degrades itself (fetch stale, one repo down) still publishes its own data
        // and its own status. Only a hard throw triggers carry-forward.
        fragments[name] = r && r.fragment ? r.fragment : carried[name];
        sources[name] = (r && r.source) || { status: 'error', observedAt, error: `${name} returned no source` };
        if (r && Array.isArray(r.warnings)) for (const w of r.warnings) warnings.push(w);
      } catch (e) {
        fragments[name] = carried[name];
        sources[name] = { status: 'error', observedAt, error: e && e.message ? e.message : String(e) };
        warnings.push(`${name}: ${sources[name].error}`);
      }
    }

    // p6: the handoff module is the server's, not the collector's (principle 8 — one writer), so
    // its published view arrives through runOpts rather than being constructed here. Without this
    // line derive() always sees handoffs: [] and suppression is inert: every dispatched row stays
    // on the board, which reads as "the feature does nothing" rather than as a failure.
    //
    // It is READ-ONLY and defensive. publish() reflects in-memory state owned by another module,
    // and a throw here would fail the whole scan and take the last-good publication with it — so a
    // bad publish degrades to "no handoffs", which suppresses nothing. Suppressing nothing is the
    // safe direction; suppressing wrongly hides a real row.
    let handoffView = { handoffs: [], handoffRecovery: null };
    const publish = runOpts && runOpts.handoffPublish;
    if (typeof publish === 'function') {
      try {
        const v = publish();
        if (v && Array.isArray(v.handoffs)) {
          handoffView = { handoffs: v.handoffs, handoffRecovery: v.handoffRecovery || null };
        }
      } catch (e) { warnings.push(`handoff publish: ${e && e.message ? e.message : e}`); }
    }

    // --- p9 §5.2.6. The classify stage sits BETWEEN the module loop and derive, and is AWAITED, so
    // a published row never carries a half-resolved verdict. Publication is delayed by at most
    // CLASSIFY_DEADLINE_MS — that bound is the contract, not "no delay".
    //
    // NOTHING MAY THROW OUT OF IT. A classifier outage that failed the sweep would take down the
    // git, deploy, jira and spec facts alongside it, which inverts the partial-failure contract at
    // the top of this file. So a whole-stage throw degrades to `unknown · stage failed` on every
    // blocked session and the sweep publishes exactly as it would have.
    const sessionRows = fragments.sessions && Array.isArray(fragments.sessions.sessions)
      ? fragments.sessions.sessions : null;
    if (sessionRows && sessionRows.some((s) => s && s.status === 'blocked')) {
      try {
        await classifyStage(sessionRows, { config, env: process.env, network: ro.fetch !== false, now: clock, radarDir: paths.dir });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        for (const s of sessionRows) {
          if (s && s.status === 'blocked') s.intent = { verdict: 'unknown', reason: 'stage failed', model: null, at: observedAt, inferred: true };
        }
        warnings.push(`classify: ${msg}`);
      }
    }

    const state = derive({
      now, collectorId, config, sources, aliases, decisions, fragments,
      handoffs: handoffView.handoffs, handoffRecovery: handoffView.handoffRecovery,
    });

    // --- publication. This is the ONLY place the whole-file last-good rule applies.
    try {
      await store.writeJsonAtomic(paths.state, state);
      lastState = state;
    } catch (e) {
      stats.lastDurationMs = Date.now() - t0;
      return { ok: false, state, published: false, warnings, error: `publish failed: ${e.message}`, durationMs: stats.lastDurationMs };
    }

    // --- push WAL (S-006). Leader only, and strictly after publication: the queue may only ever
    // describe a snapshot that is already on disk. A push failure is logged into `warnings` and
    // never fails the scan — the WAL is downstream of the truth, not a gate on it.
    try {
      const pusher = createPusher({ dir: paths.events, role: config.role, cursorPath: path.join(paths.dir, 'push-state.json'), now: clock });
      const r = pusher.emit(state);
      if (r.emitted.length) stats.pushed += r.emitted.length;
    } catch (e) {
      warnings.push(`push: ${e && e.message ? e.message : String(e)}`);
    }

    stats.scans++;
    stats.lastDurationMs = Date.now() - t0;
    stats.lastScanAt = observedAt;
    return { ok: true, state, published: true, warnings, error: null, durationMs: stats.lastDurationMs };
  }

  // Single in-flight scan. Concurrent callers COALESCE onto the running one rather than queueing a
  // second fan-out over 200 git spawns.
  function scan(runOpts) {
    if (inflight) { stats.coalesced++; return inflight; }
    const p = runScan(runOpts);
    inflight = p;
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    return p;
  }

  async function getState() {
    const s = await readLastState();
    return s;
  }

  // The session sweep (S-004). Its own 60 s cadence, DECOUPLED from the 10-minute git scan: a
  // blocked session must be seen inside two sweeps, and a fan-out over ~200 git spawns every minute
  // to achieve that would be absurd. It coalesces onto a full scan if one is already running.
  // p6 riders on the session sweep. Both run AFTER the scan has republished state.json, because
  // both read the fresh snapshot: M1 resolves a session's git facts from it, and M3 decides
  // `resolved` from whether the fact keys are still present.
  //
  // Neither may break the sweep. A throw here would stop the timer's only useful work and, worse,
  // would stop the handoff lifecycle from ever observing a dead process — which is the one
  // direction that must not fail, since a handoff that is never evaluated never releases its keys.
  // So each is isolated: it logs and the sweep continues.
  async function sweepRiders(runOpts) {
    const warnings = [];
    try {
      const cap = require('./stop-capture.js');
      // `collectorId` and the loaded config are scoped inside scan(), so re-resolve them the same
      // way here rather than hoisting scan's locals — the sweep is a separate entry point and
      // sharing mutable scan state between them would couple two lifetimes for no gain.
      const now = clock();
      const { config } = await loadConfig(paths.config, now);
      const machine = collectorIdOverride || config.collectorId || os.hostname();
      const r = await cap.sweepStopCapture({ now, machine, paths, config });
      if (r && r.warnings) warnings.push(...r.warnings);
    } catch (e) { warnings.push(`stop-capture: ${e && e.message ? e.message : e}`); }

    // The handoff lifecycle is wired by the server, which owns the single writer (spec principle 8)
    // and hands its sweep in through runOpts. The collector does not construct it: doing so would
    // put a second p6 writer in the CLI's process the moment anyone runs `radar scan`.
    const hs = runOpts && runOpts.handoffSweep;
    if (typeof hs === 'function') {
      try { await hs(); } catch (e) { warnings.push(`handoff sweep: ${e && e.message ? e.message : e}`); }
    }
    return warnings;
  }

  // Riders run BEFORE the scan, and the ordering is load-bearing in a way the obvious one is not.
  //
  // Running them after means every state change the handoff sweep itself produces — adopted_auto,
  // abandoned, resolved, the undecidable set — misses the publication that just happened and waits
  // for the NEXT one, up to a full sweep later. That silently doubles the spec's own bounds: the
  // recovery element would be computed at grace + 1 sweep but published at grace + 2, and §11
  // promises the former.
  //
  // The cost of going first is that riders decide against the PREVIOUS snapshot, so their git facts
  // are up to one sweep stale. That errs in the safe direction: a fact that has just disappeared
  // still reads as present, so `resolved` fires one sweep late and a key is held slightly longer.
  // Holding a key too long suppresses a row; releasing one too early permits a second dispatch
  // against live work. Only one of those is recoverable.
  function sweepSessions(runOpts) {
    stats.sweeps++;
    const opts = runOpts || {};
    return sweepRiders(opts).then((w) =>
      scan(Object.assign({}, opts, { only: ['sessions'] })).then((res) => {
        if (w.length && res && Array.isArray(res.warnings)) res.warnings.push(...w);
        return res;
      }));
  }

  function start(runOpts) {
    if (timer) return;
    const cfg = store.readJsonSync(paths.config, {});
    const mins = cfg.ok && cfg.value && Number(cfg.value.scanIntervalMin) > 0 ? Number(cfg.value.scanIntervalMin) : 10;
    timer = setInterval(() => { scan(runOpts).catch(() => {}); }, Math.max(1, mins) * 60 * 1000);
    // unref: radar must never be the reason a process refuses to exit.
    if (typeof timer.unref === 'function') timer.unref();
    const secs = cfg.ok && cfg.value && Number(cfg.value.sessionSweepSec) > 0 ? Number(cfg.value.sessionSweepSec) : 60;
    sweepTimer = setInterval(() => { sweepSessions(runOpts).catch(() => {}); }, Math.max(5, secs) * 1000);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    return timer;
  }

  // Idempotent, and the counterpart the server's RADAR_ENABLED rollback depends on.
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  // ---- mutations. All of them go through store's single write queue (temp+rename), including the
  // P1 CLI's — there is no second write path anywhere in radar.

  async function tagBranch(input) {
    const repo = String(input.repo || '').trim();
    const branch = String(input.branch || '').trim();
    const epic = String(input.epic || '').trim();
    if (!repo || !branch || !epic) throw refuse('tag requires repo, branch and epic');
    const state = await readLastState();
    if (!state) throw refuse('no snapshot yet — run `radar scan` first');
    const r = state.repos[repo];
    if (!r) throw refuse(`unknown repo ${repo} (known: ${Object.keys(state.repos).join(', ') || 'none'})`);
    if (!r.branches.some((b) => b.name === branch)) throw refuse(`unknown branch ${repo}:${branch}`);
    return store.updateJson(paths.aliases, {}, (a) => {
      const next = Object.assign({ epics: {}, branchOverrides: {}, flags: {} }, a);
      next.branchOverrides = Object.assign({}, next.branchOverrides);
      next.branchOverrides[`${repo}:${branch}`] = epic;
      return next;
    });
  }

  // Spec-orphan tagging (S-009, spec §M5). Appends the P-NUMERAL of the folder to
  // aliases.epics[epic], creating the array if absent, so the orphan resolves on the next scan.
  // It goes through store.updateJson like every other radar mutation — there is no second write
  // path, and there must never be one.
  async function tagSpec(input) {
    const specFolder = String(input.specFolder || '').trim();
    const epic = String(input.epic || '').trim();
    if (!specFolder || !epic) throw refuse('spec tag requires specFolder and epic');
    const state = await readLastState();
    // Validate against server-known values (spec §7): the folder must be one radar actually saw as
    // an orphan, so a typo cannot quietly write an alias that matches nothing.
    let project = String(input.project || '').trim();
    if (state && Array.isArray(state.attention)) {
      // flattenAttention, never a raw filter: same-type orphans are folded into ONE group row,
      // so a raw filter over attention[] would find zero spec-orphans and validate nothing.
      const orphans = flattenAttention(state.attention).filter((a) => a.type === 'spec-orphan');
      const known = orphans.map((a) => a.specFolder);
      if (known.length && known.indexOf(specFolder) === -1) {
        throw refuse(`unknown spec folder ${specFolder} (open spec-orphans: ${known.join(', ') || 'none'})`);
      }
      // The same folder name exists under more than one project (`p1-foundation` does), and
      // spec-orphan identity is folder-name-only — so an unqualified tag would hide BOTH. Resolve
      // the project when it is unambiguous; demand it when it is not.
      const matches = orphans.filter((a) => a.specFolder === specFolder);
      const projects = Array.from(new Set(matches.map((a) => a.project).filter(Boolean)));
      if (!project) {
        if (projects.length > 1) {
          throw refuse(`spec folder ${specFolder} exists in ${projects.length} projects (${projects.join(', ')}); pass --project to say which`);
        }
        if (projects.length === 1) project = projects[0];
      } else if (projects.length && projects.indexOf(project) === -1) {
        throw refuse(`spec folder ${specFolder} is not in project ${project} (found in: ${projects.join(', ')})`);
      }
    }
    return store.updateJson(paths.aliases, {}, (a) => applySpecTag(a, specFolder, epic, project));
  }

  async function setFlag(input) {
    const epic = String(input.epic || '').trim();
    const state = String(input.state || '').trim();
    if (!epic) throw refuse('flag requires an epic');
    if (['on', 'off', 'n/a'].indexOf(state) === -1) throw refuse('flag state must be on|off|n/a');
    const assertedAt = new Date(clock()).toISOString().slice(0, 10);
    return store.updateJson(paths.aliases, {}, (a) => {
      const next = Object.assign({ epics: {}, branchOverrides: {}, flags: {} }, a);
      next.flags = Object.assign({}, next.flags);
      next.flags[epic] = { state, assertedAt };
      return next;
    });
  }

  async function addDecision(input) {
    const title = String(input.title || '').trim();
    if (!title) throw refuse('decide requires a title');
    const since = new Date(clock()).toISOString();
    let created = null;
    await store.updateJson(paths.decisions, [], (list) => {
      const arr = Array.isArray(list) ? list.slice() : [];
      const base = slug(title);
      let id = base;
      for (let i = 2; arr.some((d) => d && d.id === id); i++) id = `${base}-${i}`;
      created = {
        id, title, since,
        context: input.context ? String(input.context) : null,
        epic: input.epic ? String(input.epic).trim() : null,
        closedAt: null,
      };
      arr.push(created);
      return arr;
    });
    return created;
  }

  // Reopen is deliberately NOT supported: per spec §5 a reopened decision is a NEW id, so history
  // stays append-only and `since` never lies about how long the question has been open.
  async function closeDecision(id) {
    const key = String(id || '').trim();
    if (!key) throw refuse('decided requires a decision id');
    let found = false;
    await store.updateJson(paths.decisions, [], (list) => {
      const arr = Array.isArray(list) ? list : [];
      const next = arr.map((d) => {
        if (!d || d.id !== key || d.closedAt) return d;
        found = true;
        return Object.assign({}, d, { closedAt: new Date(clock()).toISOString() });
      });
      return next;
    });
    if (!found) throw refuse(`no open decision with id ${key}`);
    return true;
  }

  return {
    paths, stats, scan, sweepSessions, getState, start, stop,
    // SYNCHRONOUS snapshot accessor. p6 needs one: handoff.js reads the state inside preview,
    // commit and the sweep, and every one of those decides on `if (!state)`. Handing it an async
    // getState() there is silently catastrophic — a Promise is TRUTHY, so the `503 no_snapshot`
    // branch never fires, state.repos is undefined, every selector resolves to zero fact keys, and
    // EVERY preview answers 422 selector_unresolved no matter what is on the board. It reads as a
    // selector bug and is not one. Unit tests that stub a sync getState pass throughout; the seam
    // only shows up against a real server, which is what caught it.
    // Returns the last PUBLISHED state. Before this process has published anything it falls back
    // to reading state.json once, synchronously, so a server that restarts with a good snapshot on
    // disk does not answer 503 for the whole window until its boot scan lands. Still null when
    // there is genuinely no snapshot — which is the honest answer the 503 branch is written for.
    // Republish the CURRENT snapshot with a fresh p6 view, without re-scanning anything.
    //
    // §7.2 promises that one press always clears the recovery element. It did not: a discard's kill
    // rounds run inside the sweep that would otherwise republish, so the PRE-PRESS element sat on
    // disk for the whole drive — up to 2 x discardKillMs — and a tab polling in that window still
    // showed an element the operator had already dismissed. That is the "one press, two outcomes"
    // guarantee failing in the only place a user can see it.
    //
    // Deliberately NOT a scan: no git, no bridge, no deploy probe. It re-derives from the fragments
    // of the last published state and swaps in the caller's handoff view, so it is cheap enough to
    // run on a keypress. No snapshot yet means nothing to republish, which is not an error.
    republishHandoffView: async (view) => {
      const base = lastState;
      if (!base) return false;
      const next = Object.assign({}, base, {
        handoffs: (view && Array.isArray(view.handoffs)) ? view.handoffs : [],
        handoffRecovery: (view && view.handoffRecovery) || null,
        counts: Object.assign({}, base.counts, {
          handoffsLive: (view && Array.isArray(view.handoffs)) ? view.handoffs.length : 0,
        }),
      });
      await store.writeJsonAtomic(paths.state, next);
      lastState = next;
      return true;
    },
    lastStateSync: () => {
      if (lastState) return lastState;
      const r = store.readJsonSync(paths.state, null);
      if (r.ok && r.value && r.value.v === 1) lastState = r.value;
      return lastState;
    },
    tagBranch, tagSpec, setFlag, addDecision, closeDecision,
    isScanning: () => inflight !== null,
    hasSweepTimer: () => sweepTimer !== null,
    _fragmentsFromState: fragmentsFromState,
  };
}

module.exports = {
  RadarRefusal, refuse, isRefusal, createCollector, fragmentsFromState, MODULES };
