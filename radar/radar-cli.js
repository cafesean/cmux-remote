#!/usr/bin/env node
'use strict';
// radar CLI — standalone. It talks to the collector directly, so it works with NO server running,
// which is the whole point of P1: the tool is useful before any UI exists.
//
// Zone order matches the Radar tab exactly (spec §7): NOW hero -> queue (4 + overflow) -> the
// folded sections (moving / parked / worktrees to clean). Same data, same order, two renderers.
const path = require('path');
const { createCollector } = require('./collector');
const { flattenAttention } = require('./derive');
const store = require('./store');

const CELL = { done: 'v', current: '>', todo: '.', unknown: '?', violation: '!' };
const LADDER = [['spec', 'spec'], ['pushed', 'pushed'], ['mergedDevelop', 'merged'], ['deployedDev', 'dev'], ['prod', 'prod'], ['flags', 'flag']];
const QUEUE_LIMIT = 4;                       // mockup-v2 limit is canonical
// Column widths are computed from the data so a long epic key never shoves the ladder strip out
// of alignment — the strip is the fastest thing to read and it has to stay in one column.
const KEY_MIN = 14;
const PHRASE_MIN = 42;

const pad = (s, n) => (String(s).length >= n ? String(s) : String(s) + ' '.repeat(n - String(s).length));

function age(fromIso, now) {
  if (!fromIso) return 'never';
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function describeAttention(it) {
  switch (it.type) {
    case 'blocked': return `blocked    ${it.sessionKey.machine}:${String(it.sessionKey.sessionId).slice(0, 8)}${it.epic ? ` (${it.epic})` : ''}`;
    // Same row as `blocked`, marked so the closed window is visible rather than implied by rank.
    case 'blocked-stale': return `blocked!   ${it.sessionKey ? `${it.sessionKey.machine}:${it.sessionKey.sessionId}` : '?'} — cache window closed`;
    case 'default-unpushed': return `unpushed   ${it.repo}:${it.branch} — ${it.unpushed} commit${it.unpushed === 1 ? '' : 's'} never left this disk`;
    case 'rule-violation': return `violation  ${it.repo} ${it.env} — ${it.note}`;
    case 'decision': return `decision   ${it.id} — ${it.title}`;
    case 'mergeable': return `mergeable  ${it.epic}${it.note ? ` — ${it.note}` : ''}`;
    case 'orphan': return `orphan     ${it.repo}:${it.branch}`;
    case 'spec-orphan': return `spec       ${it.specFolder}`;
    // Same-type orphans arrive folded into one row (derive §ORPHAN_GROUP_MIN). `--all` unfolds
    // them, so nothing is unreachable from the CLI either.
    case 'orphan-group': return `orphans    ${it.count} untagged branches — one triage pass`;
    case 'spec-orphan-group': return `specs      ${it.count} untagged spec folders — one triage pass`;
    default: return it.type;
  }
}

// `--all` expands every group in place; the default view keeps them folded.
function expandGroups(list, all) {
  if (!all) return list;
  const out = [];
  for (const it of list) {
    if ((it.type === 'orphan-group' || it.type === 'spec-orphan-group') && Array.isArray(it.items)) {
      out.push(it);
      for (const m of it.items) out.push(m);
    } else out.push(it);
  }
  return out;
}

const ladderStrip = (e) => LADDER.map(([k, label]) => `${label}${CELL[e.ladder[k]] || '?'}`).join(' ');

function renderStatus(state, opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const all = !!o.all;
  const out = [];
  if (!state) return 'radar: no snapshot yet — run `radar scan`\n';

  const srcBits = Object.keys(state.sources).map((k) => {
    const s = state.sources[k];
    return `${k} ${s.status}`;
  });
  out.push(`radar · ${state.collectorId} · snapshot ${age(state.generatedAt, now)} old`);
  out.push(`sources: ${srcBits.join(' · ')}`);
  for (const k of Object.keys(state.sources)) {
    if (state.sources[k].error) out.push(`  ! ${k}: ${state.sources[k].error}`);
  }

  const queue = state.attention;
  out.push('');
  if (queue.length === 0) {
    out.push('NOW   all quiet — nothing is waiting on you');
  } else {
    out.push(`NOW   ${describeAttention(queue[0])}`);
    // When the hero itself is a group, `--all` must still be able to reach its members: they lead
    // the queue rather than vanishing behind the one row that took the hero slot.
    const heroMembers = (all && Array.isArray(queue[0].items)) ? queue[0].items : [];
    const rest = heroMembers.concat(expandGroups(queue.slice(1), all));
    if (rest.length) {
      out.push('');
      out.push(`QUEUE (${rest.length})`);
      const shown = all ? rest : rest.slice(0, QUEUE_LIMIT);
      for (const it of shown) out.push(`  · ${describeAttention(it)}`);
      if (rest.length > shown.length) out.push(`  … +${rest.length - shown.length} more (radar status --all)`);
    }
  }

  const active = state.epics.filter((e) => e.zone === 'active');
  const dormant = state.epics.filter((e) => e.zone === 'dormant');
  const KEY_W = state.epics.reduce((n, e) => Math.max(n, e.key.length), KEY_MIN);
  const PHRASE_W = state.epics.reduce((n, e) => Math.max(n, e.phrase.length), PHRASE_MIN);

  out.push('');
  out.push(`MOVING (${active.length})`);
  for (const e of (all ? active : active.slice(0, 8))) {
    out.push(`  ${pad(e.key, KEY_W)} ${pad(e.phrase, PHRASE_W)} [${ladderStrip(e)}]`);
  }
  if (!all && active.length > 8) out.push(`  … +${active.length - 8} more`);

  out.push('');
  out.push(`PARKED (${dormant.length})`);
  for (const e of (all ? dormant : dormant.slice(0, 8))) {
    out.push(`  ${pad(e.key, KEY_W)} ${pad(e.phrase, PHRASE_W)} [last ${age(e.lastActivityAt, now)}]`);
  }
  if (!all && dormant.length > 8) out.push(`  … +${dormant.length - 8} more`);

  const stale = [];
  let dirtyCount = 0;
  for (const id of Object.keys(state.repos)) {
    for (const w of state.repos[id].worktrees) {
      if (w.stale && w.cleanupCommand) stale.push({ id, w });
      // A dirty worktree is NEVER cleanup-ready. It renders as a warning, never as a command.
      if (w.dirty && (w.dirty.staged || w.dirty.unstaged || w.dirty.untracked)) dirtyCount++;
    }
  }
  out.push('');
  out.push(`WORKTREES TO CLEAN (${stale.length})   — commands to run yourself; radar removes nothing`);
  for (const s of (all ? stale : stale.slice(0, 5))) out.push(`  ${s.w.cleanupCommand}   # ${s.w.staleReason}`);
  if (!all && stale.length > 5) out.push(`  … +${stale.length - 5} more (radar status --all)`);
  if (dirtyCount) out.push(`  ! ${dirtyCount} worktree${dirtyCount === 1 ? ' has' : 's have'} uncommitted work — not cleanup-ready`);

  out.push('');
  const c = state.counts;
  // Jira drift is off the board on purpose (a stale Jira status must not make an epic permanently
  // ACTIVE) but must stay reachable — otherwise it is a digest that exists only in state.json.
  const drift = Array.isArray(state.jiraDrift) ? state.jiraDrift : [];
  if (drift.length) {
    out.push('');
    out.push(`JIRA DRIFT (${drift.length})   — status says one thing, git says another; not work`);
    for (const d of (all ? drift : drift.slice(0, 5))) out.push(`  ${d.epic.padEnd(10)} ${d.note || d.direction || ''}`);
    if (!all && drift.length > 5) out.push(`  … +${drift.length - 5} more (radar status --all)`);
  }
  out.push('');
  out.push(`counts: blocked ${c.blocked} · decisions ${c.decisions} · mergeable ${c.mergeable} · orphans ${c.orphans} · stale worktrees ${c.staleWorktrees} · jira drift ${drift.length}`);
  return out.join('\n') + '\n';
}

// ---- TRUE DONE + handoff briefs -----------------------------------------------------------------

// The nine conditions from feature-lifecycle's TRUE DONE table, evaluated against the snapshot.
// Every one of them maps to a fact radar already derives; nothing here is a new measurement, and
// nothing is inferred from a status field. An epic that satisfies all of them is `zone: gone` and
// has already dropped out of epics[] — which is why "absent from the board" is the headline check
// and the per-condition table is the explanation of what is still holding it on.
const TRUE_DONE = [
  { id: 'pushed', label: 'every branch pushed', cell: 'pushed' },
  { id: 'merged', label: 'merged to develop', cell: 'mergedDevelop' },
  { id: 'dev', label: 'deployed to dev', cell: 'deployedDev' },
  { id: 'prod', label: 'deployed to prod (or N/A)', cell: 'prod' },
  { id: 'flag', label: 'flag on (or flagless)', cell: 'flags' },
];

// A ladder cell is `done` | `current` | `todo` | `unknown` | `violation`. Only `done` passes.
// `unknown` is NOT a pass: the whole point of the ladder is that missing data never reads green.
const cellVerdict = (v) => (v === 'done' ? 'PASS' : v === 'unknown' ? 'UNKNOWN' : 'FAIL');

function trueDoneReport(state, key) {
  const epic = (state.epics || []).find((e) => e.key === key) || null;
  const rows = [];

  if (!epic) {
    // Gone from epics[] IS the definition. Say so, and say what it means, rather than printing a
    // table of PASSes reconstructed from data that no longer exists.
    rows.push({ id: 'board', label: 'radar no longer lists this epic', verdict: 'PASS', note: 'zone: gone — zero activity, zero dangling facts, zero drift' });
    return { epic: null, rows, done: true };
  }

  for (const c of TRUE_DONE) {
    const v = (epic.ladder || {})[c.cell];
    rows.push({ id: c.id, label: c.label, verdict: cellVerdict(v), note: `ladder.${c.cell} = ${v == null ? 'missing' : v}` });
  }

  // Worktrees. Any worktree still mapped to this epic is an open teardown obligation; a dirty one
  // additionally cannot be removed, which is a different fact and gets said differently.
  //
  // A worktree record carries NO `epic` field — only `branch`. Keying on `w.epic` compiles, reads
  // correctly, and silently matches nothing, which is a PASS for every epic on the board: exactly
  // the false green this tool exists to kill. The epic lives on the BRANCH record, so the join goes
  // through it. A worktree whose branch radar does not know is counted as UNKNOWN, never as clear.
  const wts = [];
  let unmappable = 0;
  for (const id of Object.keys(state.repos || {})) {
    const byName = new Map();
    for (const b of (state.repos[id].branches || [])) byName.set(b.name, b);
    for (const w of (state.repos[id].worktrees || [])) {
      if (w.isMain) continue;                       // the main checkout is not a teardown obligation
      const b = w.branch ? byName.get(w.branch) : null;
      if (!b) { if (w.branch) unmappable++; continue; }
      if (b.epic === key) wts.push({ repo: id, w });
    }
  }
  const dirtyWts = wts.filter((x) => x.w.dirty && (x.w.dirty.staged || x.w.dirty.unstaged || x.w.dirty.untracked));
  rows.push({
    id: 'worktrees',
    label: 'every worktree clean and removed',
    verdict: wts.length ? 'FAIL' : (unmappable ? 'UNKNOWN' : 'PASS'),
    note: wts.length
      ? `${wts.length} remaining${dirtyWts.length ? `, ${dirtyWts.length} DIRTY (cannot be removed)` : ''}`
      : (unmappable ? `none matched, but ${unmappable} worktree(s) are on branches radar cannot map` : 'none'),
  });

  // Branch aliasing. Branches are never deleted, so an unaliased one is a permanent orphan row.
  const orphans = flattenAttention(state.attention || []).filter((a) => a.type === 'orphan');
  rows.push({
    id: 'aliased',
    label: 'branches aliased (never deleted, so never orphaned)',
    verdict: orphans.length === 0 ? 'PASS' : 'UNKNOWN',
    note: orphans.length === 0 ? 'no orphan branches on the board' : `${orphans.length} orphan branch(es) board-wide — check none belong to this epic`,
  });

  // Jira. A transitioned epic clears the drift signal; ticking checkboxes does not.
  const drift = (state.jiraDrift || []).filter((d) => d.epic === key);
  const inProgress = (epic.signals || []).indexOf('jira-in-progress') !== -1;
  rows.push({
    id: 'jira',
    label: 'jira epic transitioned out of In Progress',
    verdict: (inProgress || drift.length) ? 'FAIL' : 'PASS',
    note: inProgress ? 'signal jira-in-progress is set' : (drift.length ? drift[0].note : (epic.jira ? 'no in-progress signal' : 'no jira link')),
  });

  const decisions = flattenAttention(state.attention || []).filter((a) => a.type === 'decision' && a.epic === key);
  rows.push({
    id: 'decisions',
    label: 'open decisions closed',
    verdict: decisions.length === 0 ? 'PASS' : 'FAIL',
    note: decisions.length === 0 ? 'none open' : decisions.map((d) => d.id).join(', '),
  });

  rows.push({ id: 'board', label: 'radar no longer lists this epic', verdict: 'FAIL', note: `zone: ${epic.zone} · ${epic.phrase}` });
  return { epic, rows, done: false };
}

function renderDone(state, key) {
  const r = trueDoneReport(state, key);
  const out = [];
  out.push(`TRUE DONE — ${key}`);
  out.push('');
  for (const row of r.rows) out.push(`  ${row.verdict.padEnd(8)} ${row.label.padEnd(46)} ${row.note}`);
  out.push('');
  out.push(r.done
    ? `${key} is DONE — it is not on the board.`
    : `${key} is NOT done. Anything you cannot close is PARKED WITH A REASON, never dropped.`);
  return { text: out.join('\n') + '\n', done: r.done };
}

// ---- brief ---------------------------------------------------------------------------------------

// Assembles the prompt a handoff session starts with. The FACTS come from the snapshot and are
// stated once; the PROCEDURE lives in the `radar-handoff` skill, which the first line invokes — so
// this stays short and the how-to improves centrally instead of being copied into every brief.
function buildBrief(state, selectors, opts) {
  const o = opts || {};
  const items = [];
  const repos = new Set();
  const unknown = [];
  const att = flattenAttention(state.attention || []);

  for (const sel of selectors) {
    if (sel === 'worktrees') {
      const cmds = [];
      for (const id of Object.keys(state.repos || {})) {
        for (const w of (state.repos[id].worktrees || [])) {
          if (w.stale && w.cleanupCommand) { cmds.push(`${w.cleanupCommand}   # ${w.staleReason || 'stale'}`); repos.add(id); }
        }
      }
      if (cmds.length) items.push({ verb: 'CLEAN', lines: [`${cmds.length} merged worktree(s), commands verified by radar:`].concat(cmds.map((c) => `  ${c}`)) });
      else unknown.push('worktrees (none are cleanup-ready)');
      continue;
    }
    if (sel === 'orphans') {
      const o2 = att.filter((a) => a.type === 'orphan');
      if (o2.length) { o2.forEach((a) => repos.add(a.repo)); items.push({ verb: 'TAG', lines: [`${o2.length} untagged branch(es) — alias each to its epic:`].concat(o2.map((a) => `  ${a.repo}:${a.branch}`)) }); }
      else unknown.push('orphans (none on the board)');
      continue;
    }
    const epic = (state.epics || []).find((e) => e.key === sel);
    if (!epic) { unknown.push(sel); continue; }
    (epic.repos || []).forEach((r) => repos.add(r));
    const mergeable = att.some((a) => a.type === 'mergeable' && a.epic === sel);
    const lines = [
      `epic ${epic.key} — ${epic.phrase}`,
      `  repos      ${(epic.repos || []).join(', ') || 'none'}`,
      `  ladder     ${LADDER.map(([k, l]) => `${l}=${epic.ladder[k]}`).join(' · ')}`,
      `  signals    ${(epic.signals || []).join(', ') || 'none'}`,
      `  last work  ${epic.lastActivityAt || 'never'}`,
    ];
    items.push({ verb: mergeable ? 'MERGE' : 'SHIP-OR-PARK', lines });
  }

  const out = [];
  out.push('/radar-handoff');
  out.push('');
  out.push(`MISSION: clear the items below to TRUE DONE (feature-lifecycle Phases 11-13).`);
  out.push('');
  out.push(`FACTS (radar @ ${state.generatedAt} on ${state.collectorId} — git-derived, do NOT re-derive):`);
  items.forEach((it, i) => {
    out.push(`  ${i + 1}. ${it.verb}  ${it.lines[0]}`);
    for (const l of it.lines.slice(1)) out.push(`     ${l}`);
  });
  if (!items.length) out.push('  (nothing selected resolved to a fact — see UNRESOLVED below)');
  out.push('');
  out.push('CONTEXT:');
  for (const sel of selectors) if ((state.epics || []).some((e) => e.key === sel)) out.push(`  /recall ${sel}`);
  out.push(`  radar status --all   # the live board`);
  out.push('');
  // Source health is part of the brief, not a footnote: a degraded source means some fact above is
  // carried forward from an older scan, and an executor must know that before acting on it.
  const bad = Object.keys(state.sources || {}).filter((k) => state.sources[k].status !== 'ok');
  if (bad.length) out.push(`SOURCE WARNING: ${bad.map((k) => `${k}=${state.sources[k].status}`).join(' · ')} — those facts may be stale.`);
  if (unknown.length) out.push(`UNRESOLVED SELECTORS (nothing was invented for these): ${unknown.join(', ')}`);
  if (bad.length || unknown.length) out.push('');
  out.push(`END STATE: \`radar done <epic>\` passes for each epic above, and the worktrees/branches named are gone from \`radar status\`.`);
  out.push('Anything you cannot close: name it and park it with a reason. Never drop it, never fake it.');
  return { text: out.join('\n') + '\n', items: items.length, unknown, repos: Array.from(repos) };
}

// ---- argv ----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) { flags[key] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['dir', 'config', 'epic', 'context'].indexOf(key) !== -1) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `radar — derived truth for the repos, worktrees and epics on this machine

  radar status [--all] [--json] [--no-scan]   render the current snapshot (scans if stale/absent)
  radar scan [--no-fetch] [--json]            force a scan and publish state.json
  radar tag <repo>:<branch> <epic>            pin an orphan branch to an epic (branchOverrides)
  radar tag --spec <spec-folder> <epic>       pin an orphan spec folder to an epic (alias append)
  radar decide <title> [--epic K] [--context T]  open a decision item
  radar decided <id>                          close a decision (reopen = a new decide, new id)
  radar flag <epic> <on|off|n/a>              assert feature-flag state (never auto-detected)
  radar done <epic>                           check the 9 TRUE DONE conditions; exit 0 only if done
  radar brief <epic|worktrees|orphans> ...    print the handoff prompt for a selection

  --dir <path>     radar home (default $RADAR_DIR or ~/.radar)
  --config <path>  config file (default <dir>/config.json)

Radar is read-only outside its own directory: it never pushes, merges, deletes a branch, removes a
worktree, or writes to git, Jira, a database or a deploy. Cleanup output is command strings for you.
`;

async function main(argv, io) {
  const stdout = (io && io.stdout) || process.stdout;
  const stderr = (io && io.stderr) || process.stderr;
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] || 'status';
  if (cmd === 'help' || flags.help) { stdout.write(HELP); return 0; }

  const radarDir = flags.dir || process.env.RADAR_DIR || store.defaultRadarDir();
  const collector = createCollector({ radarDir, configPath: flags.config || undefined });
  const now = Date.now();

  try {
    switch (cmd) {
      case 'status': {
        let state = await collector.getState();
        const staleMs = 20 * 60 * 1000;                     // 2x the default 10-minute cadence
        const needsScan = !state || (now - Date.parse(state.generatedAt) > staleMs);
        if (needsScan && !flags['no-scan']) {
          stderr.write(state ? 'radar: snapshot is stale, rescanning…\n' : 'radar: no snapshot, scanning…\n');
          const r = await collector.scan({ fetch: flags['no-fetch'] ? false : true });
          state = r.state;
          if (!r.published) stderr.write(`radar: ${r.error}\n`);
        }
        if (flags.json) { stdout.write(JSON.stringify(state, null, 2) + '\n'); return 0; }
        stdout.write(renderStatus(state, { now: Date.now(), all: !!flags.all }));
        return 0;
      }
      case 'scan': {
        const t0 = Date.now();
        const r = await collector.scan({ fetch: !flags['no-fetch'] });
        if (flags.json) { stdout.write(JSON.stringify({ ok: r.ok, durationMs: r.durationMs, warnings: r.warnings, counts: r.state.counts }, null, 2) + '\n'); return r.ok ? 0 : 1; }
        if (!r.published) { stderr.write(`radar: ${r.error} (previous state.json left intact)\n`); return 1; }
        const c = r.state.counts;
        stdout.write(`radar: scanned ${Object.keys(r.state.repos).length} repos in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${collector.paths.state}\n`);
        stdout.write(`  epics ${r.state.epics.length} · attention ${r.state.attention.length} · orphans ${c.orphans} · stale worktrees ${c.staleWorktrees}\n`);
        for (const w of r.warnings.slice(0, 10)) stdout.write(`  ! ${w}\n`);
        if (r.warnings.length > 10) stdout.write(`  ! …+${r.warnings.length - 10} more warnings\n`);
        return 0;
      }
      case 'done': {
        // The lifecycle EXIT gate, runnable. Exit code is the contract: 0 means the epic is off the
        // board, so a script (or a handoff session) can assert completion instead of claiming it.
        const key = positional[1];
        if (!key) throw new Error('usage: radar done <epic>');
        const state = await collector.getState();
        if (!state) throw new Error('no snapshot yet — run `radar scan` first');
        if (flags.json) {
          const r = trueDoneReport(state, key);
          stdout.write(JSON.stringify({ epic: key, done: r.done, rows: r.rows }, null, 2) + '\n');
          return r.done ? 0 : 1;
        }
        const r = renderDone(state, key);
        stdout.write(r.text);
        return r.done ? 0 : 1;
      }
      case 'brief': {
        // Selection -> prompt. Deliberately NOT a spawner: it prints, so the wording can be read and
        // edited before a session exists. The UI's `hand off` button calls the same assembler.
        const sels = positional.slice(1);
        if (!sels.length) throw new Error('usage: radar brief <epic|worktrees|orphans> [more...]');
        const state = await collector.getState();
        if (!state) throw new Error('no snapshot yet — run `radar scan` first');
        const b = buildBrief(state, sels, {});
        if (flags.json) { stdout.write(JSON.stringify(b, null, 2) + '\n'); return b.items ? 0 : 1; }
        stdout.write(b.text);
        // Unresolved selectors are a failure, not a footnote: a brief that silently dropped one
        // would hand off less work than was selected and nobody would notice.
        return b.items && !b.unknown.length ? 0 : 1;
      }
      case 'tag': {
        // `--spec` selects the mod-specs write (alias append) rather than the branch write
        // (branchOverrides). Same verb because the user's intent is identical — "this dangling
        // thing belongs to that epic" — and same parity as POST /api/radar/tag {kind}.
        if (flags.spec) {
          const specFolder = positional[1];
          const epic = positional[2];
          if (!specFolder || !epic) throw new Error('usage: radar tag --spec <spec-folder> <epic>');
          await collector.tagSpec({ specFolder, epic });
          stdout.write(`radar: spec ${specFolder} -> ${epic} (alias append). Takes effect on the next scan.\n`);
          return 0;
        }
        let repo = positional[1];
        let branch = positional[2];
        let epic = positional[3];
        if (repo && repo.indexOf(':') !== -1 && positional.length === 3) {
          const i = repo.indexOf(':');
          branch = repo.slice(i + 1);
          epic = positional[2];
          repo = repo.slice(0, i);
        }
        await collector.tagBranch({ repo, branch, epic });
        stdout.write(`radar: ${repo}:${branch} -> ${epic} (branchOverrides). Takes effect on the next scan.\n`);
        return 0;
      }
      case 'decide': {
        const d = await collector.addDecision({ title: positional.slice(1).join(' '), epic: flags.epic, context: flags.context });
        stdout.write(`radar: decision ${d.id} opened${d.epic ? ` on ${d.epic}` : ''}\n`);
        return 0;
      }
      case 'decided': {
        await collector.closeDecision(positional[1]);
        stdout.write(`radar: decision ${positional[1]} closed\n`);
        return 0;
      }
      case 'flag': {
        await collector.setFlag({ epic: positional[1], state: positional[2] });
        stdout.write(`radar: flag ${positional[1]} asserted ${positional[2]} (asserted truth — radar never detects this)\n`);
        return 0;
      }
      default:
        stderr.write(`radar: unknown command ${JSON.stringify(cmd)}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    stderr.write(`radar: ${e && e.message ? e.message : e}\n`);
    return 1;
  } finally {
    collector.stop();
    await store.drain();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`radar: ${e.stack || e}\n`); process.exitCode = 1; });
}

module.exports = { main, renderStatus, parseArgs, describeAttention, age, HELP, trueDoneReport, renderDone, buildBrief };
