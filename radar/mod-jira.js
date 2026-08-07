'use strict';
// mod-jira (S-008) — the third opinion about what is happening, and the one most likely to be wrong.
//
// TWO QUERIES, NOT ONE (spec §M4, a Codex round-2 fix). This is the whole story of the module:
//
//   Q1  project in (PROJ,ALPHA,BETA) AND issuetype = Epic AND statusCategory != Done
//       Open epics. Feeds the Jira-In-Progress activity signal, which is what lets an epic that
//       exists ONLY in Jira — no branch, no session — still show up on the board.
//
//   Q2  key in (<every epic key git and the alias map currently know about>)
//       The same epics, regardless of status. Q1 cannot see a Done epic by construction, so with
//       Q1 alone the "Jira says done, git is still moving" drift direction is UNDETECTABLE. Q2
//       exists for exactly that direction and for no other reason. Deleting it silently removes
//       half the drift detector while every test that only checks Q1 keeps passing.
//
// MAP BY statusCategory, NEVER BY DISPLAY NAME. On a real instance the in-flight epics are spread
// across "In Progress", "Ready for Code Review" and "Ready for Test" — three names, one category
// (`indeterminate`). Matching on names would silently drop two thirds of them, and would break
// again the next time somebody renames a workflow step.
//
// DRIFT IS A DIGEST, NEVER AN INTERRUPT (spec §M4, binding). Jira being out of date is a fact worth
// knowing weekly and never worth stopping for. This module writes drift onto the epic it describes
// (`epic.jira.drift`) and returns a digest list; it creates no attention item, and derive.js has no
// code path that could turn one into an interrupt.
//
// A FAILURE IS A SOURCE ERROR, NOT AN EMPTY BOARD, and the two queries fail differently. Q1 dying
// returns a NULL fragment, which makes the collector carry the last-good epic facts forward
// unchanged while `sources.jira` carries this scan's fresh error — an empty result would silently
// retire every Jira-only epic from the board and look like progress. Q2 dying is survivable: Q1's
// answer is still true, so the fragment publishes and the source degrades to `stale` naming the
// capability that was lost.
const { getJson } = require('./http');
const store = require('./store');

// No hardcoded host. `jira.baseUrl` in config.json is required; absent it, the source reports
// `disabled` rather than guessing an organisation's Jira. Unknown beats a wrong default.
//
// THE ENVIRONMENT IS AN INJECTED INPUT, NOT AN AMBIENT ONE. This constant used to be the whole
// story, and being a module-load snapshot of process.env made it invisible: whether
// `loadJiraConfig` refused a config with no baseUrl depended on whether the SHELL that started the
// process happened to export JIRA_BASE_URL. A suite that passed on one machine failed on another
// with the same commit, and the difference never appeared in any diff.
//
// So the fallback is now read at CALL time from an env object the caller may supply. Production
// semantics are unchanged — an absent `opts.env` still means `process.env`, and a configured
// JIRA_BASE_URL is still honoured — but the dependency is now visible and testable, so a test can
// pin BOTH directions instead of inheriting whatever the shell had.
const DEFAULT_BASE_URL = process.env.JIRA_BASE_URL || '';
const envBaseUrl = (env) => {
  const e = env || process.env;
  return typeof e.JIRA_BASE_URL === 'string' ? e.JIRA_BASE_URL.trim() : '';
};
// No default project keys: an org's Jira project codes are its own. Absent config, the module
// queries nothing rather than guessing keys that belong to someone else.
const DEFAULT_PROJECTS = [];
const DEFAULT_TOKEN_REF = 'JIRA_API_TOKEN';
const PAGE_SIZE = 100;
// A guard against a server that never advances startAt. 50 pages x 100 = 5000 epics; the real
// number is 63. Hitting this cap is a bug report, not a routine outcome.
const MAX_PAGES = 50;
// Q2's JQL is built from a key list, so it is chunked rather than allowed to grow unbounded.
const KEY_CHUNK = 100;

// Only real Jira keys may enter a `key in (...)` clause. p-numerals ("p59") are alias tokens, not
// issue keys — putting one in the JQL makes Jira reject the WHOLE query with a 400, which would
// take Q2 down and, with it, the Jira-Done drift direction. This regex is the gate.
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

const RECENT_COMMIT_MS = 14 * 24 * 60 * 60 * 1000;
const GIT_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

// The three categories the Jira API guarantees. Anything else is treated as unknown rather than
// coerced into one of these.
const CATEGORIES = ['new', 'indeterminate', 'done'];

// ---- config ---------------------------------------------------------------------------------------

// Read straight from the config FILE rather than the normalized config object: normalizeConfig()
// builds its result key by key and drops sections it does not know about, so a `jira` block added
// there would have to be threaded through P1 code this story does not own. Reading the file again
// costs one small read per scan and keeps the P4 modules self-contained.
async function loadJiraConfig(configPath, opts) {
  const env = (opts && opts.env) || process.env;
  if (!configPath) return { cfg: null, error: null };
  const read = await store.readJson(configPath, null);
  if (!read.ok) return { cfg: null, error: read.error };
  const raw = read.value && typeof read.value === 'object' ? read.value.jira : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { cfg: null, error: null };

  const projects = Array.isArray(raw.projects)
    ? raw.projects.filter((p) => typeof p === 'string' && /^[A-Z][A-Z0-9]*$/.test(p.trim())).map((p) => p.trim())
    : DEFAULT_PROJECTS.slice();
  if (projects.length === 0) return { cfg: null, error: 'jira.projects is empty' };

  // No borrowed host. Without an explicit baseUrl (or JIRA_BASE_URL) the module is DISABLED with a
  // stated reason rather than issuing requests at an empty or guessed origin.
  const baseUrl = (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : envBaseUrl(env)).replace(/\/+$/, '');
  if (!baseUrl) return { cfg: null, error: 'jira.baseUrl is not set (and JIRA_BASE_URL is unset)' };

  return {
    // `cfg` KEEPS ITS EXACT p5 SHAPE — baseUrl, tokenRef, projects, nothing else. p11 first added
    // `agile` in here, which silently widened a return contract other code and tests compare
    // against. "Additive" has to mean additive at every boundary, not only at state.json: a new
    // key inside an existing object is a CHANGE to that object, so the Agile settings travel as
    // their own sibling field instead.
    cfg: {
      baseUrl,
      tokenRef: typeof raw.tokenRef === 'string' && raw.tokenRef.trim() ? raw.tokenRef.trim() : DEFAULT_TOKEN_REF,
      projects,
    },
    // p11 S-003, read here because the whole `jira` block bypasses normalizeConfig's whitelist —
    // mod-jira reads the file itself, so a copy in DEFAULTS would be a second, unused setting.
    agile: normalizeAgile(raw.agile),
    error: null,
  };
}

// OFF by default: the Agile intake is additional load on someone else's server and a strictly
// additive capability, so it is opted into. Same silent-default discipline as radar/config.js.
function normalizeAgile(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const n = Number(o.maxIssuesPerScan);
  return {
    enabled: o.enabled === true,
    maxIssuesPerScan: Number.isFinite(n) ? Math.min(5000, Math.max(1, n)) : 500,
  };
}

// ---- JQL ------------------------------------------------------------------------------------------

// Q1. `statusCategory != Done` is the category, not a status name — that is the whole point.
const openEpicsJql = (projects) =>
  `project in (${projects.join(',')}) AND issuetype = Epic AND statusCategory != Done ORDER BY key`;

// Q2. Regardless of status: this is the only way a Done epic can be observed at all.
const keysJql = (keys) => `key in (${keys.join(',')}) ORDER BY key`;

// Every epic key currently mapped from git or the alias map, filtered to things Jira could
// actually resolve. Decisions and specs contribute too — anything radar has already decided is an
// epic is something whose Jira status we want, whether or not Jira thinks it is open.
function knownEpicKeys(input) {
  const keys = new Set();
  const add = (k) => { if (typeof k === 'string' && ISSUE_KEY_RE.test(k.trim())) keys.add(k.trim()); };

  const repos = (input.fragments && input.fragments.git && input.fragments.git.repos) || {};
  for (const id of Object.keys(repos)) {
    for (const b of (repos[id].branches || [])) if (b && !b.isDefault) add(b.epic);
  }
  const aliasEpics = (input.aliases && input.aliases.epics && typeof input.aliases.epics === 'object') ? input.aliases.epics : {};
  for (const k of Object.keys(aliasEpics)) add(k);
  const overrides = (input.aliases && input.aliases.branchOverrides && typeof input.aliases.branchOverrides === 'object') ? input.aliases.branchOverrides : {};
  for (const k of Object.keys(overrides)) add(overrides[k]);
  for (const d of (Array.isArray(input.decisions) ? input.decisions : [])) if (d && !d.closedAt) add(d.epic);
  const specEpics = (input.fragments && input.fragments.specs && input.fragments.specs.epics) || {};
  for (const k of Object.keys(specEpics)) add(k);

  return Array.from(keys).sort();
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ---- the search loop ---------------------------------------------------------------------------------

// Paginates one JQL query. Returns {issues} or {error}. The JQL is URL-encoded exactly once, here,
// so no caller can forget.
async function searchAll(jql, ctx) {
  const issues = [];
  let startAt = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ctx.baseUrl}/rest/api/2/search`
      + `?jql=${encodeURIComponent(jql)}`
      + `&startAt=${startAt}&maxResults=${PAGE_SIZE}`
      + '&fields=summary,status,project,updated';

    const r = await getJson(url, { authorization: `Bearer ${ctx.token}`, accept: 'application/json' }, ctx.timeoutMs, ctx.fetchImpl);

    if (r.kind === 'stale') return { error: `jira: ${r.error}` };
    if (r.status === 401 || r.status === 403) return { error: `jira ${r.status} unauthorized (token from ${ctx.tokenRef})` };
    if (r.status === 429) return { error: 'jira 429 rate limited' };
    if (!r.ok) {
      const errorMessages = (r.body && Array.isArray(r.body.errorMessages)) ? r.body.errorMessages : [];
      const msgs = errorMessages.join('; ');
      return { error: `jira ${r.status}${msgs ? `: ${msgs.slice(0, 160)}` : ''}`, status: r.status, errorMessages };
    }

    const body = r.body || {};
    const batch = Array.isArray(body.issues) ? body.issues : [];
    for (const i of batch) issues.push(i);

    const total = Number(body.total);
    startAt += batch.length;
    // Stop on an empty page as well as on the total — a server that keeps returning nothing while
    // claiming a larger total must not spin this loop to MAX_PAGES every scan.
    if (batch.length === 0) break;
    if (Number.isFinite(total) && startAt >= total) break;
  }

  return { issues };
}

// A key that git knows about but Jira does not (deleted issue, a typo in a branch name, an epic
// that was only ever planned) makes Jira reject the ENTIRE `key in (...)` clause with a 400 and
// name the offenders. Verified against a real Jira Data Center instance: two branch-derived keys,
// PROJ-75 and PROJ-76, are 404 there, and their presence took the whole of Q2 down.
//
// This is not a hypothetical: without this parse, Q2 fails permanently on the real repo set, and
// the Jira-Done drift direction — the entire reason Q2 exists — silently never fires again.
const MISSING_KEY_RE = /An issue with key '([^']+)' does not exist/g;

function missingKeysFromErrors(errorMessages) {
  const out = new Set();
  for (const m of (errorMessages || [])) {
    MISSING_KEY_RE.lastIndex = 0;
    let hit;
    while ((hit = MISSING_KEY_RE.exec(String(m))) !== null) out.add(hit[1]);
  }
  return Array.from(out);
}

// Runs a `key in (...)` query, dropping keys Jira says do not exist and retrying. Bounded: each
// round must remove at least one key, so it terminates.
async function searchKeysResilient(keys, ctx, warnings) {
  let remaining = keys.slice();
  for (let round = 0; round < 4 && remaining.length; round++) {
    const r = await searchAll(keysJql(remaining), ctx);
    if (!r.error) return { issues: r.issues };
    if (r.status !== 400) return { error: r.error };
    const missing = missingKeysFromErrors(r.errorMessages).filter((k) => remaining.indexOf(k) !== -1);
    if (missing.length === 0) return { error: r.error };
    warnings.push(`jira: ${missing.length} epic key${missing.length === 1 ? '' : 's'} referenced by git do not exist in Jira and were dropped from the status query: ${missing.join(', ')}`);
    remaining = remaining.filter((k) => missing.indexOf(k) === -1);
  }
  return { issues: [] };
}

// ---- mapping -------------------------------------------------------------------------------------------

function mapIssue(issue) {
  const f = issue.fields || {};
  const status = f.status || {};
  const cat = status.statusCategory || {};
  const key = typeof cat.key === 'string' ? cat.key.toLowerCase() : null;
  return {
    key: issue.key,
    project: (f.project && f.project.key) || (String(issue.key).split('-')[0] || null),
    // The display name is carried for RENDERING only. Nothing branches on it.
    status: typeof status.name === 'string' ? status.name : null,
    statusCategory: CATEGORIES.indexOf(key) === -1 ? null : key,
    summary: typeof f.summary === 'string' ? f.summary : null,
    updatedAt: typeof f.updated === 'string' ? new Date(f.updated).toISOString() : null,
    drift: null,
  };
}

// ---- drift ------------------------------------------------------------------------------------------------

// What git says about one epic, reduced to the three facts drift needs.
function gitSignalsFor(key, gitFragment) {
  const repos = (gitFragment && gitFragment.repos) || {};
  let branches = 0;
  let unpushed = 0;
  let unmerged = 0;
  let newestCommitAt = null;
  for (const id of Object.keys(repos)) {
    for (const b of (repos[id].branches || [])) {
      if (!b || b.isDefault || b.epic !== key) continue;
      branches++;
      unpushed += Number(b.unpushed) || 0;
      if (b.mergedIntoDevelop === false) unmerged++;
      if (b.lastCommitAt && (!newestCommitAt || Date.parse(b.lastCommitAt) > Date.parse(newestCommitAt))) newestCommitAt = b.lastCommitAt;
    }
  }
  return { branches, unpushed, unmerged, newestCommitAt };
}

// Both directions, per spec §M4. Returns null when there is nothing to say.
//
// Direction A is only observable because of Q2: a Done epic never appears in Q1's result set.
function detectDrift(epic, git, now) {
  const recent = git.newestCommitAt && (now - Date.parse(git.newestCommitAt)) <= RECENT_COMMIT_MS;

  if (epic.statusCategory === 'done') {
    const reasons = [];
    if (git.unpushed > 0) reasons.push(`${git.unpushed} unpushed commit${git.unpushed === 1 ? '' : 's'}`);
    if (git.unmerged > 0) reasons.push(`${git.unmerged} unmerged branch${git.unmerged === 1 ? '' : 'es'}`);
    if (recent) reasons.push('a commit in the last 14 days');
    if (reasons.length) {
      return {
        direction: 'jira-done-git-live',
        note: `Jira says ${epic.status || 'Done'} but git still shows ${reasons.join(' and ')}`,
        detectedAt: new Date(now).toISOString(),
      };
    }
    return null;
  }

  if (epic.statusCategory === 'indeterminate' && git.branches > 0 && git.newestCommitAt) {
    const idleMs = now - Date.parse(git.newestCommitAt);
    if (idleMs > GIT_QUIET_MS) {
      const days = Math.floor(idleMs / 86400000);
      return {
        direction: 'jira-inprogress-git-quiet',
        note: `Jira says ${epic.status || 'In Progress'} but no epic-branch commit for ${days} days`,
        detectedAt: new Date(now).toISOString(),
      };
    }
  }

  // An In-Progress epic with ZERO branches IS drift (changed 2026-07-31 — see derive.js's header).
  //
  // It used to be exempt, on the reasoning that ">30 days quiet" is unmeasurable without a git
  // clock and a freshly created epic is the common case. That reasoning held only while
  // `jira-in-progress` was an ACTIVITY signal, which is what put ten of these on the real board as
  // ACTIVE epics with no commits and no date. Jira is no longer an activity signal, so the honest
  // statement about such an epic is exactly this one: Jira asserts work is happening and git can
  // see none. No time threshold is applied — none is measurable, and none is needed to say that.
  if (epic.statusCategory === 'indeterminate' && git.branches === 0) {
    return {
      direction: 'jira-inprogress-no-git',
      note: `Jira says ${epic.status || 'In Progress'} but no branch anywhere carries this epic`,
      detectedAt: new Date(now).toISOString(),
    };
  }

  return null;
}

// ---- Agile intake (p11 S-003) ---------------------------------------------------------------------------------
//
// A SEPARATE SOURCE, AND THAT IS THE POINT. Q1/Q2 above answer "what does the tracker say about the
// epics git knows about" and feed drift detection. This section answers a different question — "what
// work exists on the boards at all" — and it talks to a DIFFERENT API family (/rest/agile/1.0)
// which a given instance or token may simply not expose.
//
// So its failures are reported on `sources.jiraAgile` and NEVER on `sources.jira`. Poisoning
// `sources.jira` when only the Agile half is down would make the existing p5 epic-drift detection
// read as failed while it is in fact working perfectly — a false red that costs exactly as much
// trust as a false green.
const AGILE_PAGE = 50;
const MAX_AGILE_PAGES = 20;

async function agileGet(pathAndQuery, ctx) {
  const r = await getJson(
    `${ctx.baseUrl}/rest/agile/1.0/${pathAndQuery}`,
    { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
    ctx.timeoutMs,
    ctx.fetchImpl,
  );
  if (r.kind === 'stale') return { error: `jira-agile: ${r.error}` };
  if (r.status === 401 || r.status === 403) return { error: `jira-agile ${r.status} unauthorized (token from ${ctx.tokenRef})` };
  if (r.status === 404) return { error: 'jira-agile 404 — the Agile API is not available on this instance' };
  if (r.status === 429) return { error: 'jira-agile 429 rate limited' };
  if (!r.ok) return { error: `jira-agile ${r.status}` };
  return { body: r.body || {} };
}

// Paged list helper. THE AGILE API HAS TWO ENVELOPES, NOT ONE, and assuming otherwise is a silent
// total loss rather than a partial one:
//
//   /board and /board/{id}/sprint   → { values: [...], isLast: bool }
//   /board/{id}/issue               → { issues: [...], total: n, startAt, maxResults }
//
// The issue endpoint never sends `values` and never sends `isLast` — live-probed against a Jira Data
// Center instance, whose 200 carried exactly expand,startAt,maxResults,total,issues,warningMessages,
// names,schema. Reading only `values` therefore intook ZERO issues on every scan while every call
// succeeded, which is the worst shape a bug can take: nothing to see in the status, nothing on the
// board.
//
// So the helper reads whichever envelope arrived, and returns the `total` the server claimed so the
// caller can check its rows against it — a count is the only thing that can catch this class again.
async function agileList(pathBase, ctx, cap) {
  const out = [];
  let startAt = 0;
  let total = null;
  for (let page = 0; page < MAX_AGILE_PAGES; page++) {
    const sep = pathBase.includes('?') ? '&' : '?';
    const r = await agileGet(`${pathBase}${sep}startAt=${startAt}&maxResults=${AGILE_PAGE}`, ctx);
    if (r.error) return { error: r.error, items: out, total };
    const rows = Array.isArray(r.body.values) ? r.body.values
      : Array.isArray(r.body.issues) ? r.body.issues
        : [];
    const t = Number(r.body.total);
    if (Number.isFinite(t)) total = t;
    for (const v of rows) {
      if (cap != null && out.length >= cap) return { items: out, total, truncated: true };
      out.push(v);
    }
    // Three stops, because the two envelopes end differently: `isLast` is the /board and /sprint
    // signal, `startAt >= total` is the issue endpoint's (it has no isLast at all), and an EMPTY
    // PAGE stops both — including a server that keeps claiming a total it never delivers, which
    // would otherwise spin this loop to MAX_AGILE_PAGES on every scan.
    if (rows.length === 0 || r.body.isLast === true) break;
    startAt += rows.length;
    if (Number.isFinite(t) && startAt >= t) break;
  }
  return { items: out, total };
}

// The board list, SCOPED BY THE SERVER whenever an allowlist exists.
//
// `/board` is INSTANCE-WIDE, and on Jira Data Center it answers without the `location` block that
// names a board's project — live-observed. Filtering that unscoped list client-side on
// `b.location.projectKey` therefore cannot work: the arm that has to let a location-less board
// through lets EVERY board through, and a two-project allowlist intook all 39 boards on the
// instance. Scope has to be ASKED OF THE SERVER, which is what `projectKeyOrId` is for; a field the
// response need not carry cannot be a filter.
async function agileBoards(cfg, ctx) {
  const projects = (cfg && Array.isArray(cfg.projects)) ? cfg.projects : [];
  // No allowlist means there is no scope to apply, and the whole instance is the honest answer.
  if (projects.length === 0) return agileList('board', ctx, null);

  const byId = new Map();
  const degraded = [];
  let firstError = null;
  for (const p of projects) {
    const r = await agileList(`board?projectKeyOrId=${encodeURIComponent(p)}`, ctx, null);
    // One project failing (an archived key, a permission gap) costs that project's boards and
    // nothing else — the same per-board degradation rule the sprint fetch below follows.
    if (r.error) {
      if (!firstError) firstError = r.error;
      degraded.push(`boards for project ${p} could not be listed (${r.error})`);
      continue;
    }
    // One board can serve several projects, so the union dedupes by id instead of concatenating —
    // otherwise a shared board is walked, and its issues intaken, once per project that shares it.
    for (const b of r.items) {
      const id = b && b.id != null ? String(b.id) : null;
      if (id && !byId.has(id)) byId.set(id, b);
    }
  }
  // EVERY project failing is not a partial loss, it is the board list being unavailable, and is
  // reported exactly as an unscoped `/board` failure is rather than as an empty instance.
  if (firstError && degraded.length === projects.length) return { error: firstError, items: [] };
  return { items: Array.from(byId.values()), degraded };
}

// An Agile issue → the raw shape workref.buildWorkRefs consumes. Status mapping is by CATEGORY
// only, exactly as mapIssue does for the JQL path — display names are not load-bearing anywhere.
function agileIssueToRaw(issue, board, sprint, baseUrl) {
  const f = (issue && issue.fields) || {};
  const st = f.status || {};
  const cat = (st.statusCategory && typeof st.statusCategory.key === 'string') ? st.statusCategory.key : null;
  const typeName = (f.issuetype && typeof f.issuetype.name === 'string') ? f.issuetype.name : '';
  const isEpic = typeName.toLowerCase() === 'epic';
  const key = String(issue.key || '');
  return {
    source: 'jira',
    sourceId: key,
    sourceUrl: baseUrl ? `${baseUrl}/browse/${key}` : null,
    kind: isEpic ? 'epic' : 'issue',
    title: typeof f.summary === 'string' ? f.summary : null,
    nativeStatus: typeof st.name === 'string' ? st.name : null,
    nativeCategory: CATEGORIES.includes(cat) ? cat : null,
    assignee: (f.assignee && typeof f.assignee.name === 'string') ? f.assignee.name : null,
    updatedAt: typeof f.updated === 'string' ? f.updated : null,
    description: typeof f.summary === 'string' ? f.summary : null,
    // An epic IS its own cluster; a story clusters under its epic when the instance exposes one.
    epicKey: isEpic ? (ISSUE_KEY_RE.test(key) ? key : null) : (typeof f.epic === 'object' && f.epic && ISSUE_KEY_RE.test(String(f.epic.key || '')) ? String(f.epic.key) : null),
    board: board ? { urn: `urn:work:jira-board:${board.id}`, name: board.name || null } : null,
    sprint: sprint ? { urn: `urn:work:jira-sprint:${sprint.id}`, name: sprint.name || null, endsAt: sprint.endDate || null } : null,
    connector: 'mod-jira',
  };
}

// Returns { items, source, pending }. Never throws; a failure anywhere degrades this source alone.
async function collectAgile(cfg, ctx, observedAt) {
  const agile = (cfg && cfg.agile) || { enabled: false, maxIssuesPerScan: 500 };
  if (!agile.enabled) return { items: [], source: { status: 'disabled' }, pending: 0 };

  const boardsR = await agileBoards(cfg, ctx);
  if (boardsR.error) return { items: [], source: { status: 'error', observedAt, error: boardsR.error }, pending: 0 };
  const scopedBoards = boardsR.items;

  const items = [];
  let pending = 0;
  // Reasons this scan is less than complete, merged into ONE `error` string at the end. The
  // published source object has a closed key set (state.schema.json), so a partial loss has to be
  // said in the status and the reason — there is no field to hide it in, and hiding it is the bug.
  const degraded = boardsR.degraded ? boardsR.degraded.slice() : [];

  for (const b of scopedBoards) {
    items.push({
      source: 'jira-board', sourceId: String(b.id), kind: 'board',
      title: typeof b.name === 'string' ? b.name : null, connector: 'mod-jira',
    });
  }

  const sprintByBoard = new Map();
  for (const b of scopedBoards) {
    const r = await agileList(`board/${encodeURIComponent(b.id)}/sprint?state=active,future`, ctx, null);
    // A board with no sprint support answers 400/404; that is a board-shape fact, not an outage, so
    // it degrades this board only and the rest of the scan continues.
    if (r.error) continue;
    sprintByBoard.set(String(b.id), r.items);
    for (const sp of r.items) {
      items.push({
        source: 'jira-sprint', sourceId: String(sp.id), kind: 'sprint',
        title: typeof sp.name === 'string' ? sp.name : null,
        due: typeof sp.endDate === 'string' ? sp.endDate : null,
        board: { urn: `urn:work:jira-board:${b.id}`, name: b.name || null },
        connector: 'mod-jira',
      });
    }
  }

  let budget = agile.maxIssuesPerScan;
  for (const b of scopedBoards) {
    if (budget <= 0) { pending += 1; continue; }
    const r = await agileList(`board/${encodeURIComponent(b.id)}/issue?fields=summary,status,issuetype,assignee,updated,epic`, ctx, budget);
    if (r.error) continue;
    // ROWS OBSERVED, NEVER CALLS THAT RETURNED 200. A server reporting work while this code extracts
    // none of it means the response was not read — the D1 envelope bug did exactly that on every
    // board — and the one thing that must not happen then is a plain `ok`. "The call succeeded" is
    // not "the rows arrived", and only counting the difference can tell them apart.
    if (Number.isFinite(r.total) && r.total > 0 && r.items.length === 0) {
      degraded.push(`board ${b.id} reports ${r.total} issue${r.total === 1 ? '' : 's'} but none could be read from the response`);
      continue;
    }
    const sprints = sprintByBoard.get(String(b.id)) || [];
    const activeSprint = sprints.find((s) => s && s.state === 'active') || null;
    for (const issue of r.items) {
      items.push(agileIssueToRaw(issue, b, activeSprint, ctx.baseUrl));
      budget -= 1;
    }
    // Truncation is REPORTED, never silent: a count that quietly stopped growing reads as "that is
    // all the work there is", which is the same false-green class as a swallowed error.
    if (r.truncated) pending += 1;
  }

  return {
    items,
    source: degraded.length
      ? { status: 'stale', observedAt, boards: scopedBoards.length, pending, error: `jira-agile: ${degraded.join('; ')}` }
      : { status: 'ok', observedAt, boards: scopedBoards.length, pending },
    pending,
  };
}

// ---- module entry -------------------------------------------------------------------------------------------

async function collectJira(opts) {
  const now = opts.now == null ? Date.now() : opts.now;
  const observedAt = new Date(now).toISOString();
  const configPath = opts.configPath || (opts.paths && opts.paths.config) || null;

  // Resolved before the config load so the file path and the token lookup below agree about which
  // environment they are reading. A collector that took its baseUrl from the ambient shell and its
  // token from an injected env would be reading two different worlds.
  const env = opts.env || process.env;
  const loaded = opts.jiraConfig !== undefined
    ? { cfg: opts.jiraConfig, error: null }
    : await loadJiraConfig(configPath, { env });

  if (loaded.error) return { fragment: null, source: { status: 'error', observedAt, error: loaded.error }, warnings: [loaded.error] };
  if (!loaded.cfg) return { fragment: { epics: {}, drift: [] }, source: { status: 'disabled' }, warnings: [] };

  const cfg = loaded.cfg;
  const token = env[cfg.tokenRef];
  if (!token) {
    const error = `env ${cfg.tokenRef} is unset`;
    return { fragment: null, source: { status: 'error', observedAt, error }, warnings: [error] };
  }

  const ctx = {
    baseUrl: cfg.baseUrl,
    token,
    tokenRef: cfg.tokenRef,
    timeoutMs: (opts.config && opts.config.timeouts && opts.config.timeouts.deployMs) || 15000,
    fetchImpl: opts.fetchImpl || null,
  };

  // Agile runs FIRST and independently, so the coupling is broken in BOTH directions: an Agile
  // outage must not touch `sources.jira` (Codex round 1, finding 10), and a Q1 failure — which
  // returns early below with a null fragment — must not silently take the board intake down with
  // it. Its result therefore travels on every return path out of this function.
  // The injected-config path (opts.jiraConfig, used by tests and by callers that build a config in
  // memory) can still carry `agile` on the object; the file path now delivers it alongside. Both
  // are normalized to the same shape here so collectAgile has exactly one contract to read.
  const agileCfg = opts.jiraConfig !== undefined
    ? normalizeAgile(opts.jiraConfig && opts.jiraConfig.agile)
    : (loaded.agile || normalizeAgile(undefined));
  const agile = await collectAgile(Object.assign({}, cfg, { agile: agileCfg }), ctx, observedAt);

  const warnings = [];
  const epics = {};

  const absorb = (issues, fromKeyQuery) => {
    for (const issue of issues) {
      if (!issue || typeof issue.key !== 'string') continue;
      const mapped = mapIssue(issue);
      if (mapped.statusCategory === null) warnings.push(`${mapped.key}: unrecognised statusCategory, treated as unknown`);
      // Q2 wins on conflict: it is the query that can see every status, including Done.
      if (!epics[mapped.key] || fromKeyQuery) epics[mapped.key] = mapped;
    }
  };

  // Q1 — open epics. THIS one failing takes the module down to a source error with a null fragment:
  // without the epic universe, a partial result is indistinguishable from "those epics were closed",
  // and publishing it would silently retire live work from the board.
  const q1 = await searchAll(openEpicsJql(cfg.projects), ctx);
  if (q1.error) return { fragment: null, agile, source: { status: 'error', observedAt, error: q1.error }, warnings: warnings.concat(q1.error) };
  absorb(q1.issues, false);

  // Q2 — the git-known keys, regardless of status. Skipped only when there is genuinely nothing to
  // ask about; an empty `key in ()` is invalid JQL and would 400 the scan.
  const known = knownEpicKeys(opts);
  let q2Failed = null;
  for (const part of chunk(known, KEY_CHUNK)) {
    const r = await searchKeysResilient(part, ctx, warnings);
    // Q2 failing is NOT fatal — Q1's answer is still true. But it is not silent either: the
    // Jira-Done drift direction is blind for this scan, so the source degrades to `stale` and says
    // exactly which capability was lost.
    if (r.error) { q2Failed = r.error; continue; }
    absorb(r.issues, true);
  }

  // ---- drift, both directions, onto the epic it describes.
  const gitFragment = (opts.fragments && opts.fragments.git) || { repos: {} };
  const drift = [];
  for (const key of Object.keys(epics)) {
    const d = detectDrift(epics[key], gitSignalsFor(key, gitFragment), now);
    if (!d) continue;
    epics[key].drift = d;
    drift.push(Object.assign({ epic: key }, d));
  }
  drift.sort((a, b) => (a.epic < b.epic ? -1 : a.epic > b.epic ? 1 : 0));

  const source = q2Failed
    ? { status: 'stale', observedAt, error: `known-epic status query failed (${q2Failed}) — Jira-Done drift is undetectable this scan` }
    : { status: 'ok', observedAt };
  if (q2Failed) warnings.push(source.error);

  return { fragment: { epics, drift }, agile, source, warnings };
}

module.exports = {
  collectJira,
  loadJiraConfig,
  normalizeAgile, collectAgile, agileIssueToRaw, agileList, agileBoards, agileGet,
  openEpicsJql,
  keysJql,
  knownEpicKeys,
  searchAll,
  searchKeysResilient,
  missingKeysFromErrors,
  mapIssue,
  detectDrift,
  gitSignalsFor,
  chunk,
  DEFAULT_BASE_URL, envBaseUrl, DEFAULT_PROJECTS, DEFAULT_TOKEN_REF, ISSUE_KEY_RE, PAGE_SIZE, CATEGORIES,
};
