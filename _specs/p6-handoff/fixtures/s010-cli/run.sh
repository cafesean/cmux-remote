#!/usr/bin/env bash
# p6 S-010 acceptance oracle — the CLI as an HTTP client, proven against a real dispatch. Runs from
# a fresh checkout; exits 0 on pass.
#
# The fixture pins this story's own selection in SELECTOR (epic:PROJ-910 — DISJOINT from S-006's
# fixture epic per spec §11: two proofs dispatching the same fact keys would collide on the
# reservation, and release is bounded below by goneGraceMs + 2×sessionSweepSec, which no proof may
# wait out). config.claudeBin points at the committed stand-in, and confirmMs is shortened to 1000
# so the commit settles 202 quickly — the bound asserted is expressed in that threshold (§11).
#
# What it proves: --dry posts preview ONLY (no child, no ledger line); a typed `y` produces exactly
# one dispatch and one intent record, written BY THE SERVER (the CLI's radar dir gains nothing);
# `handoff show <id>` prints the §7.1 Handoff projection and exits 0; and the whole dispatch set is
# killed afterwards, leaving no process carrying the sessionUuid.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s010-cli" "S-010"

fail() {
  echo "S-010 FAIL: $*" >&2
  cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
  exit 1
}

# The config-rewrite-then-restart dance is _lib.sh's shared p6_restart_server: the handoff module
# snapshots its config once at boot, so rewrites must land before a restart to be seen.

# ps helper: pids whose command carries a uuid. node, not a grep pipeline, so the matcher can never
# catch its own process and an empty match is an honest zero.
ps_uuid_count() { # <uuid>
  UUID_Q="$1" node -e 'const out=require("child_process").execFileSync("/bin/ps",["-axww","-o","pid=,command="],{encoding:"utf8"});
console.log(out.split("\n").filter((l)=>l.includes(process.env.UUID_Q)).length);'
}

SEL="$(cat "$FIX/SELECTOR")"
[ "$SEL" = "epic:PROJ-910" ] || fail "SELECTOR drifted: $SEL"

# --- a real repo so the pinned selector resolves (dirty worktree -> wt:<path>:dirty) -----------
REPO_DIR="$TMP/p6fix/s010-repo"
mkdir -p "$REPO_DIR"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
export REPO_DIR
git -C "$REPO_DIR" init -q -b 'feature/PROJ-910-cli'
echo 's010 fixture' >"$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
echo 'dirty' >"$REPO_DIR/UNTRACKED.txt"

chmod +x "$RADAR_DIR/stand-in-claude"
# polyrepoRoot too: §M2 falls back to it whenever |R| != 1, and the committed /tmp/p6fix
# placeholder exists nowhere — an unrewritten root would 422 workdir_unresolved.
export P6FIX_ROOT="$(cd "$TMP/p6fix" && pwd -P)"
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"s010-repo",path:process.env.REPO_DIR}];
c.polyrepoRoot=process.env.P6FIX_ROOT;
c.claudeBin=process.env.RADAR_DIR+"/stand-in-claude";
fs.writeFileSync(f,JSON.stringify(c,null,2));'
p6_restart_server || fail 'server restart after the config rewrite never came ready'

curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan.json" \
  || fail 'POST /api/radar/scan failed'
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/state.json","utf8"));
if(!(st.epics||[]).some((e)=>e.key==="PROJ-910"))process.exit(1);' \
  || fail 'the scan did not publish epic PROJ-910 — the pinned selector would not resolve'

# --- --dry: preview only — plan printed, NO child, NO ledger line ------------------------------
# The CLI finds the harness server because _lib.sh rewrote the fixture's serverBaseUrl to $BASE and
# exported RADAR_DIR; SERVER_TOKEN is the env var config.serverTokenRef names. No port hard-coded.
node radar/radar-cli.js handoff "$SEL" --dry >"$EVIDENCE/dry.txt" || fail '--dry exited non-zero'
DRY_UUID="$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/dry.txt","utf8"));
if(!e.plan||!e.plan.previewId)process.exit(1);console.log(e.plan.sessionUuid);')" \
  || fail '--dry did not print a parseable plan envelope'
[ ! -e "$RADAR_DIR/handoffs/ledger.jsonl" ] || fail '--dry appended to the ledger — preview must write no p6 state'
[ "$(ps_uuid_count "$DRY_UUID")" = "0" ] || fail '--dry spawned a process'

# --- typed `y`: exactly one dispatch, exactly one intent, all written by the SERVER ------------
printf 'y\n' | node radar/radar-cli.js handoff "$SEL" >"$EVIDENCE/commit-out.txt" \
  || fail 'the confirmed handoff exited non-zero'
[ -f "$RADAR_DIR/handoffs/ledger.jsonl" ] || fail 'no ledger after a confirmed handoff'
HID="$(node -e 'const L=require("fs").readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const intents=L.filter((r)=>r.t==="intent");
if(intents.length!==1){console.error("expected exactly 1 intent record, got "+intents.length);process.exit(1);}
console.log(intents[0].id);')" || fail 'the ledger does not hold exactly one intent record'
UUID="$(node -e 'const L=require("fs").readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
console.log(L.filter((r)=>r.t==="intent")[0].plan.sessionUuid);')"
export HID UUID

# One dispatch: the write order landed (claim -> intent -> process -> status), the status is a
# live one, and a real process carries the sessionUuid RIGHT NOW.
node -e 'const L=require("fs").readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const types=L.map((r)=>r.t);
for(const t of ["claim","intent","process","status","result"]) if(!types.includes(t)){console.error("missing "+t+" record; ledger has: "+types.join(","));process.exit(1);}
if(types.indexOf("claim")>types.indexOf("intent")||types.indexOf("intent")>types.indexOf("process"))process.exit(1);
const procs=L.filter((r)=>r.t==="process"&&r.id===process.env.HID);
if(procs.length<1||!Number.isFinite(procs[0].pid))process.exit(1);
const s=L.filter((r)=>r.t==="status"&&r.id===process.env.HID).pop();
if(!s||!["active","unconfirmed"].includes(s.to)){console.error("newest status: "+JSON.stringify(s&&s.to));process.exit(1);}' \
  || fail 'the ledger does not show one complete claim->intent->process->status dispatch'
# At least TWO matches: the /usr/bin/script leader AND the worker itself. The worker's argv only
# carries the uuid because the stand-in waits in a loop instead of exec'ing sleep — a leader-only
# match would mean the worker escaped the dispatch set, the §2.1 hole this scan exists to close.
UC="$(ps_uuid_count "$UUID")"
[ "$UC" -ge 2 ] || fail "expected the leader AND the worker to carry the sessionUuid, found $UC match(es)"

# --- handoff show: one id, the §7.1 projection, exit 0 -----------------------------------------
node radar/radar-cli.js handoff show "$HID" >"$EVIDENCE/show.json" || fail 'handoff show exited non-zero'
node -e 'const o=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/show.json","utf8"));
if(o.id!==process.env.HID)process.exit(1);
for(const k of ["plan","lastObservationAt","pidGoneSince"]) if(k in o){console.error("Handoff projection must not carry "+k+" (spec §7.1)");process.exit(2);}
if(typeof o.status!=="string"||!Array.isArray(o.factKeys))process.exit(3);' \
  || fail 'handoff show did not print the exact Handoff projection'

# --- teardown: kill the WHOLE dispatch set and prove absence -----------------------------------
# One node process does kill AND absence-poll, with the uuid in the ENVIRONMENT only: a uuid in any
# argv would appear in ps output and the matcher would count itself alive forever (the same
# self-match trap as `pgrep -f` grepping its own command line).
UUID_Q="$UUID" node -e 'const cp=require("child_process");
const scan=()=>cp.execFileSync("/bin/ps",["-axww","-o","pid=,command="],{encoding:"utf8"})
  .split("\n").filter((l)=>l.includes(process.env.UUID_Q));
for(const l of scan()){
  const pid=parseInt(l.trim().split(/\s+/)[0],10);
  if(Number.isFinite(pid)){try{process.kill(pid,"SIGKILL");}catch(_){/* already gone */}}
}
const t0=Date.now();
(function poll(){
  const left=scan();
  if(left.length===0)process.exit(0);
  if(Date.now()-t0>10000){console.error("still alive after SIGKILL:\n"+left.join("\n"));process.exit(1);}
  setTimeout(poll,500);
})();' || fail 'a process still carries the sessionUuid after the kill'

cp "$RADAR_DIR/server.log" "$EVIDENCE/server.log" 2>/dev/null || true
echo "S-010 PASS — evidence in $EVIDENCE"
