#!/usr/bin/env bash
# p6 S-009 acceptance oracle — suppression and automatic return, proven on a REAL dispatch against
# a REAL board: the selected rows leave the published attention[] and the rendered board while the
# handoff holds their fact keys, zero-key rows never leave, no p5 count moves, index.json/locks.json
# are output not authority, and a TERMINAL transition driven through the server hands every
# still-true row back. Runs from a fresh checkout; exits 0 on pass.
#
# The board is BUILT (a pinned state.json cannot survive the boot scan — measured in S-008): one
# repo whose epic PROJ-909 owns every suppressible fact key on the board — a pushed-but-unmerged
# branch (the mergeable item), a dirty worktree and a merged/stale worktree — plus two blocked
# sessions from a synthetic event log and a decision through the shipped route, all of which
# contribute ZERO keys. There is deliberately no orphan branch: an orphan-key dispatch currently
# self-`resolved`s within a sweep (handoff.js::keyStillMinted reads orphan facts off the PUBLISHED,
# suppressed attention[] — reported as a defect); orphan-member suppression is derive-proven in
# test/radar-p6-server.test.js, whose TAP output ships as evidence.
#
# Thresholds: config.json commits sessionSweepSec=5, confirmMs=1000, goneGraceMs=2000. The
# abandoned bound below is goneGraceMs + 2 x sessionSweepSec = 12 s, padded to 30; every board
# propagation bound is the spec's 65 s (§11).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s009-suppression" "S-009"

fail() {
  echo "S-009 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  exit 1
}

p6_s009_cleanup() {
  [ -f "$TMP/radar/server.pid" ] && kill "$(cat "$TMP/radar/server.pid")" 2>/dev/null || true
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
trap p6_s009_cleanup EXIT

state() { curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state"; }

# ---- build the board --------------------------------------------------------------------------
FIXROOT="$TMP/p6fix"
mkdir -p "$FIXROOT"
FIXROOT="$(cd "$FIXROOT" && pwd -P)"
R="$FIXROOT/s009-repo"
G() { git -C "$R" -c user.name=fixture -c user.email=fixture@invalid "$@"; }

git init -q -b develop "$R"
echo base >"$R/base.txt"; G add base.txt; G commit -qm 'base'
git init -q --bare "$FIXROOT/s009-remote.git"
G remote add origin "$FIXROOT/s009-remote.git"
# pushed but NOT merged -> the mergeable epic, and the branch's unmerged-develop fact key
G checkout -qb feature/PROJ-909-a
echo a >"$R/a.txt"; G add a.txt; G commit -qm 'PROJ-909 work'
G push -q origin feature/PROJ-909-a
G checkout -q develop
G worktree add -q "$FIXROOT/wt-a" feature/PROJ-909-a
echo dirty >"$FIXROOT/wt-a/DIRTY.txt"                     # -> wt:...:dirty
# merged (and pushed) with a worktree -> the stale row; contributes only its wt:...:stale key
G checkout -qb feature/PROJ-909-done
echo done >"$R/done.txt"; G add done.txt; G commit -qm 'PROJ-909 done'
G push -q origin feature/PROJ-909-done
G checkout -q develop
G worktree add -q "$FIXROOT/wt-done" feature/PROJ-909-done
G merge -q --no-ff -m 'merge done' feature/PROJ-909-done
G push -q origin develop

# two blocked sessions (zero-key rows): one live deadline, one whose cache window already shut
mkdir -p "$RADAR_DIR/events"
export R
node -e '
  const fs = require("fs");
  const now = Date.now();
  const cwd = process.env.R;
  const lines = [
    { ts: now - 10 * 60000, sessionId: "s009-blocked", event: "UserPromptSubmit", cwd },
    { ts: now - 5 * 60000, sessionId: "s009-blocked", event: "Notification", notificationType: "permission_prompt", cwd },
    { ts: now - 120 * 60000, sessionId: "s009-stale", event: "UserPromptSubmit", cwd },
    { ts: now - 90 * 60000, sessionId: "s009-stale", event: "Notification", notificationType: "permission_prompt", cwd },
  ];
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(process.env.RADAR_DIR + "/events/" + day + ".ndjson", lines.map(JSON.stringify).join("\n") + "\n");
'

chmod +x "$RADAR_DIR/stand-in-claude"
export FIXROOT
node -e '
  const fs = require("fs");
  const f = process.env.RADAR_DIR + "/config.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.repos = [{ id: "s009-repo", path: process.env.R }];
  c.polyrepoRoot = process.env.FIXROOT;
  c.claudeBin = process.env.RADAR_DIR + "/stand-in-claude";
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
'
p6_restart_server || fail 'restart after the config rewrite'

curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"s009 zero-key decision"}' "$BASE/api/radar/decide" >/dev/null || fail 'POST /decide'
p6_wait_for 20 1 bash -c 'curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >/dev/null; curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{process.exit((JSON.parse(d).attention||[]).some((a)=>a.type===\"decision\")?0:1)})"' \
  || fail 'the decision row never reached the published board'

# ---- before: the resting truth ----------------------------------------------------------------
state >"$EVIDENCE/before.json" || fail 'GET state (before)'
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.env.EVIDENCE + "/before.json", "utf8"));
  const types = (s.attention || []).map((a) => a.type);
  for (const t of ["blocked", "blocked-stale", "decision", "mergeable"]) {
    if (!types.includes(t)) { console.error("missing " + t + "; attention: " + types.join(",")); process.exit(1); }
  }
  if (s.counts.mergeable !== 1) { console.error("counts.mergeable: " + s.counts.mergeable); process.exit(2); }
  if (s.counts.handoffsLive !== 0 || s.handoffs.length !== 0) { console.error("handoffs already live"); process.exit(3); }
  const wts = Object.values(s.repos).flatMap((r) => r.worktrees || []);
  if (!wts.some((w) => w.stale && w.cleanupCommand)) { console.error("no stale worktree"); process.exit(4); }
  if (!wts.some((w) => (w.dirty && (w.dirty.staged + w.dirty.unstaged + w.dirty.untracked) > 0))) { console.error("no dirty worktree"); process.exit(5); }
  if (!(s.epics || []).some((e) => e.key === "PROJ-909")) { console.error("no PROJ-909 epic"); process.exit(6); }
' || fail 'the built board is not the one this story needs'

# ---- dispatch: epic:PROJ-909 covers EVERY fact key any suppressible row contributes -----------
PV="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' -d '{"selectors":["epic:PROJ-909"]}' "$BASE/api/radar/handoff/preview")"
PID_P="$(echo "$PV" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(!b.plan){console.error(d);process.exit(1)}console.log(b.plan.previewId)})')" || fail "preview: $PV"
HASH_P="$(echo "$PV" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).hash))')"
CM="$(curl -s -XPOST -H "Authorization: Bearer $SERVER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"previewId\":\"$PID_P\",\"hash\":\"$HASH_P\",\"idempotencyKey\":\"s009-dispatch\"}" "$BASE/api/radar/handoff")"
echo "$CM" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>{const b=JSON.parse(d);if(b.status!=="unconfirmed")process.exit(1)})' \
  || fail "the dispatch did not answer 202 unconfirmed: $CM"
echo "$CM" >"$EVIDENCE/dispatch.json"
HID="$(echo "$CM" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).handoffId))')"
UUID="$(echo "$CM" | node -e 'let d="";process.stdin.on("data",(c)=>d+=c).on("end",()=>console.log(JSON.parse(d).sessionId))')"
export HID UUID

# ---- during: rows leave within 65 s; counts and zero-key rows do not move ---------------------
# An UNCONFIRMED handoff still suppresses: its process is alive, so its keys are kept (§4.3).
p6_wait_for 65 5 bash -c 'curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{const s=JSON.parse(d);process.exit(s.counts.handoffsLive===1&&!(s.attention||[]).some((a)=>a.type===\"mergeable\")?0:1)})"' \
  || fail 'the selected rows did not leave the published attention[] within 65 s'
state >"$EVIDENCE/during.json" || fail 'GET state (during)'
node -e '
  const fs = require("fs");
  const before = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/before.json", "utf8"));
  const during = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/during.json", "utf8"));
  const types = (during.attention || []).map((a) => a.type);
  if (types.includes("mergeable")) { console.error("mergeable still published"); process.exit(1); }
  // ZERO-KEY items are NEVER suppressed — the vacuous-`every` trap (§9 trap 20), live
  for (const t of ["blocked", "blocked-stale", "decision"]) {
    const b = before.attention.filter((a) => a.type === t).length;
    const d = during.attention.filter((a) => a.type === t).length;
    if (b !== d) { console.error(t + ": " + b + " before vs " + d + " during"); process.exit(2); }
  }
  // EVERY p5 count is untouched; handoffsLive is the one count p6 adds (§6.6, measured ordering)
  const bc = Object.assign({}, before.counts, { handoffsLive: 0 });
  const dc = Object.assign({}, during.counts, { handoffsLive: 0 });
  if (JSON.stringify(bc) !== JSON.stringify(dc)) { console.error("counts moved: " + JSON.stringify([before.counts, during.counts])); process.exit(3); }
  if (during.counts.mergeable !== 1) { console.error("counts.mergeable during: " + during.counts.mergeable); process.exit(4); }
  // the handoff is live-and-unconfirmed and its keys are held
  if (during.handoffs.length !== 1 || during.handoffs[0].status !== "unconfirmed") { console.error(JSON.stringify(during.handoffs)); process.exit(5); }
  if (!during.handoffs[0].factKeys.length) { console.error("no factKeys held"); process.exit(6); }
  const locks = JSON.parse(fs.readFileSync(process.env.RADAR_DIR + "/handoffs/locks.json", "utf8"));
  for (const k of during.handoffs[0].factKeys) {
    if (locks.locks[k] !== process.env.HID) { console.error("lock missing for " + k); process.exit(7); }
  }
  // snapshot DATA is intact under suppression: the epic and worktrees are still in repos/epics
  if (!(during.epics || []).some((e) => e.key === "PROJ-909")) { console.error("epics[] was hollowed out"); process.exit(8); }
' || fail 'the during-state is not the suppressed-but-intact board the spec requires'

# ---- index.json and locks.json are OUTPUT, not authority --------------------------------------
# Corrupt both to {}, rescan WITHOUT restarting: the published attention[] must be byte-identical,
# because suppression reads the server's in-memory ledger index, never the files (spec §3, §6.6).
cp "$RADAR_DIR/handoffs/index.json" "$EVIDENCE/index.pre-corruption.json"
printf '{}' >"$RADAR_DIR/handoffs/index.json"
printf '{}' >"$RADAR_DIR/handoffs/locks.json"
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >/dev/null || fail 'rescan after corruption'
state >"$EVIDENCE/during-corrupted.json" || fail 'GET state (corrupted)'
node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/during.json", "utf8"));
  const b = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/during-corrupted.json", "utf8"));
  if (JSON.stringify(a.attention) !== JSON.stringify(b.attention)) { console.error("attention changed after file corruption — something read the files back"); process.exit(1); }
  if (JSON.stringify(a.handoffs) !== JSON.stringify(b.handoffs)) { console.error("handoffs changed after file corruption"); process.exit(2); }
' || fail 'corrupting index.json/locks.json changed a published decision'

# ---- terminal transition, driven through the server: kill the dispatch set --------------------
for pid in $(p6_uuid_pids "$UUID"); do kill -9 "$pid" 2>/dev/null || true; done
p6_wait_for 10 1 bash -c '[ -z "$(p6_uuid_pids "$UUID")" ]' || fail 'the dispatch set would not die'
# abandoned lands at pidGoneSince + goneGraceMs, observed by a sweep: 2 s + 2 x 5 s, padded to 30
p6_wait_for 30 2 bash -c 'node -e "const L=require(\"fs\").readFileSync(process.env.RADAR_DIR+\"/handoffs/ledger.jsonl\",\"utf8\").trim().split(\"\n\").map(JSON.parse);const s=L.filter((r)=>r.t===\"status\"&&r.id===process.env.HID).pop();process.exit(s&&s.to===\"abandoned\"?0:1)"' \
  || fail 'the handoff never reached abandoned after the kill'

# ---- after: every still-true row returns within 65 s of the transition ------------------------
# The DEEP-EQUAL is the poll condition itself: successive publications can interleave (a sessions
# sweep and a forced scan), so a poll that only checks "mergeable is back" can hand the capture a
# snapshot from a different publication than the one it approved. Polling until the published
# attention[] equals the pre-dispatch board removes the race and keeps the 65 s bound honest.
p6_wait_for 65 5 bash -c 'curl -s -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>{const s=JSON.parse(d);const before=JSON.parse(require(\"fs\").readFileSync(process.env.EVIDENCE+\"/before.json\",\"utf8\"));process.exit(s.counts.handoffsLive===0&&JSON.stringify(s.attention)===JSON.stringify(before.attention)?0:1)})"' \
  || fail 'the published attention[] did not return to the pre-dispatch board within 65 s of the terminal transition'
state >"$EVIDENCE/after.json" || fail 'GET state (after)'
node -e '
  const fs = require("fs");
  const before = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/before.json", "utf8"));
  const after = JSON.parse(fs.readFileSync(process.env.EVIDENCE + "/after.json", "utf8"));
  // p6 adds NOTHING on a terminal transition: the published attention is deep-equal to the
  // pre-dispatch board — no attempt row, no chip, no badge, no count (§7.4)
  if (JSON.stringify(after.attention) !== JSON.stringify(before.attention)) {
    console.error("attention after != before"); process.exit(1);
  }
  if (after.handoffs.length !== 0 || after.handoffRecovery !== null) { console.error("handoff residue"); process.exit(2); }
  const locks = JSON.parse(fs.readFileSync(process.env.RADAR_DIR + "/handoffs/locks.json", "utf8"));
  if (Object.keys(locks.locks || {}).length !== 0) { console.error("keys still held: " + JSON.stringify(locks)); process.exit(3); }
' || fail 'the after-state is not the pre-dispatch board'

# ---- the rendered board across all three states -----------------------------------------------
node "$FIX/ui-proof-rows.js" "$EVIDENCE/before.json" "$EVIDENCE/during.json" "$EVIDENCE/after.json" >"$EVIDENCE/ui-rows.json" \
  || fail 'ui-proof-rows'

# ---- the derive-level suppression matrix (vacuous-every, counts ordering, orphan groups) ------
node --test test/radar-p6-server.test.js >"$EVIDENCE/unit-derive.tap" 2>&1 || fail 'test/radar-p6-server.test.js'

cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-009 PASS — evidence in $EVIDENCE"
