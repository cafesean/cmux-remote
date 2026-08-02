#!/usr/bin/env bash
# p6 S-001 acceptance oracle — the REAL DATA bullet. Runs from a fresh checkout; exits 0 on pass.
#
# What this script proves that the unit suite cannot: the SERVER's own session sweep captures a
# settled Stop into observations.jsonl, and the line's repo/branch/headSha agree with the same
# fields served by GET /api/radar/state — one pipeline, two read paths, byte-agreeing. Every
# mutation happens inside the server (spec principle 8); this script only installs INPUTS (an
# event-log file, a config edit) and reads outputs.
#
# Three runtime rewrites, each because a committed fixture cannot know the value (the same reason
# _lib.sh rewrites serverBaseUrl to the ephemeral port):
#   * the repo path — a REAL git repo is created under $TMP so the scan derives real facts and the
#     cross-check compares real values, never null against null;
#   * the event cwd — it must point into that repo;
#   * the event ts — the committed events/2026-06-01.ndjson pins the SHAPES and the SID, but a
#     wall-clock ts inside events/ would age out of the 48 h retention window and rot the fixture.
#     The committed file is inert in the copied log (June is outside retention) and re-timed here
#     so the newest Stop is exactly captureQuietMs+2 s old at install.
#
# THRESHOLDS: config.json commits captureQuietMs=5000 and sessionSweepSec=5. §11 permits the
# shortening because the asserted bound is computed FROM those values below — never hard-coded.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s001-stopcapture" "S-001"
export FIX     # _lib sets it unexported; the node oracles below read process.env.FIX

fail() {
  echo "S-001 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  if ! /usr/bin/grep -q 'stop-capture' radar/collector.js 2>/dev/null; then
    echo 'NOTE: radar/collector.js never references stop-capture — the session-sweep wiring is' >&2
    echo 'not in place, so no capture can ever land. This oracle fails loudly instead of passing' >&2
    echo 'vacuously; wire sweepStopCapture into the sweep and re-run.' >&2
  fi
  exit 1
}

# --- a real repo for the scan to observe -------------------------------------------------------
# One branch, one commit, clean tree. The branch name and HEAD sha are the values the observation
# line must reproduce, so they are captured here and asserted at the end — non-vacuously.
REPO_DIR="$TMP/p6fix/app-api"
mkdir -p "$REPO_DIR"
# Canonicalize: macOS mktemp answers /var/... but git reports worktree paths under the /private/var
# realpath. The cwd in the events and the served worktree path must be the SAME string for the
# longest-prefix rule to fire, so everything downstream uses the realpath.
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
export REPO_DIR
git -C "$REPO_DIR" init -q -b feature/s001
echo 's001 fixture' >"$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
export HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"

# Point the copied config's repos at it (id stays app-api; the committed /tmp/p6fix placeholders
# are unknowable-path stand-ins, same category as the port).
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_DIR}];
fs.writeFileSync(f,JSON.stringify(c,null,2));'

# The asserted bound, computed from the shortened thresholds — the §11 rule.
BOUND_S="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));
if(!Number.isFinite(c.captureQuietMs)||!Number.isFinite(c.sessionSweepSec))process.exit(1);
console.log(Math.ceil((c.captureQuietMs+c.sessionSweepSec*1000)/1000));')"
echo "S-001: bound = captureQuietMs + sessionSweepSec = ${BOUND_S}s"

# --- full scan FIRST, so repo facts are published before any capture can fire ------------------
# The 60 s sweep carries git forward; only a full scan (re)reads config.repos. Events are
# installed strictly AFTER this succeeds, so the capture can never precede the snapshot it must
# agree with.
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan.json" \
  || fail 'POST /api/radar/scan failed'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-before.json" \
  || fail 'GET /api/radar/state failed after the scan'
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-before.json","utf8"));
const r=st.repos&&st.repos["app-api"];
if(!r||!Array.isArray(r.worktrees)||!r.worktrees.some((w)=>w.path.replace(/\/+$/,"")===process.env.REPO_DIR))process.exit(1);' \
  || fail 'the scan did not publish a worktree for the fixture repo — the cross-check would be vacuous'

# --- install the event log --------------------------------------------------------------------
# Committed shapes + SID, re-timed so the SID session's newest DECISIVE event is a Stop that is
# already quiet, and the decoy session ends in a UserPromptSubmit (must never capture). The SID
# Stop is FOLLOWED by a Notification{idle_prompt}, because that is what a real ended session's
# log looks like (the U5 measurement) — an idealised log without it is exactly how the
# trailing-notification cancellation defect stayed invisible. Order in the file is chronological;
# ts is assigned by that order, newest = now - captureQuietMs - 2 s.
export SID="$(cat "$FIX/EXPECTED_SID")"
node -e 'const fs=require("fs");
const tpl=fs.readFileSync(process.env.FIX+"/events/2026-06-01.ndjson","utf8").trim().split("\n").map(JSON.parse);
const c=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));
const base=Date.now()-c.captureQuietMs-2000;
tpl.forEach((e,i)=>{e.ts=base-(tpl.length-1-i)*1000;e.cwd=process.env.REPO_DIR;});
const dec=tpl.filter((e)=>e.event==="Stop"||e.event==="UserPromptSubmit").pop();
if(!dec||dec.sessionId!==process.env.SID||dec.event!=="Stop")process.exit(1);
fs.mkdirSync(process.env.RADAR_DIR+"/events",{recursive:true});
fs.writeFileSync(process.env.RADAR_DIR+"/events/"+new Date().toISOString().slice(0,10)+".ndjson",
  tpl.map((e)=>JSON.stringify(e)).join("\n")+"\n");' \
  || fail 'event template install failed (or the newest decisive event is not the pinned SID Stop)'

# --- wait for the server sweep to capture ------------------------------------------------------
# The story's node oracle, verbatim: exactly one observations.jsonl line for $SID, with a repo
# field present. Polled to the computed bound — a capture needing longer than the bound is a FAIL.
p6_wait_for "$BOUND_S" 1 node -e 'const fs=require("fs"),p=process.env.RADAR_DIR+"/observations.jsonl";const l=fs.readFileSync(p,"utf8").trim().split("\n").map(JSON.parse).filter(x=>x.sessionId===process.env.SID);if(l.length!==1)process.exit(1);if(l[0].repo===undefined)process.exit(2)' \
  || fail "no observation line for $SID within ${BOUND_S}s"

# --- cross-check against the served state ------------------------------------------------------
# THE point of this script: the line's repo/branch/headSha must equal what /api/radar/state says
# about the same cwd, resolved by the same longest-prefix rule — and non-vacuously (branch and
# sha are the real repo's, asserted against git rev-parse, never null-against-null).
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state.json" \
  || fail 'GET /api/radar/state failed for the cross-check'
node -e 'const fs=require("fs");
const lines=fs.readFileSync(process.env.RADAR_DIR+"/observations.jsonl","utf8").trim().split("\n").map(JSON.parse);
const mine=lines.filter((x)=>x.sessionId===process.env.SID);
if(mine.length!==1){console.error("expected exactly 1 line for SID, got "+mine.length);process.exit(1);}
if(lines.some((x)=>x.sessionId==="s001-decoy-session")){console.error("decoy session (newest event UserPromptSubmit) was captured");process.exit(1);}
const o=mine[0];
const st=JSON.parse(fs.readFileSync(process.env.EVIDENCE+"/state.json","utf8"));
const cwd=process.env.REPO_DIR;
if(o.repo!=="app-api"){console.error("repo: "+JSON.stringify(o.repo)+" !== app-api");process.exit(1);}
const r=st.repos&&st.repos[o.repo];
if(!r){console.error("served state has no repo "+o.repo);process.exit(1);}
let wt=null;
for(const w of r.worktrees||[]){const wp=w.path.replace(/\/+$/,"");
  if(cwd===wp||cwd.startsWith(wp+"/")){if(!wt||wp.length>wt.path.replace(/\/+$/,"").length)wt=w;}}
if(!wt){console.error("no served worktree covers "+cwd);process.exit(1);}
if(o.branch!==wt.branch){console.error("branch: "+JSON.stringify(o.branch)+" !== "+JSON.stringify(wt.branch));process.exit(1);}
if(o.headSha!==wt.head){console.error("headSha: "+JSON.stringify(o.headSha)+" !== "+JSON.stringify(wt.head));process.exit(1);}
if(o.branch!=="feature/s001"||o.headSha!==process.env.HEAD_SHA){console.error("values are not the real repo fields — vacuous agreement refused");process.exit(1);}
if(typeof o.stopTs!=="number"){console.error("stopTs is not a number");process.exit(1);}
fs.writeFileSync(process.env.EVIDENCE+"/observation.json",JSON.stringify(o,null,2)+"\n");
console.log("cross-check ok: "+o.repo+" "+o.branch+" "+o.headSha);' \
  || fail 'observation does not agree with /api/radar/state'

cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-001 PASS — evidence in $EVIDENCE"
