'use strict';
// derive — module fragments in, state.json v1 out. Pure: no I/O, no clock of its own (`now` is
// passed), so the whole zone/ladder oracle is table-testable.
//
// THE LOAD-BEARING RULE (spec §6, Codex round-2 fix): signals come in THREE DISJOINT CLASSES.
//
//   activity signals  — a live/blocked session on the epic, an open epic-keyed decision,
//                       any epic-branch commit inside 14 days.
//   dangling facts    — unpushed commits, unmerged branches, a dirty worktree,
//                       merged-but-not-deployed, deployed-but-flag-off.
//   drift signals     — Jira says In Progress. ASSERTED BY A HUMAN, corroborated by nothing.
//
//   active  = >= 1 ACTIVITY signal.
//   dormant = ZERO activity signals and (>= 1 dangling fact OR >= 1 drift signal).
//   gone    = none of the three (the epic is dropped from epics[] entirely — "done = disappears").
//
// Dangling facts alone therefore never make an epic active. Get this backwards and DORMANT
// becomes unreachable, which is exactly the oracle contradiction the spec review caught.
//
// WHY JIRA IN PROGRESS IS NOT AN ACTIVITY SIGNAL (real-board fix, 2026-07-31). It used to be one.
// On the real board that put ten epics — PROJ-10, PROJ-30, PROJ-32, PROJ-40, PROJ-56, PROJ-57, PROJ-72,
// PROJ-73, PROJ-103, PROJ-105 — in the ACTIVE zone with zero commits, zero sessions and no date. They
// were there for exactly one reason: a Jira status nobody had touched in months. Radar exists in
// part to close the status-drift loop (spec §1); promoting a stale Jira status to a first-class
// activity signal made it INHERIT that rot and re-display it as truth.
//
// A Jira status alone can no longer make an epic active. It needs corroboration from a git signal
// (a commit, or any dangling fact) or an open attention item (a session, a decision) — all of which
// are already activity/dangling signals in their own right, so the corroboration rule falls out of
// simply removing Jira from the activity class. What is left is the DRIFT class: it keeps such an
// epic REACHABLE (dormant/parked, and in `jiraDrift[]` for the weekly digest) without ever putting
// it on the resting screen. Reclassification, not deletion.
//
// COROLLARY, and the reason `mergeable` is not in the activity list: `mergeable` is DERIVED from
// the epic's own ladder. Feeding it back in as an activity signal would make every epic with
// leftover work "active" and re-break the oracle. Only inputs that exist independently of the
// epic derivation may be activity signals.

const { keysOfAttentionItem } = require('./handoff-keys');

const LADDER_ORDER = ['spec', 'pushed', 'mergedDevelop', 'deployedDev', 'prod', 'flags'];
const RECENT_COMMIT_MS = 14 * 24 * 60 * 60 * 1000;
const FLAG_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const EPOCH = new Date(0).toISOString();

// Attention sort per spec §4. The same order is the deterministic tie-break for phrase selection.
// A group sorts exactly where its members would — it IS its members, folded into one row.
// `blocked-stale` is a blocked session whose prompt-cache window has already closed. It is still
// real work — someone must answer or kill that session — but it is no longer URGENT: the expensive
// thing it was racing has already been lost, so nothing is saved by acting in the next minute. It
// ranks below every item you can still act on in time, which is what keeps a dead deadline out of
// the one slot that means "act now". A red box that is wrong for two days stops being read at all.
const ATTENTION_ORDER = ['blocked', 'rule-violation', 'decision', 'mergeable', 'default-unpushed', 'blocked-stale', 'orphan', 'orphan-group', 'spec-orphan', 'spec-orphan-group'];

// Two or more orphans of the same type collapse into ONE attention row. 131 spec folders that have
// never been mapped to an epic are not 131 decisions — they are one job ("triage the spec vault"),
// and rendering them as 131 near-identical rows turned the queue into a grinding list instead of a
// triage surface. The group is EXPANDABLE, never a dead end: every member is carried inside it with
// its own tag action, so nothing becomes unreachable (spec §2).
const ORPHAN_GROUP_MIN = 2;

const ACTIVITY_SIGNALS = ['session-blocked', 'session-live', 'decision-open', 'recent-commit'];
const DANGLING_SIGNALS = ['unpushed-commits', 'dirty-worktree', 'unmerged-develop', 'merged-not-deployed', 'deployed-flag-off'];
const DRIFT_SIGNALS = ['jira-in-progress'];

// Phrase templates. No free text anywhere: the phrase is (top activity signal) · (top dangling
// fact), each picked by the fixed priority above. Ties cannot happen because the order is total.
const ACTIVITY_PHRASE = {
  'session-blocked': (c) => (c.notificationType ? `blocked · ${c.notificationType}` : 'blocked'),
  'session-live': () => 'building',
  'decision-open': (c) => (c.decisionSince ? `decision open since ${c.decisionSince.slice(0, 10)}` : 'decision open'),
  'recent-commit': () => 'building',
};
// Used in the activity slot when there is no activity signal, so the row says what it actually is:
// a Jira status with nothing behind it. "in progress" (the old phrase) restated the rot as fact.
const DRIFT_PHRASE = {
  'jira-in-progress': (c) => (c.branchCount ? 'jira says in progress · git quiet' : 'jira says in progress · no branches'),
};
const DANGLING_PHRASE = {
  'unpushed-commits': (c) => `${c.unpushed} commit${c.unpushed === 1 ? '' : 's'} unpushed`,
  'dirty-worktree': (c) => `uncommitted work in ${c.dirtyWorktrees} worktree${c.dirtyWorktrees === 1 ? '' : 's'}`,
  'unmerged-develop': (c) => `${c.unmerged} branch${c.unmerged === 1 ? '' : 'es'} unmerged`,
  'merged-not-deployed': () => 'merged · awaiting deploy',
  'deployed-flag-off': () => 'deployed · flag off',
};

const maxIso = (a, b) => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sourceOk = (sources, key) => !!(sources && sources[key] && sources[key].status === 'ok');

// ---- ladder ------------------------------------------------------------------------------------

// Raw cell states are {done, partial, none, unknown, violation}; assembleLadder turns them into the
// rendered vocabulary {done, current, todo, unknown, violation} by finding the leftmost non-done.
function assembleLadder(raw) {
  const cells = {};
  const firstNonDone = LADDER_ORDER.findIndex((k) => raw[k] !== 'done');
  const anyDone = LADDER_ORDER.some((k) => raw[k] === 'done');
  LADDER_ORDER.forEach((k, i) => {
    const r = raw[k];
    if (r === 'done') { cells[k] = 'done'; return; }
    if (r === 'violation') { cells[k] = 'violation'; return; }
    // Unknown outranks `current`: a cell we could not evaluate must never look like progress.
    if (r === 'unknown') { cells[k] = 'unknown'; return; }
    // Zero-progress epic (nothing done anywhere, no partial here) shows `todo`, not `current`.
    cells[k] = i === firstNonDone && (anyDone || r === 'partial') ? 'current' : 'todo';
  });
  return cells;
}

// AND semantics across repos fall out of this: every epic branch in every repo is in `values`,
// so one lagging repo drops the cell from done to partial.
function tally(values) {
  if (values.length === 0) return 'none';
  if (values.some((v) => v === null || v === undefined)) return 'unknown';
  if (values.every((v) => v === true)) return 'done';
  if (values.some((v) => v === true)) return 'partial';
  return 'none';
}

// ---- epic assembly -----------------------------------------------------------------------------

function epicFlag(aliases, key, now) {
  const flags = aliases && aliases.flags && typeof aliases.flags === 'object' ? aliases.flags : {};
  const f = flags[key];
  if (!f || typeof f !== 'object' || typeof f.state !== 'string') return null;
  const state = ['on', 'off', 'n/a'].indexOf(f.state) !== -1 ? f.state : null;
  if (!state) return null;
  const assertedAt = typeof f.assertedAt === 'string' ? f.assertedAt : null;
  const age = assertedAt ? now - Date.parse(assertedAt) : NaN;
  // An assertion never expires automatically; past 30 days it renders as a re-assert prompt.
  return { state, assertedAt, stale: Number.isFinite(age) ? age > FLAG_STALE_MS : false };
}

function buildEpic(key, ctx) {
  const { branches, worktreeByPath, sessions, decisions, aliases, jira, specs, sources, now } = ctx;
  const epicBranches = branches.filter((b) => b.epic === key && !b.isDefault);
  const epicSessions = sessions.filter((s) => s.epic === key);
  const epicDecisions = decisions.filter((d) => d.epic === key && !d.closedAt);
  const flag = epicFlag(aliases, key, now);

  // DEPLOY KNOWLEDGE IS PER REPO, NOT PER SOURCE (S-007 defect fix).
  //
  // `sources.deploy` is an AGGREGATE badge: mod-deploy marks it `stale` the moment ONE probe out of
  // a dozen degrades. Gating on it — the original `sourceOk(sources, 'deploy')` — meant a single dead
  // Vercel token (app-web's) blanked the deployedDev and prod cells of EVERY epic in EVERY repo,
  // including the repos whose probes answered perfectly. The badge is right; using it as the gate
  // was wrong.
  //
  // The gate is now the fragment itself: does THIS epic's repo set actually carry deploy data? A
  // repo whose probe failed still fails on its own — `deployedDevByRepo` returns null for any
  // non-ok probe, which tallies to `unknown` — so a broken repo degrades to unknown while its
  // neighbours keep their real cells. Unknown still beats false green; it is just scoped correctly.
  const epicRepoIds = Array.from(new Set(epicBranches.map((b) => b.repoId)));
  const deployKnown = epicRepoIds.length > 0 && epicRepoIds.every((id) => ctx.deployKnownForRepo(id));

  // ---- ladder raw cells
  const raw = {};
  // The REAL spec cell (S-009). The S-003 placeholder — "any branch exists" — is gone: it made
  // every epic with a branch claim an accepted spec, which is precisely the false green the ladder
  // exists to prevent. Now: a GO verdict is `done`, a folder without one is `partial` (drafted,
  // not accepted), no folder at all is `none`, and a specs source we could not read is `unknown`.
  raw.spec = !sourceOk(sources, 'specs')
    ? 'unknown'
    : (specs ? (specs.stage === 'done' ? 'done' : 'partial') : 'none');
  raw.pushed = tally(epicBranches.map((b) => (b.unpushed === null ? null : b.unpushed === 0)));
  raw.mergedDevelop = tally(epicBranches.map((b) => b.mergedIntoDevelop));
  const mergedMain = tally(epicBranches.map((b) => b.mergedIntoMain));

  if (!deployKnown) {
    // No deploy source. Claiming `todo` for an epic that is fully merged would be a guess; claiming
    // `done` would be a false green. Unknown is the only honest answer once merge is complete.
    raw.deployedDev = raw.mergedDevelop === 'done' ? 'unknown' : 'none';
    raw.prod = mergedMain === 'done' ? 'unknown' : (mergedMain === 'partial' ? 'partial' : 'none');
  } else {
    const repoIds = epicRepoIds;
    raw.deployedDev = tally(repoIds.map((id) => ctx.deployedDevByRepo(id, epicBranches)));
    const prodCells = repoIds.map((id) => ctx.deployedProdByRepo(id, epicBranches));
    raw.prod = prodCells.some((v) => v === 'violation') ? 'violation' : tally(prodCells.map((v) => (v === 'violation' ? null : v)));
    if (mergedMain !== 'done' && raw.prod === 'done') raw.prod = 'partial';
  }
  raw.flags = flag ? (flag.state === 'on' || flag.state === 'n/a' ? 'done' : 'none') : 'unknown';

  const ladder = assembleLadder(raw);

  // ---- signals, three disjoint classes
  const activity = [];
  const dangling = [];
  const drift = [];
  const phraseCtx = { branchCount: epicBranches.length };

  const blockedSession = epicSessions.find((s) => s.status === 'blocked');
  if (blockedSession) { activity.push('session-blocked'); phraseCtx.notificationType = blockedSession.notificationType || null; }
  if (epicSessions.some((s) => s.status === 'running' || s.status === 'idle')) activity.push('session-live');
  if (epicDecisions.length) { activity.push('decision-open'); phraseCtx.decisionSince = epicDecisions.map((d) => d.since).sort()[0]; }
  // DRIFT, not activity. See the header: a Jira status alone may not make an epic ACTIVE.
  if (jira && jira.statusCategory === 'indeterminate') drift.push('jira-in-progress');
  const newestCommit = epicBranches.reduce((acc, b) => maxIso(acc, b.lastCommitAt), null);
  if (newestCommit && now - Date.parse(newestCommit) <= RECENT_COMMIT_MS) activity.push('recent-commit');

  const unpushedTotal = epicBranches.reduce((n, b) => n + (b.unpushed || 0), 0);
  if (unpushedTotal > 0) { dangling.push('unpushed-commits'); phraseCtx.unpushed = unpushedTotal; }
  const dirtyWorktrees = epicBranches
    .map((b) => (b.worktree ? worktreeByPath.get(b.worktree) : null))
    .filter((w) => w && w.dirty && !(w.dirty.staged === 0 && w.dirty.unstaged === 0 && w.dirty.untracked === 0));
  if (dirtyWorktrees.length) { dangling.push('dirty-worktree'); phraseCtx.dirtyWorktrees = dirtyWorktrees.length; }
  const unmerged = epicBranches.filter((b) => b.mergedIntoDevelop === false).length;
  if (unmerged > 0) { dangling.push('unmerged-develop'); phraseCtx.unmerged = unmerged; }
  if (raw.mergedDevelop === 'done' && deployKnown && ladder.deployedDev !== 'done') dangling.push('merged-not-deployed');
  if (ladder.deployedDev === 'done' && flag && flag.state === 'off') dangling.push('deployed-flag-off');

  const zone = activity.length ? 'active' : ((dangling.length || drift.length) ? 'dormant' : 'gone');

  // ---- lastActivityAt: commits, mapped-session hook events, epic-keyed decision touches. Deploys,
  // Jira and specs are deliberately excluded — they are other people's clocks, not the epic's.
  let lastActivityAt = newestCommit;
  for (const s of epicSessions) lastActivityAt = maxIso(lastActivityAt, s.lastEventAt || null);
  for (const d of epicDecisions) lastActivityAt = maxIso(lastActivityAt, d.touchedAt || d.since || null);
  if (!lastActivityAt) lastActivityAt = EPOCH;

  // ---- phrase. Shape is (lead · dangling): the lead is the top activity signal, or — when there
  // is none — the drift signal, so a Jira-only epic still says what it is instead of rendering
  // blank. Order is total in every class, so ties cannot happen.
  const topActivity = ACTIVITY_SIGNALS.find((s) => activity.indexOf(s) !== -1);
  const topDrift = DRIFT_SIGNALS.find((s) => drift.indexOf(s) !== -1);
  const topDangling = DANGLING_SIGNALS.find((s) => dangling.indexOf(s) !== -1);
  const parts = [];
  if (topActivity) parts.push(ACTIVITY_PHRASE[topActivity](phraseCtx));
  else if (topDrift) parts.push(DRIFT_PHRASE[topDrift](phraseCtx));
  if (topDangling) parts.push(DANGLING_PHRASE[topDangling](phraseCtx));

  const aliasList = aliases && aliases.epics && Array.isArray(aliases.epics[key]) ? aliases.epics[key].slice() : [];
  const titles = aliases && aliases.titles && typeof aliases.titles === 'object' ? aliases.titles : {};

  return {
    key,
    aliases: aliasList,
    title: typeof titles[key] === 'string' ? titles[key] : null,
    jira: jira || null,
    ladder,
    zone,
    signals: activity.concat(drift).concat(dangling),
    phrase: parts.join(' · '),
    lastActivityAt,
    repos: Array.from(new Set(epicBranches.map((b) => b.repoId))).sort(),
    flag: flag,
    branchCount: epicBranches.length,
  };
}

// ---- attention ----------------------------------------------------------------------------------

function buildAttention(epics, ctx) {
  const items = [];

  for (const s of ctx.sessions) {
    if (s.status !== 'blocked') continue;
    // Deadline in the past => demote. A null deadline is NOT stale: it means the session never
    // submitted, so there is no window to have missed.
    const expired = s.cacheExpiresAt != null && Date.parse(s.cacheExpiresAt) <= ctx.now;
    items.push({
      type: expired ? 'blocked-stale' : 'blocked', sessionKey: s.key, epic: s.epic || null, deadline: s.cacheExpiresAt || null,
      // Carried onto the item so the row can say WHY there is no Jump without looking the session
      // back up. Null whenever there is a jump action.
      surfaceReason: s.surface && s.surface.tabUuid ? null : (s.surfaceReason || null),
      actions: s.surface && s.surface.tabUuid
        ? [{ kind: 'jump', machine: s.key.machine, tabRef: s.surface.tabRef || null, tabUuid: s.surface.tabUuid }]
        : [],
    });
  }

  // One row per repo whose default branch has unpushed commits. Not folded into `mergeable`: there
  // is nothing to merge — the work is already ON the target branch and simply has not left the disk.
  for (const d of (ctx.defaultUnpushed || [])) {
    items.push({ type: 'default-unpushed', repo: d.repo, branch: d.branch, unpushed: d.unpushed, actions: [{ kind: 'context' }] });
  }

  for (const v of ctx.ruleViolations) {
    items.push({ type: 'rule-violation', repo: v.repo, env: v.env, note: v.note, actions: [{ kind: 'context' }] });
  }

  for (const d of ctx.decisions) {
    if (d.closedAt) continue;
    items.push({
      type: 'decision', id: d.id, epic: d.epic || null, title: d.title, since: d.since,
      actions: [{ kind: 'context' }, { kind: 'close' }],
    });
  }

  // Ready to merge: git proves the work is pushed but not yet on develop.
  for (const e of epics) {
    if (e.ladder.pushed === 'done' && e.ladder.mergedDevelop !== 'done' && e.branchCount > 0) {
      items.push({ type: 'mergeable', epic: e.key, note: null, actions: [{ kind: 'context' }] });
    }
  }

  // ORPHANS COLLAPSE BY TYPE (real-board fix, 2026-07-31). See ORPHAN_GROUP_MIN above: on the real
  // board this is 6 branch orphans and 131 spec orphans, and 131 rows of the same sentence is not
  // triage. One row per type, expandable, members intact — never a silent drop.
  const orphans = ctx.orphanBranches
    .map((o) => ({ type: 'orphan', repo: o.repo, branch: o.branch, actions: [{ kind: 'tag' }] }))
    .sort((a, b) => cmpStr(`${a.repo}:${a.branch}`, `${b.repo}:${b.branch}`));
  const specOrphans = ctx.specOrphans
    // `project` is carried because spec-folder names are NOT unique across projects
    // (`p1-foundation` exists twice). Without it the row cannot be told apart from its twin and a
    // tag on one would hide both.
    .map((o) => ({ type: 'spec-orphan', specFolder: o.specFolder, project: o.project || null, actions: [{ kind: 'tag' }] }))
    .sort((a, b) => cmpStr(a.specFolder, b.specFolder));

  // Below the threshold there is nothing to fold — one orphan behind a "1 orphan" expander is
  // strictly worse than the orphan itself.
  const groupOrKeep = (list, groupType) => {
    if (list.length === 0) return;
    if (list.length < ORPHAN_GROUP_MIN) { list.forEach((it) => items.push(it)); return; }
    items.push({ type: groupType, count: list.length, items: list, actions: [{ kind: 'expand' }] });
  };
  groupOrKeep(orphans, 'orphan-group');
  groupOrKeep(specOrphans, 'spec-orphan-group');

  const secondary = (it) => {
    if (it.type === 'blocked' || it.type === 'blocked-stale') return it.deadline || '9999';
    if (it.type === 'decision') return it.since || '9999';
    if (it.type === 'mergeable') return it.epic;
    if (it.type === 'default-unpushed') return it.repo;
    if (it.type === 'orphan') return `${it.repo}:${it.branch}`;
    if (it.type === 'spec-orphan') return it.specFolder;
    if (it.type === 'orphan-group' || it.type === 'spec-orphan-group') return '';   // one of each, by construction
    return `${it.repo || ''}:${it.env || ''}`;
  };
  items.sort((a, b) => (ATTENTION_ORDER.indexOf(a.type) - ATTENTION_ORDER.indexOf(b.type)) || cmpStr(secondary(a), secondary(b)));
  return items;
}

// Attention with every group unfolded in place. The ONE implementation of "what is actually in the
// queue" — validators, the CLI's --all view and every test go through it, so a grouped row can never
// make an item invisible to a consumer that forgot groups exist.
function flattenAttention(list) {
  const out = [];
  for (const it of (Array.isArray(list) ? list : [])) {
    if ((it.type === 'orphan-group' || it.type === 'spec-orphan-group') && Array.isArray(it.items)) {
      for (const m of it.items) out.push(m);
    } else out.push(it);
  }
  return out;
}

// ---- inbox (spec §5.3, §5.4) ---------------------------------------------------------------------
// The one uncapped, ungrouped, oldest-first list of sessions actually waiting on the operator.
//
// It is the ONE derivation that reads the FULL sessions[] rather than the `liveSessions` shield: a
// vanished session — the tab it was known by is closed — is still a real prompt someone must answer
// or kill, so it belongs in the inbox as a read-only row. Every other derivation is shielded, which
// is what makes publishing vanished rows a no-op for attention[] and counts.blocked.

// Verdicts that mean "an operator has to look at this". `offer-more` and `status-only` are the
// classifier saying the session is not waiting on a decision, so they never reach the queue.
const INBOX_VERDICTS = ['needs-decision', 'unknown'];

// The notification types that mean the session is waiting on TEXT. A permission prompt is waiting on
// a MENU (trap 20), so it is read-only however well its surface resolved.
const ANSWERABLE_NOTIFICATIONS = ['idle_prompt', 'agent_needs_input'];

// A missing `intent` is SYNTHESIZED, never copied through (spec §5.3). A blocked session can reach
// here without one — a stage bug, partial wiring, a hand-built state — and `undefined` would break
// both the row contract and the GET route's unconditional `item.intent.verdict` dereference. The
// projection is explicit and total: five fields, nothing undefined, `inferred` always true.
function inboxIntent(session, now) {
  const i = session.intent;
  if (!i || typeof i !== 'object' || !i.verdict) {
    return { verdict: 'unknown', reason: 'intent missing', model: null, at: new Date(now).toISOString(), inferred: true };
  }
  return {
    verdict: i.verdict,
    reason: i.reason == null ? null : i.reason,
    model: i.model == null ? null : i.model,
    at: i.at == null ? new Date(now).toISOString() : i.at,
    inferred: true,
  };
}

// Exactly four fields (spec §5.3). `tabStatus` is deliberately NOT projected: cmux status is
// workspace-scoped even though it is stamped onto every tab, so it can never prove anything about
// the one terminal a reply would be written into — carrying it forward would only invite a consumer
// to read it as readiness.
function inboxSurface(session) {
  const s = session.surface;
  if (!s || typeof s !== 'object' || !s.tabUuid) return null;
  return {
    workspace: s.workspace == null ? null : s.workspace,
    tabRef: s.tabRef == null ? null : s.tabRef,
    tabUuid: s.tabUuid,
    via: s.via === 'recorded' ? 'recorded' : 'cwd',
  };
}

// Ascending by blockedSince. Rows speak ISO (trap 23), so parse before comparing rather than relying
// on lexicographic luck; an unparseable value sorts last instead of poisoning the comparator.
const blockedAt = (row) => {
  const t = Date.parse(row.blockedSince);
  return Number.isFinite(t) ? t : Infinity;
};

function buildInbox(sessions, now) {
  const rows = [];
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    // A row without an identity is not addressable — there is nothing a reply could be aimed at.
    if (!s || !s.key || !s.key.sessionId) continue;
    // 1. Only `blocked`. `abandoned`, `running` and `idle` are excluded.
    if (s.status !== 'blocked') continue;
    // 2. A null deadline is NOT stale — it means the session never submitted, so there is no window
    //    to have missed. A deadline that has passed is excluded even when nothing else would exclude
    //    it (`blocked-stale` is an attention item TYPE, never a session status — trap 4).
    if (s.cacheExpiresAt != null && !(Date.parse(s.cacheExpiresAt) > now)) continue;
    // 3. The verdict gate, with a missing intent synthesized before it is read.
    const intent = inboxIntent(s, now);
    if (INBOX_VERDICTS.indexOf(intent.verdict) === -1) continue;

    const lastAssistant = s.lastAssistant && typeof s.lastAssistant === 'object' ? s.lastAssistant : null;
    const surface = inboxSurface(s);
    const notificationType = typeof s.notificationType === 'string' ? s.notificationType : '';
    // A cwd join is a guess about WHICH terminal and the reply route only ever writes through
    // recorded identity, so advertising Send on one would offer an action the route must refuse.
    const answerable = !!(surface && surface.via === 'recorded' && ANSWERABLE_NOTIFICATIONS.indexOf(notificationType) !== -1);
    const blockedSince = s.blockedSince;

    rows.push({
      sessionKey: { machine: s.key.machine, sessionId: s.key.sessionId },
      blockedSince,
      lastStopAt: s.lastStopAt == null ? null : s.lastStopAt,
      cacheExpiresAt: s.cacheExpiresAt == null ? null : s.cacheExpiresAt,
      cacheApprox: true,
      notificationType,
      // The turn identity token the reply must echo (spec §5.5). Both halves verbatim: a reply that
      // echoes a turn the session has since moved past is refused rather than written blind.
      turn: { blockedSince, assistantTs: lastAssistant && lastAssistant.ts != null ? lastAssistant.ts : null },
      repo: s.repo == null ? null : s.repo,
      worktree: s.worktree == null ? null : s.worktree,
      epic: s.epic == null ? null : s.epic,
      // COMPLETE text, never truncated here (trap 12). Truncation is a rendering concern.
      question: lastAssistant && typeof lastAssistant.text === 'string' ? lastAssistant.text : '',
      intent,
      surface,
      surfaceReason: s.surfaceReason == null ? null : s.surfaceReason,
      answerable,
      // There is no dismiss (principle 3): a row leaves the queue by being answered or by the
      // session ceasing to wait, never by being swept under a rug.
      actions: answerable ? [{ kind: 'reply' }] : [],
    });
  }
  rows.sort((a, b) => (blockedAt(a) - blockedAt(b))
    || cmpStr(a.sessionKey.machine, b.sessionKey.machine)
    || cmpStr(a.sessionKey.sessionId, b.sessionKey.sessionId));
  return rows;
}

// ---- p6 suppression (spec §6.6) ------------------------------------------------------------------
// An attention item is removed from the PUBLISHED attention[] iff it contributes AT LEAST ONE fact
// key and every key it contributes is held by some live handoff. The non-empty precondition is not
// pedantry (spec §9 trap 20): "every key it contributes is covered" is vacuously true of an item
// contributing NONE, and a vacuous reading would hide every blocked prompt, open decision,
// rule-violation and spec-orphan the moment any handoff went live.
//
// The covered set comes from the PUBLISHED live handoffs' factKeys — which the server derives from
// its in-memory ledger index (spec §3). Nothing here reads index.json or locks.json; this function
// is as pure as the rest of the file.
function suppressAttention(attention, covered, stateLite) {
  if (!covered || covered.size === 0) return attention;
  const gone = (it) => {
    const keys = keysOfAttentionItem(stateLite, it);
    return keys.length > 0 && keys.every((key) => covered.has(key));
  };
  const out = [];
  for (const it of attention) {
    // A folded group is removed only when EVERY member is (flattenAttention decides membership);
    // a partially covered group keeps its remaining members reachable. Below ORPHAN_GROUP_MIN the
    // survivors go back to being loose rows — a "group of one" is barred by the schema and would be
    // strictly worse than the row itself.
    if (it.type === 'orphan-group' && Array.isArray(it.items)) {
      const members = it.items.filter((m) => !gone(m));
      if (members.length === 0) continue;
      if (members.length === it.items.length) { out.push(it); continue; }
      if (members.length < ORPHAN_GROUP_MIN) { out.push(...members); continue; }
      out.push(Object.assign({}, it, { count: members.length, items: members }));
      continue;
    }
    if (gone(it)) continue;
    out.push(it);
  }
  return out;
}

// ---- entry ---------------------------------------------------------------------------------------

function derive(input) {
  const now = input.now == null ? Date.now() : input.now;
  const sources = input.sources || {};
  const aliases = input.aliases || {};
  const fragments = input.fragments || {};
  const gitFragment = fragments.git || { repos: {} };
  const sessionsFragment = fragments.sessions || { sessions: [], machines: null };
  const deployFragment = fragments.deploy || { repos: {} };
  const jiraFragment = fragments.jira || { epics: {} };
  const specsFragment = fragments.specs || { specOrphans: [], epics: {} };

  const repos = {};
  const branches = [];
  const worktreeByPath = new Map();
  const orphanBranches = [];
  const defaultUnpushed = [];
  let staleWorktrees = 0;

  for (const repoId of Object.keys(gitFragment.repos || {}).sort()) {
    const r = gitFragment.repos[repoId];
    const deploy = (deployFragment.repos && deployFragment.repos[repoId]) || r.deploy || null;
    repos[repoId] = {
      path: r.path,
      defaultBranches: r.defaultBranches || {},
      branches: r.branches || [],
      worktrees: r.worktrees || [],
      deploy,
      fetch: r.fetch || { status: 'skipped', error: null },
    };
    for (const b of repos[repoId].branches) {
      branches.push(Object.assign({ repoId }, b));
      if (!b.epic && !b.isDefault) orphanBranches.push({ repo: repoId, branch: b.name });
      // Work committed straight to a DEFAULT branch belongs to no epic (epicBranches filters
      // !isDefault), so before this it appeared on no row at all — radar knew `main` had N unpushed
      // commits and showed it nowhere. That is the dangle loop, inside the tool built to end it:
      // this repo's own 4 unpushed commits were invisible on its own board. Repo-level, because
      // there is no epic to hang it on.
      if (b.isDefault && typeof b.unpushed === 'number' && b.unpushed > 0) {
        defaultUnpushed.push({ repo: repoId, branch: b.name, unpushed: b.unpushed });
      }
    }
    for (const w of repos[repoId].worktrees) {
      worktreeByPath.set(w.path, w);
      if (w.stale) staleWorktrees++;
    }
  }

  const decisions = (Array.isArray(input.decisions) ? input.decisions : []).filter((d) => d && typeof d.id === 'string');
  const sessions = Array.isArray(sessionsFragment.sessions) ? sessionsFragment.sessions : [];

  // THE SHIELD (spec §5.4). `sessions[]` now carries `vanished: true` rows — sessions still blocked
  // whose recorded tab has left the tree. They are PUBLISHED, because carry-forward is rebuilt from
  // the published sessions and a vanish held in process is forgotten by the next sweep. But nothing
  // that already existed may change because of them: every legacy derivation below — buildEpic's
  // epic joins, the epic universe, buildAttention, counts.blocked — reads `liveSessions`, so a
  // vanished row contributes no attention item, no epic signal and no count.
  //
  // `buildInbox` alone reads the full `sessions[]`: a closed tab does not answer the prompt, it only
  // removes the Jump. The row stays in the queue, read-only.
  const liveSessions = sessions.filter((s) => !s.vanished);

  // Epic universe: anything git knows about, plus epics that exist only as an open decision or only
  // in Jira. An epic with zero signals is dropped below — "done = disappears".
  const keys = new Set();
  for (const b of branches) if (b.epic && !b.isDefault) keys.add(b.epic);
  for (const d of decisions) if (d.epic && !d.closedAt) keys.add(d.epic);
  for (const s of liveSessions) if (s.epic) keys.add(s.epic);
  for (const k of Object.keys(jiraFragment.epics || {})) keys.add(k);

  // Deploy ancestry hooks (S-005 fills these in; with the deploy source disabled they are unreachable).
  //
  // A SUCCESSFUL PROBE CAN STILL CARRY UNKNOWN ANCESTRY, and that is the whole subtlety here.
  // mod-deploy returns an EMPTY epicBranchAncestry — with status still `ok` — whenever the deployed
  // SHA is not reachable from any local ref (force-push, squash-merge, or merely unfetched). Reading
  // that as `tally(tips) === 'done'` collapsed 'unknown' into FALSE, which the ladder then rendered
  // as a confident "not deployed". Unknown must beat a guess in BOTH directions (§2), so the three
  // outcomes are kept three: true (deployed), false (answered, not deployed), null (we do not know).
  const ancestryOf = (d, repoId, epicBranches) => {
    const tips = epicBranches.filter((b) => b.repoId === repoId).map((b) => (d.epicBranchAncestry ? d.epicBranchAncestry[b.name] : null));
    if (tips.length === 0) return null;
    const t = tally(tips);
    return t === 'unknown' ? null : t === 'done';
  };
  const deployedDevByRepo = (repoId, epicBranches) => {
    const d = repos[repoId] && repos[repoId].deploy && repos[repoId].deploy.dev;
    if (!d || d.status !== 'ok') return null;
    return ancestryOf(d, repoId, epicBranches);
  };
  const deployedProdByRepo = (repoId, epicBranches) => {
    const d = repos[repoId] && repos[repoId].deploy && repos[repoId].deploy.prod;
    if (!d) return null;
    if (d.ruleViolation === true) return 'violation';
    if (d.status !== 'ok') return null;
    return ancestryOf(d, repoId, epicBranches);
  };

  // Does this repo carry ANY deploy fact? Not "is it healthy" — a degraded probe is still a fact
  // radar observed for this repo, and it renders as unknown through the ancestry helpers above. The
  // question here is only whether the epic's cells should be computed from deploy data at all, or
  // fall back to the merge-state heuristic used when deploy is unconfigured/disabled entirely.
  const deployKnownForRepo = (repoId) => {
    const d = repos[repoId] && repos[repoId].deploy;
    return !!(d && typeof d === 'object' && (d.dev || d.prod));
  };

  const ctx = {
    branches, worktreeByPath, sessions: liveSessions, decisions, aliases, sources, now,
    deployedDevByRepo, deployedProdByRepo, deployKnownForRepo,
  };

  const epics = Array.from(keys)
    .sort()
    .map((k) => buildEpic(k, Object.assign({}, ctx, {
      jira: (jiraFragment.epics || {})[k] || null,
      specs: (specsFragment.epics || {})[k] || null,
    })))
    .filter((e) => e.zone !== 'gone')
    .sort((a, b) => (a.zone === b.zone ? 0 : a.zone === 'active' ? -1 : 1)
      || cmpStr(b.lastActivityAt, a.lastActivityAt)
      || cmpStr(a.key, b.key));

  const ruleViolations = [];
  for (const repoId of Object.keys(repos)) {
    const d = repos[repoId].deploy;
    if (!d) continue;
    for (const env of ['dev', 'prod']) {
      if (d[env] && d[env].ruleViolation === true) {
        ruleViolations.push({ repo: repoId, env, note: d[env].note || 'deployed SHA is not an ancestor of the target branch' });
      }
    }
  }

  const specOrphans = Array.isArray(specsFragment.specOrphans) ? specsFragment.specOrphans : [];
  const attention = buildAttention(epics, {
    now, sessions: liveSessions, decisions, orphanBranches, defaultUnpushed, ruleViolations, specOrphans,
  });

  // The full array, deliberately: the queue is the one place a vanished session stays visible.
  const inbox = buildInbox(sessions, now);

  // ---- p6 handoffs (spec §4.6). The server passes the LIVE set (and the recovery element) from
  // its in-memory ledger index; with nothing passed the fields publish their required empty values,
  // so a consumer never has to distinguish absent from empty.
  const handoffs = Array.isArray(input.handoffs) ? input.handoffs : [];
  const handoffRecovery = input.handoffRecovery == null ? null : input.handoffRecovery;
  const role = input.config && input.config.role === 'viewer' ? 'viewer' : 'leader';

  // EVERY p5 count is computed from the UNSUPPRESSED structures, and only then is suppression
  // applied to the published attention[] (spec §6.6, load-bearing ordering): counts.mergeable is
  // computed from attention itself, so suppressing first would silently change an existing p5
  // count. counts.handoffsLive is the ONE count p6 adds.
  const counts = {
    blocked: liveSessions.filter((s) => s.status === 'blocked').length,
    decisions: decisions.filter((d) => !d.closedAt).length,
    mergeable: attention.filter((a) => a.type === 'mergeable').length,
    // Counted from the SOURCE lists, not from attention[]: grouping folds N rows into 1, and a
    // count that silently dropped to 1 would be the exact false-green the fold exists to avoid.
    orphans: orphanBranches.length + specOrphans.length,
    staleWorktrees,
    handoffsLive: handoffs.length,
    // From the LIST, never from a display array (trap 13). The inbox is uncapped and ungrouped, so
    // the two can only ever diverge if a renderer's slice were mistaken for the queue itself.
    inbox: inbox.length,
  };

  const covered = new Set();
  for (const h of handoffs) for (const key of (Array.isArray(h.factKeys) ? h.factKeys : [])) covered.add(key);
  // keysOfAttentionItem resolves `mergeable` through the epic's branch/worktree records, so it
  // needs the repos and epics assembled above — the same shape the published snapshot carries.
  const published = suppressAttention(attention, covered, { repos, epics, attention });

  // The Jira drift digest (spec §M4): weekly reading, never an interrupt, never an attention item.
  // Carried on the snapshot so the CLI and the daily brief can read it without a second Jira call.
  // `jira-inprogress-no-git` is the direction that used to be rendered as an ACTIVE epic.
  const jiraDrift = Array.isArray(jiraFragment.drift) ? jiraFragment.drift : [];

  const machines = Array.isArray(sessionsFragment.machines) && sessionsFragment.machines.length
    ? sessionsFragment.machines
    : [{ id: input.collectorId, bridge: 'unknown', lastSeenAt: null }];

  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    collectorId: input.collectorId,
    machines,
    sources,
    counts,
    repos,
    epics,
    sessions,
    attention: published,
    inbox,
    handoffs,
    handoffRecovery,
    role,
    jiraDrift,
  };
}

module.exports = {
  derive, assembleLadder, tally, buildEpic, buildAttention, epicFlag, flattenAttention,
  suppressAttention, buildInbox,
  LADDER_ORDER, ATTENTION_ORDER, ACTIVITY_SIGNALS, DANGLING_SIGNALS, DRIFT_SIGNALS,
  ORPHAN_GROUP_MIN, RECENT_COMMIT_MS, EPOCH, INBOX_VERDICTS, ANSWERABLE_NOTIFICATIONS,
};
