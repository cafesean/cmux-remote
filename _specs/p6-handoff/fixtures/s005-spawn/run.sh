#!/usr/bin/env bash
# p6 S-005 acceptance oracle — the measured process shape (§2.1, §9 trap 15). Exits 0 on pass.
#
# What this proves live, from real processes the real server spawned:
#   1. From ONE ps capture: child.pid is the /usr/bin/script LEADER, the worker is a DIFFERENT pid
#      whose ppid is the leader, and their PGIDs DIFFER (script forks the worker into its own
#      group). The 2026-08-01 measurement was leader 85725/pgid 85725, worker 85731/pgid 85731.
#   2. THE DUPLICATE-WORKER HOLE: with a stand-in installing `trap '' HUP`, kill -9 the LEADER
#      only. The leader reads ESRCH — leader-only liveness would call the dispatch absent and
#      release its fact keys — while the worker is still alive. Then `kill -0 -- -<leaderPid>`
#      FAILS: the leader's group died with it, so signalling that group is not a remedy either.
#   3. The sessionUuid argv scan still finds the survivor (the wrapper delivers --session-id
#      verbatim, so the uuid sits in the worker's own command line), and the ppid-descent leg no
#      longer does (the worker reparented to pid 1) — which is exactly why observed pids are
#      persisted to the ledger rather than recomputed.
#
# The ps captures are retained at $EVIDENCE per the story.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s005-spawn" "S-005"

PHASE=setup
UUID1=""

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
  echo "S-005 FAIL [$PHASE]: $*" >&2
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  kill_uuid "$UUID1"
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

# ---- setup: one real repo, a HUP-trapping stand-in, config repointed ---------------------------
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"
REPO_API="$TMP/p6fix/app-api"
mkdir -p "$REPO_API"
git -C "$REPO_API" init -q -b feature/s005
echo 's005 fixture' >"$REPO_API/README.md"
git -C "$REPO_API" add README.md
git -C "$REPO_API" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'

# The §2.1 measured shape's stand-in: traps HUP (so the pty hangup from the leader's death cannot
# take it down), writes the transcript claude would (commit must confirm 201), and idles in a
# BOUNDED loop — never `exec sleep`, which would replace argv and erase the sessionUuid from the
# ps scan this story exists to prove.
STAND_IN="$TMP/p6fix/stand-in-claude"
cat >"$STAND_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s005 stand-in)"; exit 0; fi
trap '' HUP
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
slug="$(pwd | /usr/bin/sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$HOME/.claude/projects/$slug"
printf '%s\n' '{"type":"user","note":"s005 stand-in transcript"}' >"$HOME/.claude/projects/$slug/$sid.jsonl"
i=0; while [ "$i" -lt 300 ]; do sleep 1; i=$((i+1)); done
EOF
chmod +x "$STAND_IN"

export REPO_API STAND_IN
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_API}];
c.claudeBin=process.env.STAND_IN;
c.polyrepoRoot=require("path").dirname(process.env.REPO_API);
fs.writeFileSync(f,JSON.stringify(c,null,2));'

restart_server
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan-setup.json" \
  || fail 'POST /api/radar/scan failed'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-setup.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
const r=st.repos&&st.repos["app-api"];const b=r&&(r.branches||[]).find((x)=>x.name==="feature/s005");
if(!b||!(b.unpushed>0)){console.error("feature/s005 unpushed="+(b&&b.unpushed));process.exit(1);}' \
  || fail 'fixture repo did not scan into an unpushed>0 branch'

# ---- dispatch ----------------------------------------------------------------------------------
PHASE=dispatch
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s005"],"seedOverride":"S-005 fixture seed"}' "$EVIDENCE/preview.json")
[ "$S" = 200 ] || fail "preview answered $S: $(cat "$EVIDENCE/preview.json")"
export HID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8")).plan.handoffId')"
UUID1="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8")).plan.sessionUuid')"
export UUID1
BODY="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/preview.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s005-commit-1"})')"
S=$(post_json /api/radar/handoff "$BODY" "$EVIDENCE/commit.json")
[ "$S" = 201 ] || fail "commit answered $S: $(cat "$EVIDENCE/commit.json")"
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/handoff/$HID" >"$EVIDENCE/handoff.json" \
  || fail "GET handoff/$HID failed"
LEADER="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/handoff.json","utf8")).pid')"
export LEADER

# ---- 1. the process shape, from ONE capture ----------------------------------------------------
PHASE=process-shape
/bin/ps -axww -o pid=,ppid=,pgid=,command= >"$EVIDENCE/process-shape.txt"
WORKER="$(node -e 'const fs=require("fs");
const rows=fs.readFileSync(process.env.EVIDENCE+"/process-shape.txt","utf8").split("\n").map((l)=>{
  const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);return m&&{pid:+m[1],ppid:+m[2],pgid:+m[3],command:m[4]};}).filter(Boolean);
const leader=rows.find((r)=>r.pid===+process.env.LEADER);
if(!leader){console.error("leader pid not in the capture");process.exit(1);}
if(!leader.command.startsWith("/usr/bin/script")){console.error("child.pid is not the script leader: "+leader.command.slice(0,80));process.exit(1);}
if(leader.pgid!==leader.pid){console.error("leader is not its own group leader");process.exit(1);}
// BOTH the leader and the worker must be uuid-visible BEFORE anything is killed: a stand-in
// that loses its argv (the exec trap) leaves only the leader matching, and every kill+absence
// assertion after this point would then pass for the wrong reason — the escaped worker is
// invisible to a uuid match. Measured for real by another story before this gate existed.
const uuidRows=rows.filter((r)=>r.command.includes(process.env.UUID1));
if(uuidRows.length<2){console.error("only "+uuidRows.length+" uuid match(es) pre-kill — leader AND worker must both be visible");process.exit(1);}
if(!uuidRows.some((r)=>r.pid===leader.pid)){console.error("the leader row does not carry the uuid");process.exit(1);}
const workers=rows.filter((r)=>r.ppid===leader.pid&&r.command.includes(process.env.UUID1));
if(workers.length!==1){console.error("expected exactly one uuid-bearing child of the leader, got "+workers.length);process.exit(1);}
const w=workers[0];
if(w.pid===leader.pid){console.error("worker is the leader");process.exit(1);}
if(w.pgid===leader.pgid){console.error(`worker pgid ${w.pgid} equals leader pgid ${leader.pgid} — script did not fork it into its own group`);process.exit(1);}
console.log(w.pid);')" || fail 'the one-capture process shape does not match §2.1'
export WORKER
echo "S-005: shape ok — leader $LEADER (script, own group), worker $WORKER (child, different pgid)"

# ---- 2. the duplicate-worker hole --------------------------------------------------------------
PHASE=duplicate-worker-hole
/bin/ps -axww -o pid=,ppid=,lstart=,command= >"$EVIDENCE/descent-before.txt"
node -e 'const fs=require("fs");
const rows=fs.readFileSync(process.env.EVIDENCE+"/descent-before.txt","utf8").split("\n");
const w=rows.find((l)=>l.includes(process.env.UUID1)&&new RegExp("^\\s*"+process.env.WORKER+"\\s").test(l));
if(!w){console.error("worker not found in pre-kill capture");process.exit(1);}
if(!new RegExp("^\\s*"+process.env.WORKER+"\\s+"+process.env.LEADER+"\\s").test(w)){console.error("worker ppid is not the leader pre-kill");process.exit(1);}' \
  || fail 'descent leg: the ppid-closure does not find the worker while the leader lives'

kill -9 "$LEADER"
p6_wait_for 5 1 bash -c "! kill -0 '$LEADER' 2>/dev/null" || fail 'leader survived SIGKILL'
kill -0 "$WORKER" 2>/dev/null || fail 'worker died with the leader — trap-HUP stand-in did not hold'
# Leader-only liveness would now read `absent` and release the fact keys — while the worker lives.
if kill -0 -- "-$LEADER" 2>/dev/null; then
  fail "kill -0 -- -$LEADER succeeded — the leader's process group should be gone"
fi

# ---- 3. the uuid scan closes the hole; the descent leg cannot ----------------------------------
PHASE=uuid-scan
/bin/ps -axww -o pid=,ppid=,lstart=,command= >"$EVIDENCE/descent-after.txt"
node -e 'const fs=require("fs");
const rows=fs.readFileSync(process.env.EVIDENCE+"/descent-after.txt","utf8").split("\n");
const hits=rows.filter((l)=>l.includes(process.env.UUID1));
const w=hits.find((l)=>new RegExp("^\\s*"+process.env.WORKER+"\\s").test(l));
if(!w){console.error("the sessionUuid scan no longer finds the surviving worker");process.exit(1);}
// Reparented: ppid is no longer the (dead) leader — the closure rooted at the leader finds nothing.
if(new RegExp("^\\s*"+process.env.WORKER+"\\s+"+process.env.LEADER+"\\s").test(w)){console.error("worker still claims the dead leader as ppid");process.exit(1);}
if(rows.some((l)=>new RegExp("^\\s*"+process.env.LEADER+"\\s").test(l)&&l.includes("/usr/bin/script"))){console.error("dead leader still in the table");process.exit(1);}' \
  || fail 'post-kill capture does not show the survivor by uuid / the reparenting'

# ---- teardown: kill everything this story spawned and prove it ---------------------------------
PHASE=teardown
kill_uuid "$UUID1"
# Absence poll with the uuid in env only — a probe with the uuid in its own argv can match itself.
p6_wait_for 10 1 env P6U="$UUID1" node -e 'const{execFileSync}=require("child_process");
const out=execFileSync("/bin/ps",["-axww","-o","command="],{encoding:"utf8"});
process.exit(out.split("\n").some((l)=>l.includes(process.env.P6U))?1:0)' \
  || fail 'a process still carries the sessionUuid after teardown'
cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
echo "S-005 PASS — evidence in $EVIDENCE"
