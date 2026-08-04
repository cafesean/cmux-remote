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
const { loadConfig } = require('./config');
const { parseSelector, keysForSelector, epicOfWorktree, dirtyCount } = require('./handoff-keys');
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

// §6.5: the ORIGIN line of one epic. The join is EXACT (repo, branch) equality against the epic's
// BRANCH records — never `w.epic` (which does not exist, §9 trap 2), never a title-text or cwd
// match: a fuzzier join would turn "was seen here" into a causal claim (§2 principle 7). The
// reduction takes the SINGLE newest observation across ALL of the epic's pairs — greatest `at`,
// ties broken by later file offset — so an epic renders one line, never one per branch. A null
// customTitle on the WINNING observation still renders `origin unknown`: the winner is chosen
// first and only then downgraded, so an older titled observation can never leak through.
function lastObservedLine(state, epicKey, observations) {
  const pairs = new Set();
  for (const repoId of Object.keys(state.repos || {})) {
    for (const b of (state.repos[repoId].branches || [])) {
      if (b.epic === epicKey) pairs.add(`${repoId}\n${b.name}`);
    }
  }
  let best = null;
  // Observations arrive in file order, so `>=` hands an equal-`at` tie to the later offset.
  for (const obs of (observations || [])) {
    if (!obs || !pairs.has(`${obs.repo}\n${obs.branch}`)) continue;
    const t = Date.parse(obs.at);
    if (!Number.isFinite(t)) continue;
    if (!best || t >= best.t) best = { t, obs };
  }
  if (!best || typeof best.obs.customTitle !== 'string' || !best.obs.customTitle) return 'origin unknown';
  return `last seen by session "${best.obs.customTitle}" · ${best.obs.at}`;
}

// One §6.8 block for a kind-prefixed selector, or null when it is unresolved. Resolution is
// keysForSelector — the SAME rule the reservation uses (§6.1), so the brief and the lock table can
// never disagree about what a selector names — and a selector resolving to ZERO fact keys is
// unresolved, never a partial block. Fact lines mirror §6.2's minting predicates one-for-one: a
// line exists iff its fact key exists.
function kindSelectorItem(state, sel, observations, repos, recall) {
  const p = parseSelector(sel);
  if (!p.ok || keysForSelector(state, sel).length === 0) return null;
  switch (p.kind) {
    case 'epic': {
      const key = p.segs[0];
      const epic = (state.epics || []).find((e) => e.key === key) || null;
      const lines = [epic ? `epic ${key} — ${epic.phrase}` : `epic ${key}`];
      if (epic) lines.push(`  ladder     ${LADDER.map(([k, l]) => `${l}=${epic.ladder[k]}`).join(' · ')}`);
      for (const repoId of Object.keys(state.repos || {})) {
        const repo = state.repos[repoId];
        for (const b of (repo.branches || [])) {
          if (b.epic !== key) continue;
          repos.add(repoId);
          if (Number(b.unpushed) > 0) lines.push(`  ${repoId}:${b.name} — ${b.unpushed} unpushed`);
          if (b.mergedIntoDevelop === false) lines.push(`  ${repoId}:${b.name} — unmerged-develop`);
          if (b.mergedIntoMain === false) lines.push(`  ${repoId}:${b.name} — unmerged-main`);
        }
        // Worktree -> epic goes through the BRANCH record (§9 trap 2). Both the :stale and :dirty
        // facts render, so a clean-but-stale epic worktree is in the brief with its epic.
        for (const w of (repo.worktrees || [])) {
          if (epicOfWorktree(state, repoId, w) !== key) continue;
          repos.add(repoId);
          if (w.stale) lines.push(`  ${w.path} — ${w.staleReason ? `stale (${w.staleReason})` : 'stale'}`);
          if (dirtyCount(w) > 0) lines.push(`  ${w.path} — dirty (${w.dirty.staged || 0} staged, ${w.dirty.unstaged || 0} unstaged, ${w.dirty.untracked || 0} untracked)`);
        }
      }
      for (const s of ((epic && epic.signals) || [])) {
        if (s === 'merged-not-deployed' || s === 'deployed-flag-off') lines.push(`  signal ${s}`);
      }
      lines.push(`  ${lastObservedLine(state, key, observations)}`);
      if (epic) (epic.repos || []).forEach((r) => repos.add(r));
      recall(key);
      return { verb: 'FINISH', lines };
    }
    case 'branch': {
      const [repoId, name] = p.segs;
      // keysForSelector resolved, so the branch record exists and minted at least one fact.
      const b = (((state.repos || {})[repoId] || {}).branches || []).find((x) => x.name === name);
      repos.add(repoId);
      const lines = [`${repoId} · ${name}${Number(b.unpushed) > 0 ? ` · ${b.unpushed} unpushed` : ''}`];
      if (b.mergedIntoDevelop === false) lines.push('  unmerged-develop');
      if (b.mergedIntoMain === false) lines.push('  unmerged-main');
      recall(b.epic);
      return { verb: 'PUSH', lines };
    }
    case 'wt': {
      for (const repoId of Object.keys(state.repos || {})) {
        const w = ((state.repos[repoId] || {}).worktrees || []).find((x) => x.path === p.segs[0]);
        if (!w) continue;
        repos.add(repoId);
        const lines = [w.path];
        if (w.stale) lines.push(`  ${w.staleReason ? `stale (${w.staleReason})` : 'stale'}`);
        if (dirtyCount(w) > 0) lines.push(`  dirty (${w.dirty.staged || 0} staged, ${w.dirty.unstaged || 0} unstaged, ${w.dirty.untracked || 0} untracked)`);
        if (w.cleanupCommand) lines.push(`  ${w.cleanupCommand}`);
        recall(epicOfWorktree(state, repoId, w));
        return { verb: 'CLEAN', lines };
      }
      return null;                       // unreachable: keysForSelector found this worktree above
    }
    case 'orphan': {
      const [repoId, name] = p.segs;
      repos.add(repoId);
      // An orphan is a branch with NO epic — that IS the fact — so there is nothing to /recall.
      return { verb: 'TAG', lines: [`${repoId} · ${name} — untagged branch; alias it to its epic`] };
    }
    default:
      return null;                       // `worktrees`/`orphans` never reach here; buildBrief owns them
  }
}

// Assembles the prompt a handoff session starts with. The FACTS come from the snapshot and are
// stated once; the PROCEDURE lives in the `radar-handoff` skill, which the first line invokes — so
// this stays short and the how-to improves centrally instead of being copied into every brief.
// p6 §6.8 widens the vocabulary: besides the shipped `worktrees`, `orphans` and bare epic key, the
// four kind-prefixed forms (`epic:` `branch:` `wt:` `orphan:`) each render a fixed verb-led block.
function buildBrief(state, selectors, opts) {
  const o = opts || {};
  const observations = Array.isArray(o.observations) ? o.observations : [];
  const items = [];
  const repos = new Set();
  const unknown = [];
  // One `/recall <epic>` line per epic named by ANY selector (§6.8): directly for `epic:` and the
  // bare key, through the branch record for `branch:`/`wt:` — deduped, in selection order, so the
  // shipped bare-key behaviour is a special case of one rule rather than a second one.
  const recalls = [];
  const recall = (k) => { if (k && recalls.indexOf(k) === -1) recalls.push(k); };
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
    if (sel.indexOf(':') !== -1) {
      const it = kindSelectorItem(state, sel, observations, repos, recall);
      if (it) items.push(it); else unknown.push(sel);
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
      `  ${lastObservedLine(state, epic.key, observations)}`,
    ];
    items.push({ verb: mergeable ? 'MERGE' : 'SHIP-OR-PARK', lines });
    recall(epic.key);
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
  for (const k of recalls) out.push(`  /recall ${k}`);
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

// ---- handoff client (§M5) ------------------------------------------------------------------------

// The `radar handoff` subcommand is an HTTP CLIENT and nothing else. radar/store.js's queue
// serialises writers within ONE process — no flock, no O_EXCL — so a CLI that wrote p6 state would
// be the second writer principle 8 forbids. Every mutation goes to the server; if the server is
// unreachable the command fails with a stated error and changes nothing. The token travels in the
// Authorization header, NEVER in the URL (§7.1).
function httpJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { accept: 'application/json', connection: 'close' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    // u.pathname only — a query string is where a token could leak, so none is ever sent.
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// One line from stdin, for the typed confirmation. No readline machinery: collect until '\n' or EOF.
function readLine(stream) {
  return new Promise((resolve) => {
    let buf = '';
    const finish = (s) => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onEnd);
      if (typeof stream.pause === 'function') stream.pause();
      resolve(s);
    };
    const onData = (d) => { buf += d; const i = buf.indexOf('\n'); if (i !== -1) finish(buf.slice(0, i)); };
    const onEnd = () => finish(buf);
    if (typeof stream.setEncoding === 'function') { try { stream.setEncoding('utf8'); } catch (_) { /* object-mode stream */ } }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
    if (typeof stream.resume === 'function') stream.resume();
  });
}

// observations.jsonl is append-only NDJSON (§4.5). An absent file means no observations — the
// brief renders `origin unknown`, never an error — and a truncated final line is skipped, because
// a half-written record must not cost the brief the whole relation.
async function readObservations(file) {
  let raw;
  try { raw = await require('fs').promises.readFile(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* truncated tail — skip, keep the rest */ }
  }
  return out;
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
  radar handoff <selector> [more...] [--dry]  dispatch the selection via the radar server (--dry: preview only)
  radar handoff show <handoffId>              print one handoff by id (no listing command exists, by design)
  radar work [--selectable] [--source S] [--all]  list WorkRefs: native status, canonical, route
  radar route <urn>                           show the resolved target for one WorkRef, or why there is none

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
      // p11 §7. Both render the NATIVE status alongside the canonical one, always: the tracker
      // stays the authority and radar's projection must never be mistaken for it.
      case 'work': {
        const state = await collector.getState();
        const all = Array.isArray(state && state.workRefs) ? state.workRefs : [];
        const src = flags.source ? String(flags.source) : null;
        let list = all.filter((w) => (!src || w.source === src) && (!flags.selectable || w.selectable));
        if (flags.json) { stdout.write(JSON.stringify(list, null, 2) + '\n'); return 0; }
        if (!all.length) { stdout.write('radar: no WorkRefs (jira.agile disabled, or nothing intaken yet)\n'); return 0; }
        // Folded by default, same resting-screen discipline as the rest of the board.
        const CAP = flags.all ? list.length : 4;
        for (const w of list.slice(0, CAP)) {
          const native = (w.status && w.status.native) || '—';
          const canon = (w.status && w.status.canonical) || 'unknown';
          const route = w.route && w.route.kind ? `${w.route.kind}${w.route.sessionId ? ` ${String(w.route.sessionId).slice(0, 8)}` : ''}` : `— (${(w.route && w.route.reason) || 'unresolved'})`;
          stdout.write(`${w.selectable ? '*' : ' '} ${w.urn.padEnd(28)} ${native.padEnd(18)} ${canon.padEnd(9)} ${route}\n`);
        }
        if (list.length > CAP) stdout.write(`  +${list.length - CAP} more (--all)\n`);
        stdout.write(`  ${list.length} shown · ${all.filter((w) => w.selectable).length} selectable of ${all.length}\n`);
        return 0;
      }
      case 'route': {
        const urn = positional[1];
        if (!urn) { stderr.write('radar: route needs a workRef urn\n'); return 2; }
        const state = await collector.getState();
        const w = (Array.isArray(state && state.workRefs) ? state.workRefs : []).find((x) => x.urn === urn);
        if (!w) { stderr.write(`radar: no WorkRef ${urn}\n`); return 2; }
        if (flags.json) { stdout.write(JSON.stringify(w.route, null, 2) + '\n'); return 0; }
        const r = w.route || {};
        stdout.write(`${w.urn}\n`);
        stdout.write(`  tracker says   ${(w.status && w.status.native) || '—'}\n`);
        stdout.write(`  radar reads    ${(w.status && w.status.canonical) || 'unknown'}\n`);
        // A null route always says WHY — "unresolved" alone is a shrug, and the reason is the
        // actionable half (cluster-running, no-surface, wrong-cluster...).
        stdout.write(`  route          ${r.kind || 'none'}${r.sessionId ? ` -> ${r.sessionId}` : ''}\n`);
        stdout.write(`  reason         ${r.reason || 'unresolved'}\n`);
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
        // §6.5: lastObservedBy reads observations.jsonl, radar's OWN file — the CLI stays a reader.
        const observations = await readObservations(path.join(radarDir, 'observations.jsonl'));
        const b = buildBrief(state, sels, { observations });
        if (flags.json) { stdout.write(JSON.stringify(b, null, 2) + '\n'); return b.items ? 0 : 1; }
        stdout.write(b.text);
        // Unresolved selectors are a failure, not a footnote: a brief that silently dropped one
        // would hand off less work than was selected and nobody would notice.
        return b.items && !b.unknown.length ? 0 : 1;
      }
      case 'handoff': {
        // §M5: an HTTP client, never a writer. Config names the server and the ENV VAR holding the
        // token; the value is read here at use time and sent as a bearer header only. Exit codes
        // are the contract: 0 ok · 1 usage/declined · 3 unreachable/401/viewer_readonly · 4 a 404
        // from `show` · 5 any other non-2xx. There is deliberately NO listing form of any kind —
        // a list is user work whatever it is labelled (§1, §8).
        const { config } = await loadConfig(flags.config || path.join(radarDir, 'config.json'));
        const base = String(config.serverBaseUrl || '').replace(/\/+$/, '');
        const token = process.env[config.serverTokenRef];
        const unreachable = (detail) => {
          stderr.write(`radar: the radar server at ${base} is not reachable (${detail}).\n`);
          stderr.write('p6 state is written only by the server; nothing was changed.\n');
          return 3;
        };
        // One response -> one exit code. 401 and viewer_readonly are "wrong door", not a failed
        // request: the remedy is the token or serverBaseUrl, so both print the changed-nothing
        // message and exit 3. Everything else non-2xx prints `error` and `message` as two lines,
        // plus `incidentId` as a third ONLY when the body carries one — never a list (§7.3).
        const refused = (res) => {
          const b = res.body || {};
          if (res.status === 401) return unreachable(`HTTP 401 ${b.error || 'unauthorized'}`);
          if (res.status === 409 && b.error === 'viewer_readonly') {
            stderr.write(`radar: viewer_readonly — ${b.message || 'this server is a viewer'} (leader: ${b.leaderBaseUrl || 'unknown'})\n`);
            stderr.write('p6 state is written only by the server; nothing was changed.\n');
            return 3;
          }
          stderr.write(`${b.error || `http_${res.status}`}\n`);
          stderr.write(`${b.message || (res.raw || '').trim()}\n`);
          if (b.incidentId) stderr.write(`${b.incidentId}\n`);
          return 5;
        };

        if (positional[1] === 'show') {
          const id = positional[2];
          if (!id || positional.length > 3) throw new Error('usage: radar handoff show <handoffId>');
          let res;
          try { res = await httpJson('GET', `${base}/api/radar/handoff/${encodeURIComponent(id)}`, token); }
          catch (e) { return unreachable((e && (e.code || e.message)) || e); }
          if (res.status === 404) { stderr.write(JSON.stringify(res.body, null, 2) + '\n'); return 4; }
          if (res.status < 200 || res.status >= 300) return refused(res);
          stdout.write(JSON.stringify(res.body, null, 2) + '\n');
          return 0;
        }

        const sels = positional.slice(1);
        if (!sels.length) throw new Error('usage: radar handoff <selector> [more...] [--dry]  |  radar handoff show <handoffId>');
        let res;
        try { res = await httpJson('POST', `${base}/api/radar/handoff/preview`, token, { selectors: sels }); }
        catch (e) { return unreachable((e && (e.code || e.message)) || e); }
        if (res.status < 200 || res.status >= 300) return refused(res);
        stdout.write(JSON.stringify(res.body, null, 2) + '\n');
        if (flags.dry) return 0;

        // Outward action is always confirmed (§8): a typed `y`, exactly, or nothing is posted.
        stdout.write('hand off? type y to dispatch: ');
        const answer = await readLine((io && io.stdin) || process.stdin);
        if (answer.trim() !== 'y') { stderr.write('radar: declined — nothing was dispatched\n'); return 1; }
        const envelope = res.body || {};
        const commitReq = {
          previewId: (envelope.plan || {}).previewId,
          hash: envelope.hash,
          // Minted once per confirmed run (§7.1); the server's idempotency, not the CLI's memory,
          // is what makes an accidental re-run safe.
          idempotencyKey: require('crypto').randomUUID(),
        };
        try { res = await httpJson('POST', `${base}/api/radar/handoff`, token, commitReq); }
        catch (e) { return unreachable((e && (e.code || e.message)) || e); }
        if (res.status < 200 || res.status >= 300) return refused(res);
        stdout.write(JSON.stringify(res.body, null, 2) + '\n');
        return 0;
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

module.exports = { main, renderStatus, parseArgs, describeAttention, age, HELP, trueDoneReport, renderDone, buildBrief, lastObservedLine };
