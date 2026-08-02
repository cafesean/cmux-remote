#!/usr/bin/env bash
# p6 S-008 acceptance oracle — select mode, the confirm sheet, the recovery element and the viewer
# affordance, proven with the REAL public/radar.js on a DOM stand-in (the repo is dependency-free;
# no jsdom, no Playwright) talking to a REAL harness server over the shipped routes and auth.
# Runs from a fresh checkout; exits 0 on pass.
#
# The board is BUILT, not pinned: the boot scan re-derives state.json from config.repos, so a
# pinned state.json cannot survive it (measured — the git module degrades without throwing, so the
# carry-forward never fires for a placeholder path). A real repo, a real spec vault and a real
# event log produce every row type this story needs; the deploy probe is the one row source that
# cannot be produced headlessly (it needs a network probe), so rule-violation's no-checkbox proof
# lives in test/radar-p6-ui.test.js against a pinned board, whose TAP output ships as evidence.
#
# Thresholds: config.json commits sessionSweepSec=5, confirmMs=1000, goneGraceMs=2000 — every
# timed bound below is expressed in those keys (spec §11).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s008-ui" "S-008"

fail() {
  echo "S-008 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  exit 1
}

# The _lib trap kills the main server and removes $TMP; this story also starts a VIEWER server and
# real dispatches (stand-in sleeps), so the trap is widened to cover both. Kill-by-$TMP-match works
# because every spawned command path lives under $TMP, and the matcher takes the needle from the
# ENVIRONMENT so it can never match itself.
p6_s008_cleanup() {
  [ -f "$TMP/radar/server.pid" ] && kill "$(cat "$TMP/radar/server.pid")" 2>/dev/null || true
  [ -f "$TMP/radar2/server.pid" ] && kill "$(cat "$TMP/radar2/server.pid")" 2>/dev/null || true
  P6_TMP="$TMP" node -e '
    const { execFileSync } = require("child_process");
    const out = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
    for (const l of out.split("\n")) {
      if (!l.includes(process.env.P6_TMP)) continue;
      const pid = parseInt(l.trim().split(/\s+/)[0], 10);
      if (Number.isFinite(pid) && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch (_) {} }
    }' 2>/dev/null || true
  rm -rf "$TMP"
}
trap p6_s008_cleanup EXIT

# ---- build the fixture board: one repo with every selectable row type -------------------------
FIXROOT="$TMP/p6fix"
mkdir -p "$FIXROOT"
FIXROOT="$(cd "$FIXROOT" && pwd -P)"
R="$FIXROOT/s008-repo"
G() { git -C "$R" -c user.name=fixture -c user.email=fixture@invalid "$@"; }

git init -q -b develop "$R"
echo base >"$R/base.txt"; G add base.txt; G commit -qm 'base'
git init -q --bare "$FIXROOT/s008-remote.git"
G remote add origin "$FIXROOT/s008-remote.git"
G push -q origin develop

# mergeable epic BETA-908: pushed (unpushed 0), not merged into develop
G checkout -qb feature/BETA-908-x
echo beta >"$R/beta.txt"; G add beta.txt; G commit -qm 'BETA-908 work'
G push -q origin feature/BETA-908-x
# epic PROJ-908: an unpushed branch with a DIRTY worktree
G checkout -q develop
G checkout -qb feature/PROJ-908-a
echo a >"$R/a.txt"; G add a.txt; G commit -qm 'PROJ-908 work'
G checkout -q develop
G worktree add -q "$FIXROOT/wt-a" feature/PROJ-908-a
echo dirty >"$FIXROOT/wt-a/DIRTY.txt"
# a MERGED branch with a worktree -> the stale row (staleReason merged, cleanupCommand rendered).
# mergedInto* compares against origin/develop, not the local branch (a missing remote ref is
# UNKNOWN, never unmerged) — so the merged develop must be PUSHED before the stale verdict can fire.
G checkout -qb feature/PROJ-908-done
echo done >"$R/done.txt"; G add done.txt; G commit -qm 'PROJ-908 done'
G push -q origin feature/PROJ-908-done
G checkout -q develop
G worktree add -q "$FIXROOT/wt-done" feature/PROJ-908-done
G merge -q --no-ff -m 'merge done' feature/PROJ-908-done
G push -q origin develop
# ... and only NOW a commit that stays local: develop ahead of origin -> the default-unpushed row
echo local >"$R/local.txt"; G add local.txt; G commit -qm 'local-only work on develop'
# two untagged branches -> the orphan-group
G branch -q stray-one
G branch -q stray-two

# spec vault: two unmapped p-folders -> spec-orphan-group (draft; no acceptance token anywhere)
mkdir -p "$FIXROOT/vault/projx/_specs/p9-alpha" "$FIXROOT/vault/projx/_specs/p9-beta"
printf '# p9 alpha\nstatus: draft\n' >"$FIXROOT/vault/projx/_specs/p9-alpha/specs.md"
printf '# p9 beta\nstatus: draft\n' >"$FIXROOT/vault/projx/_specs/p9-beta/specs.md"

# hook events: one BLOCKED session (deadline still open) and one BLOCKED-STALE (cache window shut).
# Synthetic event logs are permitted INPUTS (spec §11); observations/ledger are not touched.
mkdir -p "$RADAR_DIR/events"
export R
node -e '
  const fs = require("fs");
  const now = Date.now();
  const cwd = process.env.R;
  const lines = [
    { ts: now - 10 * 60000, sessionId: "s008-blocked", event: "UserPromptSubmit", cwd },
    { ts: now - 5 * 60000, sessionId: "s008-blocked", event: "Notification", notificationType: "permission_prompt", cwd },
    { ts: now - 120 * 60000, sessionId: "s008-stale", event: "UserPromptSubmit", cwd },
    { ts: now - 90 * 60000, sessionId: "s008-stale", event: "Notification", notificationType: "permission_prompt", cwd },
  ];
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(process.env.RADAR_DIR + "/events/" + day + ".ndjson", lines.map(JSON.stringify).join("\n") + "\n");
'

# ---- point the config at the real board, then RESTART -----------------------------------------
# The handoff module snapshots config once, at startup recovery — a rewrite without a restart
# leaves dispatch validating the committed placeholder paths (see _lib.sh :: p6_restart_server).
chmod +x "$RADAR_DIR/stand-in-claude"
export FIXROOT
node -e '
  const fs = require("fs");
  const f = process.env.RADAR_DIR + "/config.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.repos = [{ id: "s008-repo", path: process.env.R }];
  c.polyrepoRoot = process.env.FIXROOT;
  c.claudeBin = process.env.RADAR_DIR + "/stand-in-claude";
  c.specs = { root: process.env.FIXROOT + "/vault" };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
'
p6_restart_server || fail 'restart after the config rewrite'

# a real zero-key decision row, created through the shipped route
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"s008 zero-key decision"}' "$BASE/api/radar/decide" >/dev/null || fail 'POST /decide'
# force-scan until the decision is on the published board — a POST /scan COALESCES onto a scan
# already in flight (the restart's boot scan), which read decisions.json before the decide landed
p6_wait_for 20 1 bash -c 'curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >/dev/null; curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{process.exit((JSON.parse(d).attention||[]).some((a)=>a.type===\"decision\")?0:1)})"' \
  || fail 'the decision row never reached the published board'

# the board this story stands on, retained and asserted before any UI proof runs
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/board.json" || fail 'GET state'
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.env.EVIDENCE + "/board.json", "utf8"));
  const types = (s.attention || []).map((a) => a.type);
  for (const t of ["blocked", "blocked-stale", "decision", "mergeable", "default-unpushed", "orphan-group", "spec-orphan-group"]) {
    if (!types.includes(t)) { console.error("board is missing a " + t + " row; attention: " + types.join(",")); process.exit(1); }
  }
  const keys = (s.epics || []).map((e) => e.key).sort();
  if (!keys.includes("PROJ-908") || !keys.includes("BETA-908")) { console.error("epics: " + keys.join(",")); process.exit(1); }
  const wts = Object.values(s.repos).flatMap((r) => r.worktrees || []);
  if (!wts.some((w) => w.stale && w.cleanupCommand)) { console.error("no stale worktree row"); process.exit(1); }
  if (!wts.some((w) => w.dirty && (w.dirty.staged + w.dirty.unstaged + w.dirty.untracked) > 0)) { console.error("no dirty worktree"); process.exit(1); }
  if (s.role !== "leader") { console.error("role: " + s.role); process.exit(1); }
' || fail 'the built board does not carry every row type this story needs'

# ---- select mode + action bar + row->selector wire, on the mounted UI -------------------------
node "$FIX/ui-proof-board.js" >"$EVIDENCE/ui-board.json" || fail 'ui-proof-board'

# ---- the viewer: role overlay + per-route refusal + no select affordance ----------------------
V="$TMP/radar2"
mkdir -p "$V/events"
export V
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.V + "/config.json", JSON.stringify({
    configVersion: 1, role: "viewer", collectorId: "fixture-viewer",
    leaderBaseUrl: process.env.BASE, leaderTokenRef: "LEADER_TOK", repos: [],
  }, null, 2));
' || fail 'viewer config'
LEADER_TOK="$SERVER_TOKEN" RADAR_DIR="$V" RADAR_ENABLED=1 PORT=0 node server.js >"$V/server.log" 2>&1 &
echo $! >"$V/server.pid"
for i in $(seq 1 200); do
  VIEWER_BASE=$(/usr/bin/sed -nE 's#.*server on (http://[^ ]+) with.*#\1#p' "$V/server.log" || true)
  [ -n "${VIEWER_BASE:-}" ] && break
  sleep 0.1
done
[ -n "${VIEWER_BASE:-}" ] || fail 'viewer server never bound'
export VIEWER_BASE
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$VIEWER_BASE/api/radar/state" >/dev/null || fail 'viewer not ready'

# The leader/viewer role difference comes from the PROXY OVERLAY: same snapshot, one rewritten
# field. Fetched leader-viewer-leader so a sweep republishing mid-comparison is detected, not raced.
node -e '
  (async () => {
    const H = { authorization: "Bearer " + process.env.SERVER_TOKEN };
    for (let attempt = 0; attempt < 3; attempt++) {
      const l1 = await (await fetch(process.env.BASE + "/api/radar/state", { headers: H })).text();
      const v = await (await fetch(process.env.VIEWER_BASE + "/api/radar/state", { headers: H })).text();
      const l2 = await (await fetch(process.env.BASE + "/api/radar/state", { headers: H })).text();
      if (l1 !== l2) continue;                       // a sweep republished mid-read; retry
      const L = JSON.parse(l1), Vv = JSON.parse(v);
      if (L.role !== "leader") { console.error("leader publishes " + L.role); process.exit(1); }
      if (Vv.role !== "viewer") { console.error("viewer publishes " + Vv.role + " — the overlay is missing"); process.exit(1); }
      const patched = Object.assign({}, Vv, { role: "leader" });
      if (JSON.stringify(patched) !== l1) { console.error("the proxy rewrote more than role"); process.exit(2); }
      require("fs").writeFileSync(process.env.EVIDENCE + "/role-overlay.json",
        JSON.stringify({ leaderRole: L.role, viewerRole: Vv.role, everyOtherFieldIdentical: true }, null, 2));
      process.exit(0);
    }
    console.error("leader snapshot never stable across two reads");
    process.exit(3);
  })();
' || fail 'the role overlay'

for route in "POST /api/radar/handoff/preview" "POST /api/radar/handoff" "POST /api/radar/recovery/adopt" "POST /api/radar/recovery/discard" "GET /api/radar/handoff/h-x"; do
  method="${route%% *}"; p="${route#* }"
  if [ "$method" = "POST" ]; then
    out="$(curl -s -X "$method" -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d '{}' "$VIEWER_BASE$p")"
  else
    out="$(curl -s -X "$method" -H "Authorization: Bearer $SERVER_TOKEN" "$VIEWER_BASE$p")"
  fi
  echo "$out" | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
      const b = JSON.parse(d);
      if (b.error !== "viewer_readonly" || b.leaderBaseUrl !== process.env.BASE || !b.message) process.exit(1);
    });' || fail "viewer route $route did not answer viewer_readonly {leaderBaseUrl}: $out"
done

node "$FIX/ui-proof-viewer.js" >"$EVIDENCE/ui-viewer.json" || fail 'ui-proof-viewer'

# ---- the sheet: preview -> ready -> edit/blur re-preview -> confirm -> a real 202 -------------
node "$FIX/ui-proof-live.js" >"$EVIDENCE/ui-live.json" || fail 'ui-proof-live'

# ledger truth for the sheet dispatch, plus the same-key replay on the wire
COMMIT_BODY="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/ui-live.json","utf8")).commitBody))')"
export COMMIT_BODY
node -e '
  const L = require("fs").readFileSync(process.env.RADAR_DIR + "/handoffs/ledger.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const body = JSON.parse(process.env.COMMIT_BODY);
  const intent = L.find((r) => r.t === "intent" && r.plan && r.plan.previewId === body.previewId);
  if (!intent) { console.error("no intent for the sheet previewId"); process.exit(1); }
  const seq = L.filter((r) => r.id === intent.id || r.idempotencyKey === body.idempotencyKey).map((r) => r.t);
  const want = ["claim", "intent", "process", "status", "result"];
  for (let i = 0; i < want.length; i++) if (seq[i] !== want[i]) { console.error("write order: " + seq.join(",")); process.exit(2); }
  const st = L.filter((r) => r.t === "status" && r.id === intent.id).pop();
  if (!st || st.to !== "unconfirmed") { console.error("sheet dispatch status: " + (st && st.to)); process.exit(3); }
' || fail 'the sheet dispatch did not land claim->intent->process->status(unconfirmed)->result'

R1="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d "$COMMIT_BODY" "$BASE/api/radar/handoff")"
R2="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d "$COMMIT_BODY" "$BASE/api/radar/handoff")"
[ "$R1" = "$R2" ] || fail 'a same-key replay must return the stored envelope byte-for-byte'
echo "$R1" >"$EVIDENCE/replay.json"

# the settled failure class exists on the wire: a misfit request is a terminal 409, never a retry loop
PV="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d '{"selectors":["branch:s008-repo:develop"]}' "$BASE/api/radar/handoff/preview")"
PID_A="$(echo "$PV" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(!b.plan){console.error(d);process.exit(1)}console.log(b.plan.previewId)})')" || fail "preview for the settled-class probe: $PV"
HM="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"previewId\":\"$PID_A\",\"hash\":\"$(printf 'f%.0s' $(seq 1 64))\",\"idempotencyKey\":\"s008-hash-probe\"}" "$BASE/api/radar/handoff")"
echo "$HM" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(b.error!=="hash_mismatch"||!b.message)process.exit(1)})' \
  || fail "a wrong hash is 409 hash_mismatch, the settled class the sheet re-previews on: $HM"
echo "$HM" >"$EVIDENCE/settled-class.json"

# The remaining sheet exits — transport retry with the SAME key, 409 in_flight, a stored 5xx —
# cannot be produced by a healthy server on demand; they are DOM-proven against scripted responses
# in test/radar-p6-ui.test.js, whose TAP output ships as evidence below.

# ---- the recovery element: ONE undecidable, then FOUR, then one press -------------------------
dispatch() { # <selector> <key>
  local pv pid hash
  pv="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d "{\"selectors\":[\"$1\"]}" "$BASE/api/radar/handoff/preview")"
  pid="$(echo "$pv" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(!b.plan){console.error(d);process.exit(1)}console.log(b.plan.previewId)})')" || return 1
  hash="$(echo "$pv" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).hash))')"
  curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"previewId\":\"$pid\",\"hash\":\"$hash\",\"idempotencyKey\":\"$2\"}" "$BASE/api/radar/handoff" \
    | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(b.status!=="unconfirmed"){console.error(d);process.exit(1)}})'
}
# The token is computable — sha256(canon(sorted ids)) over the ledger's intent ids (spec §M4/§6.4)
# — so every wait below is deterministic, never a sleep against a guessed set.
expected_token() { # <expected intent count>
  P6_WANT="$1" node -e '
    const { canon, sha256 } = require("./radar/handoff-keys");
    const L = require("fs").readFileSync(process.env.RADAR_DIR + "/handoffs/ledger.jsonl", "utf8").trim().split("\n").map(JSON.parse);
    const ids = L.filter((r) => r.t === "intent").map((r) => r.id).sort();
    if (ids.length !== Number(process.env.P6_WANT)) { console.error("expected " + process.env.P6_WANT + " intents, found " + ids.length); process.exit(1); }
    console.log(sha256(canon(ids)));
  '
}
wait_for_token() { # <token> <what>
  EXPECTED_TOKEN="$1" p6_wait_for 30 1 bash -c 'curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{const r=JSON.parse(d).handoffRecovery;process.exit(r&&r.token===process.env.EXPECTED_TOKEN?0:1)})"' \
    || fail "handoffRecovery never covered $2"
}

# The sheet's 202 dispatch is the only unconfirmed handoff so far, so the ONE-member state is
# deterministic: wait for its singleton token (bound = goneGraceMs + 2 x sessionSweepSec, padded).
T1="$(expected_token 1)" || fail 'computing the singleton token'
wait_for_token "$T1" 'the single undecidable handoff'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/recovery-one.json"

# Grow the set. BRANCH selectors only: an orphan-key dispatch currently self-`resolved`s within one
# sweep — handoff.js::keyStillMinted maps orphan keys back through keysForSelector, which reads the
# PUBLISHED attention[], and §6.6 suppression has just removed that very item, so the fact reads
# absent and the keys release while the worker is alive. Reported as a defect (the orphan fact is
# derivable from state.repos, which suppression deliberately leaves intact); branch keys evaluate
# against repos and are immune, so this proof stands on them.
dispatch "branch:s008-repo:stray-one" "s008-rec-1" || fail 'recovery dispatch 1'
dispatch "branch:s008-repo:stray-two" "s008-rec-2" || fail 'recovery dispatch 2'
dispatch "branch:s008-repo:feature/PROJ-908-a" "s008-rec-3" || fail 'recovery dispatch 3'

T4="$(expected_token 4)" || fail 'computing the full-set token'
wait_for_token "$T4" 'the whole undecidable set'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/recovery-many.json"

# ONE element, byte-identical text at any set size, and one live adopt press that empties it
node "$FIX/ui-proof-recovery.js" "$EVIDENCE/recovery-one.json" "$EVIDENCE/recovery-many.json" press >"$EVIDENCE/ui-recovery.json" \
  || fail 'ui-proof-recovery'

# server truth after the press: the element is gone, every member was adopted, and it STAYS gone —
# no serialised follow-up for the other members, ever (two full sweeps of silence prove it)
p6_wait_for 20 1 bash -c 'curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{process.exit(JSON.parse(d).handoffRecovery===null?0:1)})"' \
  || fail 'handoffRecovery did not clear after the adopt press'
node -e '
  const L = require("fs").readFileSync(process.env.RADAR_DIR + "/handoffs/ledger.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const ops = L.filter((r) => r.t === "recovery-op");
  if (ops.length !== 1 || ops[0].op !== "adopt" || ops[0].ids.length !== 4) { console.error("recovery-op: " + JSON.stringify(ops)); process.exit(1); }
  const adopted = L.filter((r) => r.t === "status" && r.to === "active" && r.reason === "adopted_operator");
  if (adopted.length !== 4) { console.error("adopted_operator count: " + adopted.length); process.exit(2); }
' || fail 'one press did not adopt the whole set atomically'
sleep 11   # two full sweeps (sessionSweepSec=5)
curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" \
  | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{process.exit(JSON.parse(d).handoffRecovery===null?0:1)})' \
  || fail 'the element came back — a serialised backlog through the failure path'

# ---- the DOM-level state-machine matrix (failure/retry classes a healthy server cannot mint) ---
node --test test/radar-p6-ui.test.js >"$EVIDENCE/unit-ui.tap" 2>&1 || fail 'test/radar-p6-ui.test.js'

# ---- teardown: kill every dispatch set and prove absence --------------------------------------
node -e '
  const L = require("fs").readFileSync(process.env.RADAR_DIR + "/handoffs/ledger.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  for (const r of L) if (r.t === "intent") console.log(r.plan.sessionUuid);
' | while read -r uuid; do
  for pid in $(p6_uuid_pids "$uuid"); do kill -9 "$pid" 2>/dev/null || true; done
done
cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-008 PASS — evidence in $EVIDENCE"
