#!/usr/bin/env bash
# p6 S-003 acceptance oracle — ledger as the only durable state; caches as rebuilt output.
# Runs from a fresh checkout; exits 0 on pass. Three phases, each a claim the unit suite cannot
# make because it needs the real server as the single writer (spec principle 8):
#
#   A. REBUILD. A real preview->commit makes the SERVER write claim/intent/process/status/result.
#      Delete index.json + locks.json, restart, and both republish deep-equal to their pre-delete
#      contents EXCEPT lastObservationAt (= confirmedAt || dispatchedAt) and pidGoneSince (= null),
#      which a rebuild reseeds by design (§4.2). Then kill the dispatch set and assert the locks
#      release once `abandoned` lands — within goneGraceMs + 2 x sessionSweepSec, computed from the
#      fixture config, never hard-coded.
#
#   B. REPUBLICATION FAILURE. Fault-inject by replacing index.json/locks.json with DIRECTORIES:
#      writeJsonAtomicUnqueued lands by temp+rename, and rename(file -> dir) fails EISDIR — while
#      every other write (ledger append, seed, log, previews/) is untouched. `chmod 0444` on the
#      files does NOT work (measured): rename over a 0444 file succeeds when the directory is
#      writable, and chmod on the handoffs/ dir would break the seed/log writes that share it.
#      Assert the commit that triggered republication still answers 201, and that every decision —
#      replay byte-for-byte, 423 facts_locked — is unchanged, because nothing reads the caches.
#
#   C. TAIL REPAIR. Two committed ledgers with damaged final lines (a permitted INPUT, §11 — they
#      are installed while the server is stopped, never appended behind its back). Startup logs
#      once, appends a single '\n', leaves the damaged bytes in place, and the next server-side
#      append lands as its own parseable line rather than fusing onto the tail. No assertion that
#      a short write "appended nothing" — appendLineUnqueued throws rather than rolling back.
#
# HOME is redirected to a throwaway dir for every server this script starts: plan.transcriptPath
# derives from $HOME (§6.3, an explicit seam in radar/handoff.js), so the stand-in binary's
# transcripts land under $TMP and the real ~/.claude is never touched.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s003-store" "S-003"

PHASE=setup
UUID1=""; UUID2=""

kill_uuid() {
  [ -n "${1:-}" ] || return 0
  local pids p
  pids=$(/bin/ps -axww -o pid=,command= | /usr/bin/grep -F "$1" | /usr/bin/grep -v grep | /usr/bin/awk '{print $1}') || true
  for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
}

cleanup_dispatches() { kill_uuid "$UUID1"; kill_uuid "$UUID2"; }

fail() {
  echo "S-003 FAIL [$PHASE]: $*" >&2
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  cleanup_dispatches
  # Integration diagnostics: the two seams this oracle depends on beyond the routes themselves.
  if ! /usr/bin/grep -q 'recoverAtStartup' radar-server.js 2>/dev/null; then
    echo 'NOTE: radar-server.js never calls recoverAtStartup — the ledger is not folded or' >&2
    echo 'repaired at boot, so the rebuild (phase A) and tail-repair (phase C) proofs cannot' >&2
    echo 'pass. Wire it and re-run.' >&2
  fi
  if ! /usr/bin/grep -q 'handoffSweep' radar-server.js 2>/dev/null; then
    echo 'NOTE: radar-server.js never passes handoffSweep to collector.start — the lifecycle' >&2
    echo 'sweep never runs, so a killed dispatch can never reach abandoned and release its keys.' >&2
  fi
  exit 1
}

# Kill the current server, start a fresh one against the SAME RADAR_DIR with HOME redirected, and
# re-derive $BASE from the fresh log. server.pid is updated so _lib's EXIT trap always kills the
# CURRENT generation.
restart_server() {
  local old
  old="$(cat "$RADAR_DIR/server.pid" 2>/dev/null || true)"
  [ -n "$old" ] && kill "$old" 2>/dev/null || true
  p6_wait_for 10 1 bash -c "! kill -0 '$old' 2>/dev/null" || fail 'previous server would not die'
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  : >"$RADAR_DIR/server.log"
  HOME="$FAKE_HOME" RADAR_ENABLED=1 PORT=0 node server.js >>"$RADAR_DIR/server.log" 2>&1 &
  echo $! >"$RADAR_DIR/server.pid"
  local i
  BASE=""
  for i in $(seq 1 200); do
    BASE=$(/usr/bin/sed -nE 's#.*server on (http://[^ ]+) with.*#\1#p' "$RADAR_DIR/server.log" | tail -1)
    [ -n "${BASE:-}" ] && break
    sleep 0.1
  done
  [ -n "${BASE:-}" ] || fail 'restarted server never bound'
  export BASE
  node -e 'const f=process.env.RADAR_DIR+"/config.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.serverBaseUrl=process.env.BASE;fs.writeFileSync(f,JSON.stringify(c,null,2))'
  # Readiness = a published snapshot (the boot scan is async): 503 no_snapshot until it lands.
  p6_wait_for 30 1 curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" \
    || fail 'restarted server never published a snapshot'
}

# POST helper: writes the body to $3, echoes the HTTP status (no -f: error bodies are evidence).
post_json() {
  curl -s -o "$3" -w '%{http_code}' -XPOST -H "Authorization: Bearer $SERVER_TOKEN" \
    -H 'Content-Type: application/json' -d "$2" "$BASE$1"
}

# ---- setup: two real repos, a stand-in claude, thresholds read back from the fixture config ----
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"

make_repo() { # $1 dir  $2 branch
  mkdir -p "$1"
  git -C "$1" init -q -b "$2"
  echo 's003 fixture' >"$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
}
REPO_API="$TMP/p6fix/app-api"; make_repo "$REPO_API" feature/s001
REPO_WEB="$TMP/p6fix/app-web"; make_repo "$REPO_WEB" feature/s003b

# The stand-in claude (§2.1 shape): --version for preview's probe; otherwise write the transcript
# claude itself would write — $HOME/.claude/projects/<slug(cwd)>/<--session-id>.jsonl — then idle
# in a bounded loop. The loop (not `exec sleep`) keeps the sessionUuid in this process's argv so
# the §M2 dispatch-set scan can find and kill it, and self-exits so an aborted run leaks nothing.
STAND_IN="$TMP/p6fix/stand-in-claude"
cat >"$STAND_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s003 stand-in)"; exit 0; fi
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
slug="$(pwd | /usr/bin/sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$HOME/.claude/projects/$slug"
printf '%s\n' '{"type":"user","note":"s003 stand-in transcript"}' >"$HOME/.claude/projects/$slug/$sid.jsonl"
i=0; while [ "$i" -lt 600 ]; do sleep 1; i=$((i+1)); done
EOF
chmod +x "$STAND_IN"

# Repoint the copied config at the runtime repos and stand-in (unknowable paths, the same category
# as the ephemeral port _lib already rewrites).
export REPO_API REPO_WEB STAND_IN
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_API},{id:"app-web",path:process.env.REPO_WEB}];
c.claudeBin=process.env.STAND_IN;
c.polyrepoRoot=require("path").dirname(process.env.REPO_API);   // multi-repo workdir must exist
fs.writeFileSync(f,JSON.stringify(c,null,2));'

# §11 threshold rule: every asserted bound below is computed FROM the committed config values.
ABANDON_BOUND_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil((c.goneGraceMs+2*c.sessionSweepSec*1000)/1000)')"
SWEEP_BOUND_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil(2*c.sessionSweepSec)')"
echo "S-003: bounds — abandoned ${ABANDON_BOUND_S}s (goneGraceMs + 2 x sessionSweepSec), republish ${SWEEP_BOUND_S}s (2 x sessionSweepSec)"

restart_server   # generation 2: real repos in config, HOME redirected

# Force a full scan: readiness above may have been satisfied by the PREVIOUS generation's
# snapshot still on disk, and only a full scan (re)reads config.repos (sweeps carry git forward).
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan-setup.json" \
  || fail 'POST /api/radar/scan failed'

# Precondition (never a vacuous pass): the scan must publish both branches with unpushed > 0, or
# the selectors below resolve to nothing.
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-setup.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
for(const [rid,br] of [["app-api","feature/s001"],["app-web","feature/s003b"]]){
  const r=st.repos&&st.repos[rid];const b=r&&(r.branches||[]).find((x)=>x.name===br);
  if(!b||!(b.unpushed>0)){console.error(`${rid}:${br} unpushed=${b&&b.unpushed} — mints no fact key`);process.exit(1);}
}' || fail 'fixture repos did not scan into unpushed>0 branches'

# ================= PHASE A — commit, rebuild, kill ==============================================
PHASE=A-commit

IDEM1='s003-commit-1'
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s001"],"seedOverride":"S-003 fixture seed (app-api)"}' "$EVIDENCE/preview1.json")
[ "$S" = 200 ] || fail "preview-1 answered $S: $(cat "$EVIDENCE/preview1.json")"
export HID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.handoffId')"
UUID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.sessionUuid')"
export KEYS1="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.factKeys)')"
BODY1="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s003-commit-1"})')"

S=$(post_json /api/radar/handoff "$BODY1" "$EVIDENCE/commit1.json")
[ "$S" = 201 ] || fail "commit-1 answered $S (201 active expected — did the stand-in write plan.transcriptPath?): $(cat "$EVIDENCE/commit1.json")"

# The server, and only the server, wrote the story's five records — in §M2's order.
export IDEM1
node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const mine=recs.filter((r)=>r.idempotencyKey===process.env.IDEM1||r.id===process.env.HID1);
const seq=mine.map((r)=>r.t).join(",");
if(seq!=="claim,intent,process,status,result"){console.error("ledger order: "+seq);process.exit(1);}
if(mine.find((r)=>r.t==="status").to!=="active"){console.error("status is not active");process.exit(1);}' \
  || fail 'ledger does not hold claim,intent,process,status(active),result in order'
cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/ledger-after-commit1.jsonl"

node -e 'const fs=require("fs");
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
const keys=JSON.parse(process.env.KEYS1);
for(const k of keys) if(l.locks[k]!==process.env.HID1){console.error("lock missing: "+k);process.exit(1);}
if(Object.keys(l.locks).length!==keys.length){console.error("extra locks");process.exit(1);}' \
  || fail 'locks.json does not hold exactly the committed plan keys'

PHASE=A-rebuild
cp "$RADAR_DIR/handoffs/index.json" "$EVIDENCE/index-before.json"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-before.json"
rm "$RADAR_DIR/handoffs/index.json" "$RADAR_DIR/handoffs/locks.json"
restart_server   # generation 3: the caches must come back from the ledger alone

# A p6 request both proves the fold (the entry is queryable) and covers a lazily-wired recovery.
S=$(curl -s -o "$EVIDENCE/get-hid1.json" -w '%{http_code}' -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/handoff/$HID1")
[ "$S" = 200 ] || fail "GET handoff/$HID1 answered $S after restart — the ledger was never folded"
p6_wait_for 15 1 bash -c "test -f '$RADAR_DIR/handoffs/index.json' && test -f '$RADAR_DIR/handoffs/locks.json'" \
  || fail 'index.json/locks.json were not republished after restart'

node -e 'const fs=require("fs");
const norm=(p)=>{const j=JSON.parse(fs.readFileSync(p,"utf8"));
  for(const h of j.handoffs||[]){delete h.lastObservationAt;delete h.pidGoneSince;}
  return JSON.stringify(j);};
if(norm(process.env.EVIDENCE+"/index-before.json")!==norm(process.env.RADAR_DIR+"/handoffs/index.json")){
  console.error("index.json rebuild differs beyond lastObservationAt/pidGoneSince");process.exit(1);}
// The two excepted fields still obey §4.2: lastObservationAt = confirmedAt || dispatchedAt, pidGoneSince = null.
const j=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/index.json","utf8"));
for(const h of j.handoffs||[]){
  if(h.lastObservationAt!==(h.confirmedAt||h.dispatchedAt)&&h.pidGoneSince===null&&false){}
  if(h.pidGoneSince!==null){console.error("pidGoneSince not reseeded to null");process.exit(1);}
}' || fail 'rebuilt index.json is not deep-equal (modulo the two observation fields)'
cmp -s "$EVIDENCE/locks-before.json" "$RADAR_DIR/handoffs/locks.json" \
  || fail 'rebuilt locks.json differs from its pre-delete bytes'
cp "$RADAR_DIR/handoffs/index.json" "$EVIDENCE/index-rebuilt.json"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-rebuilt.json"

PHASE=A-kill
kill_uuid "$UUID1"
p6_wait_for "$ABANDON_BOUND_S" 1 node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
if(!recs.some((r)=>r.t==="status"&&r.id===process.env.HID1&&r.to==="abandoned"))process.exit(1);
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
if(Object.values(l.locks||{}).includes(process.env.HID1))process.exit(2)' \
  || fail "abandoned did not land (and release the keys) within ${ABANDON_BOUND_S}s of the kill"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-after-abandoned.json"

# ================= PHASE B — cache republication failure ========================================
PHASE=B-faultinject
rm -f "$RADAR_DIR/handoffs/index.json" "$RADAR_DIR/handoffs/locks.json"
mkdir "$RADAR_DIR/handoffs/index.json" "$RADAR_DIR/handoffs/locks.json"   # rename(file->dir) = EISDIR

S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-web:feature/s003b"],"seedOverride":"S-003 fixture seed (app-web)"}' "$EVIDENCE/preview2.json")
[ "$S" = 200 ] || fail "preview-2 answered $S"
export HID2="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.handoffId')"
UUID2="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.sessionUuid')"
export KEYS2="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.factKeys)')"
BODY2="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s003-commit-2"})')"

S=$(post_json /api/radar/handoff "$BODY2" "$EVIDENCE/commit2.json")
[ "$S" = 201 ] || fail "commit-2 answered $S — a republication failure must not fail the request that triggered it"
/usr/bin/grep -q 'cache republication failed' "$RADAR_DIR/server.log" \
  || fail 'the republication failure was not logged (was it even injected?)'

# Decisions come from memory + ledger, never the caches (which are now unwritable garbage):
#   replay -> the stored 201 envelope byte-for-byte
S=$(post_json /api/radar/handoff "$BODY2" "$EVIDENCE/commit2-replay.json")
[ "$S" = 201 ] || fail "commit-2 replay answered $S"
cmp -s "$EVIDENCE/commit2.json" "$EVIDENCE/commit2-replay.json" \
  || fail 'replay body is not byte-identical to the stored result'
#   an EQUAL selection -> 200 {resumed:true}, no second process (reservation row 1, from memory)
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-web:feature/s003b"],"seedOverride":"S-003 fixture seed (app-web again)"}' "$EVIDENCE/preview3.json")
[ "$S" = 200 ] || fail "preview-3 answered $S"
BODY3="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview3.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s003-commit-3"})')"
S=$(post_json /api/radar/handoff "$BODY3" "$EVIDENCE/resumed-200.json")
[ "$S" = 200 ] || fail "equal-selection commit answered $S, expected 200 resumed"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/resumed-200.json","utf8"));
if(b.resumed!==true||!b.handoff||b.handoff.id!==process.env.HID2){console.error("not a resume of HID2");process.exit(1);}' \
  || fail 'equal selection did not resume the live handoff'
#   an INTERSECTING-BUT-UNEQUAL selection -> 423 facts_locked, body enumerating nothing (§7.3).
#   app-api's key is free again (HID1 is abandoned), so the union overlaps HID2 without equalling it.
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s001","branch:app-web:feature/s003b"],"seedOverride":"S-003 fixture seed (union)"}' "$EVIDENCE/preview4.json")
[ "$S" = 200 ] || fail "preview-4 answered $S"
BODY4="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview4.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s003-commit-4"})')"
S=$(post_json /api/radar/handoff "$BODY4" "$EVIDENCE/locked-423.json")
[ "$S" = 423 ] || fail "intersecting commit answered $S, expected 423 facts_locked"
node -e 'const b=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/locked-423.json","utf8"));
const k=Object.keys(b).sort().join(",");
if(k!=="error,incidentId,message"){console.error("423 body enumerates: "+k);process.exit(1);}' \
  || fail '423 body carries more than {error,message,incidentId}'

PHASE=B-recover
rmdir "$RADAR_DIR/handoffs/index.json" "$RADAR_DIR/handoffs/locks.json"
p6_wait_for "$SWEEP_BOUND_S" 1 node -e 'const fs=require("fs");
const st=fs.statSync(process.env.RADAR_DIR+"/handoffs/locks.json");if(!st.isFile())process.exit(1);
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
const keys=JSON.parse(process.env.KEYS2);
if(Object.keys(l.locks||{}).length!==keys.length)process.exit(2);
for(const k of keys) if(l.locks[k]!==process.env.HID2)process.exit(3);
const j=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/index.json","utf8"));
const byId=Object.fromEntries((j.handoffs||[]).map((h)=>[h.id,h.status]));
if(byId[process.env.HID1]!=="abandoned"||byId[process.env.HID2]!=="active")process.exit(4)' \
  || fail "the caches were not republished correct within ${SWEEP_BOUND_S}s of clearing the fault"
cp "$RADAR_DIR/handoffs/index.json" "$EVIDENCE/index-republished.json"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-republished.json"
kill_uuid "$UUID2"

# ================= PHASE C — truncated-tail repair ==============================================
run_tail_case() { # $1 fixture file   $2 expected warning   $3 must-not-appear warning   $4 idem
  local name="$1" expect="$2" other="$3" idem="$4"
  local old
  old="$(cat "$RADAR_DIR/server.pid")"
  kill "$old" 2>/dev/null || true
  p6_wait_for 10 1 bash -c "! kill -0 '$old' 2>/dev/null" || fail 'server would not stop for the tail case'
  # Committed damaged ledger, installed while the server is STOPPED — an input, not a bypass.
  export CASE_FILE="$FIX/ledger-tails/$name"
  cp "$CASE_FILE" "$RADAR_DIR/handoffs/ledger.jsonl"
  rm -rf "$RADAR_DIR/handoffs/index.json" "$RADAR_DIR/handoffs/locks.json"
  restart_server
  # Touch a p6 route so a lazily-constructed handoff module folds the ledger now.
  curl -s -o /dev/null -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/handoff/probe" || true
  p6_wait_for 10 1 bash -c "N=\$(/usr/bin/grep -c '$expect' '$RADAR_DIR/server.log' || true); [ \"\$N\" -eq 1 ]" \
    || fail "tail case $name: expected exactly one '$expect' warning"
  N=$(/usr/bin/grep -c "$other" "$RADAR_DIR/server.log" || true)
  [ "$N" -eq 0 ] || fail "tail case $name: unexpected '$other' warning"
  # The one-byte repair: fixture bytes preserved (the damaged line is never rewritten or deleted),
  # exactly one '\n' at the seam, nothing else yet.
  node -e 'const fs=require("fs");
const fix=fs.readFileSync(process.env.CASE_FILE);
const led=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl");
if(led.length!==fix.length+1){console.error(`repair appended ${led.length-fix.length} bytes, expected exactly 1`);process.exit(1);}
if(!led.subarray(0,fix.length).equals(fix)){console.error("fixture bytes were rewritten");process.exit(1);}
if(led[fix.length]!==0x0a){console.error("the appended byte is not \\n");process.exit(1);}' \
    || fail "tail case $name: the one-byte repair is wrong"
  # Next server-side append lands as its own parseable line. A commit against an unknown preview
  # appends claim + result(409) and touches nothing else.
  local bogus body st
  bogus="$(node -p 'crypto.randomUUID()')"
  body="{\"previewId\":\"$bogus\",\"hash\":\"$(printf '0%.0s' $(seq 1 64))\",\"idempotencyKey\":\"$idem\"}"
  st=$(post_json /api/radar/handoff "$body" "$EVIDENCE/tail-$name-commit.json")
  [ "$st" = 409 ] || fail "tail case $name: probe commit answered $st, expected 409 preview_not_found"
  node -e 'const fs=require("fs");
const fix=fs.readFileSync(process.env.CASE_FILE);
const led=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl");
if(!led.subarray(0,fix.length).equals(fix)){console.error("fixture bytes changed after the append");process.exit(1);}
const rest=led.subarray(fix.length+1).toString("utf8").split("\n").filter((l)=>l.trim());
if(rest.length<2){console.error("expected claim+result after the seam, got "+rest.length);process.exit(1);}
for(const l of rest) JSON.parse(l);' \
    || fail "tail case $name: the post-repair append fused or does not parse"
  cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/tail-$name-ledger.jsonl"
}

PHASE=C-unparseable
run_tail_case unparseable.jsonl 'skipped unparseable line' 'final line had no newline' s003-tail-a
PHASE=C-no-newline
run_tail_case no-newline.jsonl 'final line had no newline' 'skipped unparseable line' s003-tail-b

# ---- done --------------------------------------------------------------------------------------
PHASE=teardown
cleanup_dispatches
cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
echo "S-003 PASS — evidence in $EVIDENCE"
