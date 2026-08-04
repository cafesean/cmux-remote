'use strict';
// workref.js — p11 S-002. The canonical, source-neutral work reference.
//
// WHAT THIS MODULE IS FOR. Radar could already see git-shaped work. It could not see the work an
// operator actually has to choose between, because that lives in a tracker. A WorkRef is the shape
// that lets one selector rank a Jira issue against a dangling branch without either source losing
// its authority.
//
// ------------------------------------------------------------------------------------------------
// NO DUPLICATE SOURCE OF TRUTH — the rule the whole file exists to obey (spec §2, §4.1).
//
// Radar stores REFERENCES and DERIVED state, never content bodies. `status.native` and
// `status.nativeCategory` are carried VERBATIM from the source and are the authority.
// `status.canonical` is a PROJECTION: it is computed here, it is never written back anywhere, and
// where it disagrees with the source that disagreement is already reported as drift by mod-jira.
// One item is one urn; overlap across sources resolves through `links[]`, never by merging records.
//
// ------------------------------------------------------------------------------------------------
// THE WORD `inbox` MEANS TWO DIFFERENT THINGS IN THIS REPOSITORY. Say it here, at the point the
// vocabulary is defined, because the other one is one merge away (spec §8.2 rule 1).
//
//   p11 (this file)  `inbox` is a WORK-STATUS PROJECTION: the source has no triage state yet.
//   p9               `inbox` is an EVALUATION CORPUS of session material fed to a classifier,
//                    with its own privacy preconditions (scripts/eval-inbox.mjs, branch
//                    feature/p9-inbox).
//
// They are unrelated. This module must not import from, extend, or be scored by p9's machinery, and
// p9's corpus rules are not weakened by anything here. The approved status vocabulary keeps the
// word; renaming a spec-approved value to dodge a name clash would be worse than documenting it.
//
// ------------------------------------------------------------------------------------------------
// ONE MAPPING ENGINE, NOT TWO. `links[]` joins an epic key to git branches through mod-git's
// `mapBranchToEpic` — the same function mod-sessions already reuses so a session and a branch agree
// on what an alias means. A second mapper here would drift from it on the first alias edit.
const { mapBranchToEpic } = require('./mod-git');

// Fixed, small, and a projection only. Anything not derivable lands on `unknown` rather than being
// guessed into one of the others — the p5 law, applied to status.
const CANONICAL = ['inbox', 'ready', 'active', 'blocked', 'waiting', 'parked', 'done', 'unknown'];

// The three categories the Jira API guarantees. Mapping is by CATEGORY, never by display name: on a
// real instance the in-flight statuses spread across several names under one category, and matching
// names silently drops most of them (mod-jira.js says the same thing at more length).
const JIRA_CATEGORIES = ['new', 'indeterminate', 'done'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// ---- identity ------------------------------------------------------------------------------------

// urn:work:<source>:<sourceId>. Source is lowercased because it is ours; sourceId is verbatim
// because it is the source's and normalising it would break the round trip back to that source.
function urnFor(source, sourceId) {
  if (!nonEmpty(source) || !nonEmpty(sourceId)) return null;
  return `urn:work:${String(source).trim().toLowerCase()}:${String(sourceId).trim()}`;
}

// The grouping key a packet would use. An epic key when one exists — that is what makes a packet id
// stable across scans for free (p6 §M3) — else the item's own source:id, so every WorkRef has one.
function clusterFor(source, sourceId, epicKey) {
  if (nonEmpty(epicKey)) return String(epicKey).trim();
  if (!nonEmpty(source) || !nonEmpty(sourceId)) return null;
  return `${String(source).trim().toLowerCase()}:${String(sourceId).trim()}`;
}

// ---- links ---------------------------------------------------------------------------------------

// Every git branch whose epic mapping resolves to this key. Computed, never stored by a connector.
// Default branches are not epic-mapped by mapBranchToEpic (they carry no key and match no alias), so
// they cannot join here — which is the behavior the eligibility join depends on downstream.
function linksFor(epicKey, gitFragment, aliases) {
  if (!nonEmpty(epicKey)) return [];
  const repos = (gitFragment && isObj(gitFragment.repos)) ? gitFragment.repos : {};
  const out = [];
  for (const repoId of Object.keys(repos).sort()) {
    const branches = Array.isArray(repos[repoId] && repos[repoId].branches) ? repos[repoId].branches : [];
    for (const b of branches) {
      if (!b || !nonEmpty(b.name)) continue;
      const m = mapBranchToEpic(repoId, b.name, aliases || {});
      if (m.epic === epicKey) out.push(`urn:work:git:${repoId}/${b.name}`);
    }
  }
  return out;
}

// ---- the dangling-fact question --------------------------------------------------------------------

// "Is there leftover work on this cluster?" Deliberately the SAME fact classes p5's derive already
// calls dangling (unpushed / unmerged / dirty worktree), read off the git fragment rather than
// recomputed, so a WorkRef and an epic row can never disagree about whether work is outstanding.
function clusterHasDanglingFacts(epicKey, gitFragment, aliases) {
  if (!nonEmpty(epicKey)) return false;
  const repos = (gitFragment && isObj(gitFragment.repos)) ? gitFragment.repos : {};
  for (const repoId of Object.keys(repos)) {
    const repo = repos[repoId] || {};
    for (const b of Array.isArray(repo.branches) ? repo.branches : []) {
      if (!b || !nonEmpty(b.name)) continue;
      if (mapBranchToEpic(repoId, b.name, aliases || {}).epic !== epicKey) continue;
      if (Number(b.unpushed) > 0) return true;
      if (b.mergedIntoDevelop === false) return true;
    }
    for (const w of Array.isArray(repo.worktrees) ? repo.worktrees : []) {
      if (!w || !nonEmpty(w.branch)) continue;
      if (mapBranchToEpic(repoId, w.branch, aliases || {}).epic !== epicKey) continue;
      const d = w.dirty || {};
      if (Number(d.staged) > 0 || Number(d.unstaged) > 0 || Number(d.untracked) > 0) return true;
    }
  }
  return false;
}

// ---- status projection ------------------------------------------------------------------------------

// Precedence is not cosmetic — it is the whole contract, so it is written as one ordered list:
//
//   1. blocked   a linked session is blocked. RADAR-DERIVED, and it OUTRANKS Jira (spec §4.1):
//                a tracker cannot know a session is sitting on a prompt.
//   2. parked    a human said "not now". Also outranks the tracker, for the same reason.
//   3. waiting   an open decision / waiting-on item on the cluster.
//   4. done      Jira says done AND git shows nothing outstanding. BOTH legs required.
//   5. active    Jira in-flight, or radar sees real activity on the cluster.
//   6. ready     Jira new, AND triaged (a sprint or an assignee). New-and-untriaged is not ready.
//   7. inbox     the source has no triage state at all.
//   8. unknown   everything else — including the CONTESTED case below.
//
// THE CONTESTED CASE, stated because it is the one a reader will think is a bug: Jira says `done`
// while git still shows unpushed/unmerged/dirty work. The `done` rule requires both legs, so it does
// not fire, and nothing below it describes the situation either — so the projection is `unknown`.
// That is the intended answer, not a gap: the two sources of record disagree, mod-jira already
// reports it as `jira-done-git-live` drift, and asserting either side here would be radar guessing
// about work it can see is not finished. Unknown beats false green.
function projectStatus(input) {
  const jiraCategory = JIRA_CATEGORIES.includes(input && input.nativeCategory) ? input.nativeCategory : null;
  const triaged = Boolean(input && (input.hasSprint || input.hasAssignee));

  if (input && input.sessionBlocked) return 'blocked';
  if (input && input.parked) return 'parked';
  if (input && input.waiting) return 'waiting';
  if (jiraCategory === 'done') return input && input.hasDanglingFacts ? 'unknown' : 'done';
  if (jiraCategory === 'indeterminate') return 'active';
  if (input && input.hasActivitySignal) return 'active';
  if (jiraCategory === 'new') return triaged ? 'ready' : 'inbox';
  return 'unknown';
}

// ---- selectability -----------------------------------------------------------------------------------

// §6.2. Three independent legs, and each one is a real gate:
//   - the canonical status is one a session could act on,
//   - the cluster is inside the operator's allowlist (out of scope is INVISIBLE, never escalated),
//   - and there is actually something to act on, so an empty tracker row is never dispatched.
function isSelectable(wr, scope) {
  if (!wr || !['ready', 'active', 'blocked'].includes(wr.status && wr.status.canonical)) return false;
  if (!inScope(wr, scope)) return false;
  return Boolean((Array.isArray(wr.links) && wr.links.length) || wr.hasSpecFolder || nonEmpty(wr.description));
}

// An allowlist. Absent scope means unrestricted, which is the CLI's case; the operator always passes
// one. A project or repo outside it is simply not selected — and pointedly not reported either,
// because "I refused to look at this" is not an interrupt worth having (spec §M3).
function inScope(wr, scope) {
  if (!isObj(scope)) return true;
  const projects = Array.isArray(scope.jiraProjects) ? scope.jiraProjects : null;
  if (projects && wr.source === 'jira') {
    const key = String(wr.sourceId || '');
    const proj = key.includes('-') ? key.slice(0, key.indexOf('-')) : key;
    if (!projects.includes(proj)) return false;
  }
  const repos = Array.isArray(scope.repos) ? scope.repos : null;
  if (repos && Array.isArray(wr.links) && wr.links.length) {
    const touched = wr.links
      .filter((u) => u.startsWith('urn:work:git:'))
      .map((u) => u.slice('urn:work:git:'.length).split('/')[0]);
    if (touched.length && !touched.some((r) => repos.includes(r))) return false;
  }
  return true;
}

// ---- builder ------------------------------------------------------------------------------------------

// Pure. No I/O, no clock — `observedAt` is passed in, exactly like every other derived value in this
// codebase, so a fixture run is reproducible.
function buildWorkRef(raw, ctx) {
  const c = ctx || {};
  const source = String(raw.source || '').toLowerCase();
  const sourceId = String(raw.sourceId || '');
  const urn = urnFor(source, sourceId);
  if (!urn) return null;

  const epicKey = nonEmpty(raw.epicKey) ? raw.epicKey.trim() : null;
  const links = linksFor(epicKey, c.gitFragment, c.aliases);
  const hasDanglingFacts = clusterHasDanglingFacts(epicKey, c.gitFragment, c.aliases);

  const canonical = projectStatus({
    nativeCategory: raw.nativeCategory,
    hasSprint: Boolean(raw.sprint),
    hasAssignee: nonEmpty(raw.assignee),
    sessionBlocked: Boolean(raw.sessionBlocked),
    parked: Boolean(raw.parked),
    waiting: Boolean(raw.waiting),
    hasActivitySignal: Boolean(raw.hasActivitySignal),
    hasDanglingFacts,
  });

  const wr = {
    urn,
    source,
    sourceId,
    sourceUrl: nonEmpty(raw.sourceUrl) ? raw.sourceUrl : null,
    kind: nonEmpty(raw.kind) ? raw.kind : 'issue',
    title: nonEmpty(raw.title) ? raw.title : null,
    status: {
      // Verbatim from the source. This pair is the authority; `canonical` below is ours.
      native: nonEmpty(raw.nativeStatus) ? raw.nativeStatus : null,
      nativeCategory: JIRA_CATEGORIES.includes(raw.nativeCategory) ? raw.nativeCategory : null,
      canonical,
    },
    assignee: nonEmpty(raw.assignee) ? raw.assignee : null,
    due: nonEmpty(raw.due) ? raw.due : null,
    sprint: raw.sprint || null,
    board: raw.board || null,
    updatedAt: nonEmpty(raw.updatedAt) ? raw.updatedAt : null,
    provenance: {
      connector: nonEmpty(raw.connector) ? raw.connector : null,
      observedAt: c.observedAt || null,
      // `recorded` = read straight from the source this scan. There is no inference path in this
      // module, so nothing here may ever claim a weaker confidence it did not earn.
      confidence: 'recorded',
    },
    links,
    cluster: clusterFor(source, sourceId, epicKey),
    description: nonEmpty(raw.description) ? raw.description : null,
    hasSpecFolder: Boolean(raw.hasSpecFolder),
    selectable: false,
    // Filled by eligibility.js (S-005). Null means unresolved, and the reason travels with it there.
    route: null,
  };
  wr.selectable = isSelectable(wr, c.scope);
  return wr;
}

function buildWorkRefs(rawItems, ctx) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!isObj(raw)) continue;
    const wr = buildWorkRef(raw, ctx);
    if (!wr) continue;
    // One item is one urn. A duplicate is a connector bug, and the first read wins rather than the
    // two being merged — merging is exactly what `links[]` exists to avoid.
    if (seen.has(wr.urn)) continue;
    seen.add(wr.urn);
    out.push(wr);
  }
  out.sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
  return out;
}

module.exports = {
  buildWorkRef,
  buildWorkRefs,
  projectStatus,
  isSelectable,
  inScope,
  linksFor,
  clusterHasDanglingFacts,
  urnFor,
  clusterFor,
  CANONICAL,
  JIRA_CATEGORIES,
};
