#!/usr/bin/env bash
# p6 S-004 acceptance oracle — dispatch-set liveness, the duplicate-worker hole closed, and the
# persisted observedPid pinned by lstart. Exits 0 on pass. Two legs, each a real dispatch:
#
# LEG 1 — the uuid scan. Kill the LEADER only (the /usr/bin/script pid the commit recorded). The
#   HUP-trapping worker still carries `--session-id <uuid>` in its argv, so the §M2 dispatch-set
#   scan reads the handoff ALIVE: assert it does NOT reach abandoned and holds EVERY fact key for
#   a full goneGraceMs + 2 sweeps. Then kill the worker and assert `abandoned` lands — and the
#   keys release — within goneGraceMs + 2 x sessionSweepSec, computed from the fixture config.
#
# LEG 2 — the persisted pid, pinned by lstart. A second stand-in writes its transcript, waits for
#   the sweep to PERSIST it into observedPids[] (a ledger `process` record carrying {pid,lstart}),
#   then `exec /bin/sleep` — exec keeps the pid and start time but REPLACES argv, so the uuid
#   vanishes from the ps table. Kill the leader: now leg 1 (uuid) finds nothing and leg 3 (leader)
#   is ESRCH, so the handoff stays alive PURELY through the persisted {pid,lstart} entry — assert
#   not-abandoned + keys held, and assert the uuid scan really returns zero rows so the proof
#   cannot silently ride leg 1. Then kill the worker pid; absent -> abandoned within the bound.
#   (The negative direction — same pid, DIFFERENT lstart, reads absent — needs a forced pid reuse
#   no real kernel will schedule on demand; it is a unit-level assert in the protocol suite. What
#   this leg proves live is the pin's positive half: pid + byte-identical lstart = alive.)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s004-lifecycle" "S-004"

PHASE=setup
UUID1=""; UUID2=""; WORKER2=""

# The uuid travels via the ENVIRONMENT, never a probe's argv: a grep/bash -c carrying it in its
# own command line races into the ps capture and matches itself (the _lib p6_uuid_pids trap), so
# both the listing and the kill live in ONE node process with the uuid in env.
kill_uuid() {
  [ -n "${1:-}" ] || return 0
  P6U="$1" node -e 'const{execFileSync}=require("child_process");
const out=execFileSync("/bin/ps",["-axww","-o","pid=,command="],{encoding:"utf8"});
for(const l of out.split("\n"))if(l.includes(process.env.P6U)){
  try{process.kill(Number(l.trim().split(/\s+/)[0]),9)}catch(_){}}' || true
}

fail() {
  echo "S-004 FAIL [$PHASE]: $*" >&2
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/ledger-at-failure.jsonl" 2>/dev/null || true
  /bin/ps -axww -o pid=,ppid=,lstart=,command= >"$EVIDENCE/ps-at-failure.txt" 2>/dev/null || true
  kill_uuid "$UUID1"; kill_uuid "$UUID2"
  [ -n "$WORKER2" ] && kill -9 "$WORKER2" 2>/dev/null || true
  exit 1
}

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
  p6_wait_for 30 1 curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" \
    || fail 'restarted server never published a snapshot'
}

post_json() {
  curl -s -o "$3" -w '%{http_code}' -XPOST -H "Authorization: Bearer $SERVER_TOKEN" \
    -H 'Content-Type: application/json' -d "$2" "$BASE$1"
}

# The story's verbatim abandoned oracle shape: the status record landed AND locks hold nothing.
abandoned_oracle() { # $1 = handoff id
  HID_CHECK="$1" node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
if(!recs.some((r)=>r.t==="status"&&r.id===process.env.HID_CHECK&&r.to==="abandoned"))process.exit(1);
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
if(Object.values(l.locks||{}).includes(process.env.HID_CHECK))process.exit(2)'
}

# Not-abandoned + every key held — the hold assert both legs share.
hold_oracle() { # $1 = handoff id  $2 = fact-keys json
  HID_CHECK="$1" KEYS_CHECK="$2" node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const bad=recs.find((r)=>r.t==="status"&&r.id===process.env.HID_CHECK&&(r.to==="abandoned"||r.to==="resolved"||r.to==="discarded"));
if(bad){console.error("terminal status appeared: "+bad.to);process.exit(1);}
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
for(const k of JSON.parse(process.env.KEYS_CHECK)) if(l.locks[k]!==process.env.HID_CHECK){console.error("key released: "+k);process.exit(1);}'
}

# ---- setup: two real repos (one per leg, disjoint keys), two stand-ins -------------------------
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"
make_repo() {
  mkdir -p "$1"
  git -C "$1" init -q -b "$2"
  echo 's004 fixture' >"$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
}
REPO_API="$TMP/p6fix/app-api"; make_repo "$REPO_API" feature/s004a
REPO_WEB="$TMP/p6fix/app-web"; make_repo "$REPO_WEB" feature/s004b

# Leg-1 stand-in: transcript, trap-HUP, BOUNDED loop — uuid stays in argv (never `exec sleep`,
# which replaces argv and would erase the uuid from the scan this leg exists to prove).
HOLD_IN="$TMP/p6fix/stand-in-hold"
cat >"$HOLD_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s004 hold stand-in)"; exit 0; fi
trap '' HUP
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
slug="$(pwd | /usr/bin/sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$HOME/.claude/projects/$slug"
printf '%s\n' '{"type":"user","note":"s004 hold transcript"}' >"$HOME/.claude/projects/$slug/$sid.jsonl"
i=0; while [ "$i" -lt 300 ]; do sleep 1; i=$((i+1)); done
EOF
chmod +x "$HOLD_IN"

# Leg-2 stand-in: same, but after 20 s (time for >= 2 sweeps to persist it into observedPids[])
# it execs /bin/sleep — pid and lstart survive the exec, argv (and the uuid) do not. The sleep is
# bounded, so an aborted run leaks nothing for more than 300 s.
EXEC_IN="$TMP/p6fix/stand-in-exec"
cat >"$EXEC_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s004 exec stand-in)"; exit 0; fi
trap '' HUP
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
slug="$(pwd | /usr/bin/sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$HOME/.claude/projects/$slug"
printf '%s\n' '{"type":"user","note":"s004 exec transcript"}' >"$HOME/.claude/projects/$slug/$sid.jsonl"
sleep 20
exec /bin/sleep 300
EOF
chmod +x "$EXEC_IN"

export REPO_API REPO_WEB HOLD_IN EXEC_IN
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_API},{id:"app-web",path:process.env.REPO_WEB}];
c.claudeBin=process.env.HOLD_IN;
c.polyrepoRoot=require("path").dirname(process.env.REPO_API);
fs.writeFileSync(f,JSON.stringify(c,null,2));'

restart_server
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan-setup.json" \
  || fail 'POST /api/radar/scan failed'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-setup.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
for(const [rid,br] of [["app-api","feature/s004a"],["app-web","feature/s004b"]]){
  const r=st.repos&&st.repos[rid];const b=r&&(r.branches||[]).find((x)=>x.name===br);
  if(!b||!(b.unpushed>0)){console.error(`${rid}:${br} unpushed=${b&&b.unpushed}`);process.exit(1);}
}' || fail 'fixture repos did not scan into unpushed>0 branches'

# §11: every asserted bound is computed from the committed thresholds.
HOLD_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil((c.goneGraceMs+2*c.sessionSweepSec*1000)/1000)')"
ABANDON_BOUND_S="$HOLD_S"
echo "S-004: hold window = abandoned bound = ${HOLD_S}s (goneGraceMs + 2 x sessionSweepSec)"

# ================= LEG 1 — the uuid scan keeps a leaderless dispatch alive ======================
PHASE=leg1-dispatch
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s004a"],"seedOverride":"S-004 leg-1 seed"}' "$EVIDENCE/preview1.json")
[ "$S" = 200 ] || fail "preview-1 answered $S: $(cat "$EVIDENCE/preview1.json")"
HID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.handoffId')"
UUID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.sessionUuid')"
KEYS1="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8")).plan.factKeys)')"
BODY1="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview1.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s004-commit-1"})')"
S=$(post_json /api/radar/handoff "$BODY1" "$EVIDENCE/commit1.json")
[ "$S" = 201 ] || fail "commit-1 answered $S: $(cat "$EVIDENCE/commit1.json")"
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/handoff/$HID1" >"$EVIDENCE/handoff1.json"
LEADER1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/handoff1.json","utf8")).pid')"

PHASE=leg1-hold
kill -9 "$LEADER1"
p6_wait_for 5 1 bash -c "! kill -0 '$LEADER1' 2>/dev/null" || fail 'leg-1 leader survived SIGKILL'
# The hold window: a full grace period plus two sweeps in which a leader-only build would have
# abandoned and released. Sample the hold oracle every second for the whole window.
i=0
while [ "$i" -lt "$HOLD_S" ]; do
  hold_oracle "$HID1" "$KEYS1" || fail "leg-1: handoff abandoned or keys released ${i}s after the leader-only kill"
  sleep 1; i=$((i+1))
done
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-leg1-held.json"

PHASE=leg1-abandon
kill_uuid "$UUID1"     # now the worker too — the whole set is gone
p6_wait_for "$ABANDON_BOUND_S" 1 abandoned_oracle "$HID1" \
  || fail "leg-1: abandoned did not land within ${ABANDON_BOUND_S}s of the worker kill"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-leg1-released.json"

# ================= LEG 2 — the persisted {pid, lstart} keeps an argv-less worker alive ==========
PHASE=leg2-dispatch
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));c.claudeBin=process.env.EXEC_IN;
fs.writeFileSync(f,JSON.stringify(c,null,2));'
restart_server   # the handoff module snapshots config at first use; a restart re-reads it

S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-web:feature/s004b"],"seedOverride":"S-004 leg-2 seed"}' "$EVIDENCE/preview2.json")
[ "$S" = 200 ] || fail "preview-2 answered $S: $(cat "$EVIDENCE/preview2.json")"
HID2="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.handoffId')"
UUID2="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.sessionUuid')"
KEYS2="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8")).plan.factKeys)')"
BODY2="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview2.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s004-commit-2"})')"
S=$(post_json /api/radar/handoff "$BODY2" "$EVIDENCE/commit2.json")
[ "$S" = 201 ] || fail "commit-2 answered $S: $(cat "$EVIDENCE/commit2.json")"
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/handoff/$HID2" >"$EVIDENCE/handoff2.json"
LEADER2="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/handoff2.json","utf8")).pid')"
# uuid in env only — a grep with it in argv can race into its own capture and match itself.
WORKER2="$(P6U="$UUID2" LEAD="$LEADER2" node -e 'const{execFileSync}=require("child_process");
const out=execFileSync("/bin/ps",["-axww","-o","pid=,command="],{encoding:"utf8"});
for(const l of out.split("\n")){
  if(!l.includes(process.env.P6U))continue;
  const pid=l.trim().split(/\s+/)[0];
  if(pid!==process.env.LEAD){console.log(pid);break;}
}')"
[ -n "$WORKER2" ] || fail 'leg-2 worker not found pre-exec'

PHASE=leg2-persist
# The sweep must persist the worker (with a non-null lstart) into the ledger BEFORE the exec at
# t+20s erases its argv — otherwise this leg would prove nothing.
export HID2
p6_wait_for 15 1 node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const withPids=recs.filter((r)=>r.t==="process"&&r.id===process.env.HID2&&(r.observedPids||[]).length);
if(!withPids.length)process.exit(1);
if(!withPids.some((r)=>r.observedPids.every((x)=>typeof x.lstart==="string"&&x.lstart)))process.exit(2)' \
  || fail 'the sweep never persisted the worker into observedPids[] with an lstart pin'
# Wait for the exec: the worker pid survives, its command becomes /bin/sleep, the uuid vanishes.
p6_wait_for 30 1 bash -c "/bin/ps -p '$WORKER2' -o command= | /usr/bin/grep -q '^/bin/sleep'" \
  || fail 'leg-2 worker never exec-ed into /bin/sleep'

PHASE=leg2-hold
kill -9 "$LEADER2"
p6_wait_for 5 1 bash -c "! kill -0 '$LEADER2' 2>/dev/null" || fail 'leg-2 leader survived SIGKILL'
# Prove the proof cannot ride the uuid leg: zero processes carry the uuid now. The uuid travels
# via the ENVIRONMENT, never this probe's argv — a grep with the uuid in its own command line
# races into the ps capture and matches itself (the _lib p6_uuid_pids trap).
N=$(P6U="$UUID2" node -e 'const{execFileSync}=require("child_process");
const out=execFileSync("/bin/ps",["-axww","-o","command="],{encoding:"utf8"});
console.log(out.split("\n").filter((l)=>l.includes(process.env.P6U)).length)')
[ "${N:-0}" -eq 0 ] || fail "leg-2: $N process(es) still carry the uuid — exec did not erase argv, the hold would prove nothing"
i=0
while [ "$i" -lt "$HOLD_S" ]; do
  hold_oracle "$HID2" "$KEYS2" || fail "leg-2: handoff abandoned or keys released ${i}s after the leader kill — the persisted {pid,lstart} liveness leg did not hold. KNOWN SIGNATURE: if ledger-at-failure.jsonl shows the SAME observedPids delta re-appended every sweep, observeNewPids is appending process records without applyRecord()ing them (its call sites pass a bare store.appendLine), so e.observedPids stays empty in memory until a restart refolds the ledger"
  sleep 1; i=$((i+1))
done
kill -0 "$WORKER2" 2>/dev/null || fail 'leg-2 worker died during the hold window'
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-leg2-held.json"

PHASE=leg2-abandon
kill -9 "$WORKER2"
p6_wait_for "$ABANDON_BOUND_S" 1 abandoned_oracle "$HID2" \
  || fail "leg-2: abandoned did not land within ${ABANDON_BOUND_S}s of the worker kill"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-leg2-released.json"
cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/ledger.jsonl"

# ---- teardown ----------------------------------------------------------------------------------
PHASE=teardown
kill_uuid "$UUID1"; kill_uuid "$UUID2"
cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
echo "S-004 PASS — evidence in $EVIDENCE"
