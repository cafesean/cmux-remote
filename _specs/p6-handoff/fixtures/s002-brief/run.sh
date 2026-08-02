#!/usr/bin/env bash
# p6 S-002 acceptance oracle — the REAL DATA bullet. Runs from a fresh checkout; exits 0 on pass.
#
# What this script proves that the unit suite cannot: the ORIGIN line flips from `origin unknown`
# to `last seen by session "<customTitle>" · <date>` when a REAL capture lands — and the capture is
# driven THROUGH THE SERVER SWEEP. There is no observation route and none may be added (spec §M1
# keeps Stop capture internal); writing observations.jsonl directly would violate the single-writer
# rule this harness exists to police. This script installs INPUTS only (a repo, an event log, a
# transcript file) and reads outputs.
#
# Runtime rewrites, each because a committed fixture cannot know the value: the repo path (a real
# git repo under $TMP so the scan derives real branch facts), the event cwd + transcriptPath, and
# the event ts (a wall-clock ts committed in the fixture would age out; it is re-timed so the Stop
# is already quiet at install).
#
# THRESHOLDS: config.json commits captureQuietMs=5000 and sessionSweepSec=5. §11 permits the
# shortening because the asserted bound is computed FROM those values below — never hard-coded.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s002-brief" "S-002"

fail() {
  echo "S-002 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  if ! /usr/bin/grep -q 'stop-capture' radar/collector.js 2>/dev/null; then
    echo 'NOTE: radar/collector.js never references stop-capture — the sweep wiring is absent, so' >&2
    echo 'no capture can ever land. Failing loudly instead of passing vacuously.' >&2
  fi
  exit 1
}

# --- a real repo whose branch name carries the pinned epic key ---------------------------------
# ISSUE_KEY_RE maps the branch to the epic, so the scan publishes the epic, its branch record, and
# the (repo, branch) pair the observation must join on. The EPIC file pins the key.
export EPIC_KEY="$(cat "$FIX/EPIC")"
[ -n "$EPIC_KEY" ] || fail 'EPIC file is empty'

REPO_DIR="$TMP/p6fix/s002-repo"
mkdir -p "$REPO_DIR"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
export REPO_DIR
git -C "$REPO_DIR" init -q -b "feature/${EPIC_KEY}-brief"
echo 's002 fixture' >"$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'

node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"s002-repo",path:process.env.REPO_DIR}];
fs.writeFileSync(f,JSON.stringify(c,null,2));'

# The asserted bound, computed from the shortened thresholds — the §11 rule. The Stop is installed
# already quiet, so one sweep suffices; two sweeps of margin cover a sweep that just started.
BOUND_S="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));
if(!Number.isFinite(c.captureQuietMs)||!Number.isFinite(c.sessionSweepSec))process.exit(1);
console.log(Math.ceil(c.captureQuietMs/1000)+2*c.sessionSweepSec);')"
echo "S-002: bound = captureQuietMs/1000 + 2*sessionSweepSec = ${BOUND_S}s"

# --- scan, then BEFORE: the event log is ABSENT, so the relation must be null ------------------
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan.json" \
  || fail 'POST /api/radar/scan failed'
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/state.json","utf8"));
if(!(st.epics||[]).some((e)=>e.key===process.env.EPIC_KEY))process.exit(1);' \
  || fail "the scan did not publish epic $EPIC_KEY — branch->epic mapping broken"

[ ! -e "$RADAR_DIR/events" ] || fail 'precondition: the event log must be ABSENT for the before run'
node radar/radar-cli.js brief "$EPIC_KEY" >"$EVIDENCE/before.txt" || fail 'brief (before) exited non-zero'
# Under set -e, /usr/bin/grep -c exits 1 on zero matches — counts are taken with `|| true` and
# compared explicitly (§11).
N=$(/usr/bin/grep -c 'origin unknown' "$EVIDENCE/before.txt" || true)
[ "$N" = "1" ] || fail "before.txt: expected exactly 1 'origin unknown' (the selected-epic count), got $N"
L=$(/usr/bin/grep -c 'last seen by session' "$EVIDENCE/before.txt" || true)
[ "$L" = "0" ] || fail "before.txt: 'last seen by session' must not appear before any capture, got $L"

# --- install the inputs: transcript (customTitle source) + re-timed event log ------------------
# The committed template pins the SHAPES and the SID; ts/cwd/transcriptPath are runtime values.
# The newest event is the SID's Stop, already captureQuietMs+2 s old, so the next sweep captures.
export SID='s002-session'
export TRANSCRIPT="$RADAR_DIR/s002-transcript.jsonl"    # committed file, already copied in
[ -f "$TRANSCRIPT" ] || fail 'committed transcript missing from the fixture copy'
node -e 'const fs=require("fs");
const tpl=fs.readFileSync(process.env.FIX+"/events-with-stop.ndjson","utf8").trim().split("\n").map(JSON.parse);
const c=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));
const base=Date.now()-c.captureQuietMs-2000;
tpl.forEach((e,i)=>{e.ts=base-(tpl.length-1-i)*1000;e.cwd=process.env.REPO_DIR;
  if(e.transcriptPath)e.transcriptPath=process.env.TRANSCRIPT;});
const last=tpl[tpl.length-1];
if(last.sessionId!==process.env.SID||last.event!=="Stop")process.exit(1);
fs.mkdirSync(process.env.RADAR_DIR+"/events",{recursive:true});
fs.writeFileSync(process.env.RADAR_DIR+"/events/"+new Date().toISOString().slice(0,10)+".ndjson",
  tpl.map((e)=>JSON.stringify(e)).join("\n")+"\n");' \
  || fail 'event template install failed (or the template does not end on the SID Stop)'

# --- wait for the SERVER sweep to capture ------------------------------------------------------
p6_wait_for "$BOUND_S" 1 node -e 'const fs=require("fs"),p=process.env.RADAR_DIR+"/observations.jsonl";
const l=fs.readFileSync(p,"utf8").trim().split("\n").map(JSON.parse).filter((x)=>x.sessionId===process.env.SID);
if(l.length!==1)process.exit(1);' \
  || fail "no observation line for $SID within ${BOUND_S}s"

# The captured line must be the real join inputs: exact repo id, exact branch, the transcript's
# LAST custom-title. Anything else and the after-brief would pass for the wrong reason.
node -e 'const fs=require("fs");
const l=fs.readFileSync(process.env.RADAR_DIR+"/observations.jsonl","utf8").trim().split("\n").map(JSON.parse)
  .filter((x)=>x.sessionId===process.env.SID);
const o=l[0];
if(o.repo!=="s002-repo"){console.error("repo: "+JSON.stringify(o.repo));process.exit(1);}
if(o.branch!=="feature/"+process.env.EPIC_KEY+"-brief"){console.error("branch: "+JSON.stringify(o.branch));process.exit(1);}
if(o.customTitle!=="s002-title"){console.error("customTitle: "+JSON.stringify(o.customTitle)+" — the LAST custom-title record must win");process.exit(1);}
fs.writeFileSync(process.env.EVIDENCE+"/observation.json",JSON.stringify(o,null,2)+"\n");' \
  || fail 'the observation line does not carry the exact (repo, branch, customTitle) the join needs'

# --- AFTER: the same brief now renders the relation, and `origin` vanishes entirely ------------
node radar/radar-cli.js brief "$EPIC_KEY" >"$EVIDENCE/after.txt" || fail 'brief (after) exited non-zero'
/usr/bin/grep -qF 'last seen by session "s002-title"' "$EVIDENCE/after.txt" \
  || fail 'after.txt does not carry the last-seen line with the captured title'
M=$(/usr/bin/grep -c 'origin unknown' "$EVIDENCE/after.txt" || true)
[ "$M" = "0" ] || fail "after.txt: expected zero 'origin unknown' lines, got $M"
# §6.5: the word `origin` may appear ONLY inside the literal `origin unknown` — resolved, none.
O=$(/usr/bin/grep -c 'origin' "$EVIDENCE/after.txt" || true)
[ "$O" = "0" ] || fail "after.txt: the word 'origin' appears outside the literal, $O line(s)"

cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-002 PASS — evidence in $EVIDENCE"
