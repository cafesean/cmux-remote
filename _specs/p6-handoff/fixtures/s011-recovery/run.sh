#!/usr/bin/env bash
# p6 S-011 acceptance oracle — the undecidable set and the one-press durable discard (§M4).
# Exits 0 on pass.
#
# Two real dispatches whose stand-in writes NO transcript: both answer 202 unconfirmed with keys
# KEPT, and once each has sat unconfirmed for goneGraceMs with a LIVE process, both are
# undecidable. Then:
#   1. state.handoffRecovery is ONE object {token, since} — no id, no count, nothing that changes
#      when |U| changes — and the token is sha256(canon(sorted ids)) over EXACTLY our two ids,
#      recomputed here from radar/handoff-keys.js. Verifying the token equals the recomputation
#      IS the "covers both" proof; nothing else could hash to it.
#   2. ONE discard press answers 200 {} (there is no discard_failed response, synchronous or
#      later) and appends the recovery-op record BEFORE any signal: the LEDGER ORDER shows
#      recovery-op strictly before the first member's terminal status — file order is the proof,
#      immune to how fast the drive runs.
#   3. members settle INDEPENDENTLY, each as it is proven absent: dispatch A (compliant) dies on
#      the drive's SIGTERM round and settles `discarded`, releasing its keys, while B — whose
#      worker traps TERM, the "refusing to die" member — is still alive and unsettled. During
#      that window the survivor's keys stay held and the published element is STRICTLY NULL: the
#      recovery routes republish the handoff view after a 2xx (collector.republishHandoffView),
#      so the press itself clears the element rather than waiting out the blocked sweep. This
#      assert is deliberately strict — if that republish is ever removed, the stale pre-press
#      element lingers for up to 2 x discardKillMs and this goes red instead of a dead tolerance
#      arm silently accepting it. A non-null element is reported in two classes: the pressed
#      token (the republish regressed) vs any other token (a §M4 violation — an element over the
#      remainder is the forbidden serialised follow-up).
#   4. the drive's SIGKILL round eventually proves B absent too; B settles, its keys release, and
#      the element is still null. (A member that dodges SIGKILL entirely would hold its keys
#      forever by design — unprovable in finite time, so the oracle proves the bounded half.)
#
# The window is real because discardKillMs is committed at 15000: killDispatchSet's TERM round
# polls a full 15 s before escalating, and B ignores TERM for all of it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../_lib.sh"
p6_harness_start "s011-recovery" "S-011"

PHASE=setup
UUIDA=""; UUIDB=""

kill_uuid() {
  [ -n "${1:-}" ] || return 0
  local pids p
  pids=$(/bin/ps -axww -o pid=,command= | /usr/bin/grep -F "$1" | /usr/bin/grep -v grep | /usr/bin/awk '{print $1}') || true
  for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
}

fail() {
  echo "S-011 FAIL [$PHASE]: $*" >&2
  cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
  cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/ledger-at-failure.jsonl" 2>/dev/null || true
  kill_uuid "$UUIDA"; kill_uuid "$UUIDB"
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

# ---- setup: two repos, ONE stand-in that writes NO transcript ----------------------------------
# The refuser is selected by its own argv: the SEED travels as the final argv element, so a marker
# in dispatch B's seedOverride reaches the stand-in's "$*" verbatim and only THAT dispatch traps
# TERM. (Not the windowName: selectionSlug caps at 32 chars and truncates the branch name.)
FAKE_HOME="$TMP/home"; mkdir -p "$FAKE_HOME"
make_repo() {
  mkdir -p "$1"
  git -C "$1" init -q -b "$2"
  echo 's011 fixture' >"$1/README.md"
  git -C "$1" add README.md
  git -C "$1" -c user.name=fixture -c user.email=fixture@invalid commit -qm 'fixture commit'
}
REPO_API="$TMP/p6fix/app-api"; make_repo "$REPO_API" feature/s011a
REPO_WEB="$TMP/p6fix/app-web"; make_repo "$REPO_WEB" feature/s011-refuse

STAND_IN="$TMP/p6fix/stand-in-claude"
cat >"$STAND_IN" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "9.9.9 (s011 stand-in)"; exit 0; fi
trap '' HUP
case "$*" in *REFUSE-TERM*) trap '' TERM ;; esac
i=0; while [ "$i" -lt 300 ]; do sleep 1; i=$((i+1)); done
EOF
chmod +x "$STAND_IN"

export REPO_API REPO_WEB STAND_IN
node -e 'const fs=require("fs");const f=process.env.RADAR_DIR+"/config.json";
const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.repos=[{id:"app-api",path:process.env.REPO_API},{id:"app-web",path:process.env.REPO_WEB}];
c.claudeBin=process.env.STAND_IN;
c.polyrepoRoot=require("path").dirname(process.env.REPO_API);
fs.writeFileSync(f,JSON.stringify(c,null,2));'

restart_server
curl -sf -XPOST -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/scan" >"$EVIDENCE/scan-setup.json" \
  || fail 'POST /api/radar/scan failed'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-setup.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-setup.json","utf8"));
for(const [rid,br] of [["app-api","feature/s011a"],["app-web","feature/s011-refuse"]]){
  const r=st.repos&&st.repos[rid];const b=r&&(r.branches||[]).find((x)=>x.name===br);
  if(!b||!(b.unpushed>0)){console.error(`${rid}:${br} unpushed=${b&&b.unpushed}`);process.exit(1);}
}' || fail 'fixture repos did not scan into unpushed>0 branches'

# §11 bounds, computed from the committed thresholds. The undecidable bound is the SPEC-EXACT
# goneGraceMs + ONE sessionSweepSec (+1s poll granularity): the p6 riders run BEFORE the scan
# publishes, so a lifecycle change lands in state.json on the SAME publication — grace + 2 sweeps
# would silently tolerate a regression of that ordering.
U_BOUND_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil((c.goneGraceMs+c.sessionSweepSec*1000)/1000)+1')"
WINDOW_BOUND_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil((c.discardKillMs+4*c.sessionSweepSec*1000)/1000)')"
SETTLE_BOUND_S="$(node -p 'const c=JSON.parse(require("fs").readFileSync(process.env.RADAR_DIR+"/config.json","utf8"));Math.ceil((4*c.discardKillMs+4*c.sessionSweepSec*1000)/1000)')"
echo "S-011: bounds — undecidable ${U_BOUND_S}s, split window ${WINDOW_BOUND_S}s, full settle ${SETTLE_BOUND_S}s"

# ---- two unconfirmed dispatches ----------------------------------------------------------------
PHASE=dispatch-A
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-api:feature/s011a"],"seedOverride":"S-011 dispatch A seed"}' "$EVIDENCE/previewA.json")
[ "$S" = 200 ] || fail "preview-A answered $S: $(cat "$EVIDENCE/previewA.json")"
export HIDA="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewA.json","utf8")).plan.handoffId')"
UUIDA="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewA.json","utf8")).plan.sessionUuid')"
export KEYSA="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewA.json","utf8")).plan.factKeys)')"
BODYA="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewA.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s011-commit-a"})')"
S=$(post_json /api/radar/handoff "$BODYA" "$EVIDENCE/commitA.json")
[ "$S" = 202 ] || fail "commit-A answered $S, expected 202 unconfirmed: $(cat "$EVIDENCE/commitA.json")"

# handoffIds embed a UTC minute and the drive walks op.ids SORTED — commit B in a LATER minute so
# A is always driven first and the refuser's window is observable, deterministically.
PHASE=minute-boundary
MIN_A="$(node -p 'process.env.HIDA.split("-").slice(1,3).join("-")')"
p6_wait_for 70 2 bash -c "[ \"\$(/bin/date -u +%Y%m%d-%H%M)\" != '$MIN_A' ]" \
  || fail 'the minute never rolled over'

PHASE=dispatch-B
S=$(post_json /api/radar/handoff/preview '{"selectors":["branch:app-web:feature/s011-refuse"],"seedOverride":"S-011 dispatch B seed REFUSE-TERM"}' "$EVIDENCE/previewB.json")
[ "$S" = 200 ] || fail "preview-B answered $S: $(cat "$EVIDENCE/previewB.json")"
export HIDB="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewB.json","utf8")).plan.handoffId')"
UUIDB="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewB.json","utf8")).plan.sessionUuid')"
export KEYSB="$(node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewB.json","utf8")).plan.factKeys)')"
BODYB="$(node -p 'const e=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/previewB.json","utf8"));JSON.stringify({previewId:e.plan.previewId,hash:e.hash,idempotencyKey:"s011-commit-b"})')"
S=$(post_json /api/radar/handoff "$BODYB" "$EVIDENCE/commitB.json")
[ "$S" = 202 ] || fail "commit-B answered $S, expected 202 unconfirmed: $(cat "$EVIDENCE/commitB.json")"

# Both hold their keys while unconfirmed — silence never releases.
node -e 'const fs=require("fs");
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
for(const [keys,hid] of [[process.env.KEYSA,process.env.HIDA],[process.env.KEYSB,process.env.HIDB]])
  for(const k of JSON.parse(keys)) if(l.locks[k]!==hid){console.error("key not held: "+k);process.exit(1);}' \
  || fail 'unconfirmed handoffs do not hold their keys'

# ---- 1. the element: one object, {token, since}, token covers exactly both ---------------------
PHASE=element
p6_wait_for "$U_BOUND_S" 1 node -e 'const fs=require("fs");
const hk=require("./radar/handoff-keys.js");
const st=JSON.parse(require("child_process").execFileSync("curl",["-sf","-H","Authorization: Bearer "+process.env.SERVER_TOKEN,process.env.BASE+"/api/radar/state"],{encoding:"utf8"}));
const el=st.handoffRecovery;
if(el==null)process.exit(1);
const expected=hk.sha256(hk.canon([process.env.HIDA,process.env.HIDB].sort()));
if(el.token!==expected)process.exit(2)' \
  || fail "handoffRecovery never covered both undecidable handoffs within ${U_BOUND_S}s"
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-undecidable.json"
node -e 'const st=JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-undecidable.json","utf8"));
const el=st.handoffRecovery;
const keys=Object.keys(el).sort().join(",");
if(keys!=="since,token"){console.error("element carries: "+keys+" — ids or counts leak");process.exit(1);}
if(typeof el.token!=="string"||typeof el.since!=="string"){console.error("element field types wrong");process.exit(1);}' \
  || fail 'handoffRecovery is not exactly {token, since}'
TOKEN="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.EVIDENCE+"/state-undecidable.json","utf8")).handoffRecovery.token')"
export TOKEN

# ---- 2. one press: 200 {}, durable before any signal -------------------------------------------
PHASE=press
S=$(post_json /api/radar/recovery/discard "{\"token\":\"$TOKEN\"}" "$EVIDENCE/press.json")
[ "$S" = 200 ] || fail "discard press answered $S: $(cat "$EVIDENCE/press.json")"
[ "$(cat "$EVIDENCE/press.json")" = '{}' ] || fail "press body is not the unconditional {}: $(cat "$EVIDENCE/press.json")"
node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const op=recs.find((r)=>r.t==="recovery-op"&&r.op==="discard");
if(!op){console.error("no recovery-op record at press return");process.exit(1);}
const ids=[process.env.HIDA,process.env.HIDB].sort();
if(JSON.stringify(op.ids)!==JSON.stringify(ids)){console.error("op ids: "+JSON.stringify(op.ids));process.exit(1);}' \
  || fail 'the recovery-op record is missing or names the wrong members'

# ---- 3. independent settlement: A discards while B refuses; keys + element hold ----------------
PHASE=split-window
p6_wait_for "$WINDOW_BOUND_S" 1 node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const TERM=new Set(["resolved","abandoned","discarded"]);
const done=(h)=>recs.some((r)=>r.t==="status"&&r.id===h&&TERM.has(r.to));
if(!done(process.env.HIDA))process.exit(1);      // A must settle first (older minute, sorted drive)
if(done(process.env.HIDB))process.exit(2)' \
  || fail "the split (A settled, B refusing) never appeared within ${WINDOW_BOUND_S}s"
# Atomically inside the window: A settled (per the AUTHORITY — ledger + the in-memory projection;
# locks.json is published OUTPUT whose republication waits for the blocked sweep to finish, by
# design), B unsettled with its keys held, the element gone and NOT returned.
node -e 'const fs=require("fs");const cp=require("child_process");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const opIdx=recs.findIndex((r)=>r.t==="recovery-op"&&r.op==="discard");
const TERM=new Set(["resolved","abandoned","discarded"]);
const firstTermIdx=recs.findIndex((r)=>r.t==="status"&&TERM.has(r.to)&&(r.id===process.env.HIDA||r.id===process.env.HIDB));
if(opIdx<0||firstTermIdx<0||opIdx>=firstTermIdx){console.error(`ledger order: recovery-op@${opIdx}, first terminal@${firstTermIdx} — the record must precede every settlement`);process.exit(1);}
const a=recs.filter((r)=>r.t==="status"&&r.id===process.env.HIDA&&TERM.has(r.to)).pop();
if(!a||a.to!=="discarded"){console.error("A settled as "+(a&&a.to));process.exit(1);}
const auth="Authorization: Bearer "+process.env.SERVER_TOKEN;
const ha=JSON.parse(cp.execFileSync("curl",["-sf","-H",auth,process.env.BASE+"/api/radar/handoff/"+process.env.HIDA],{encoding:"utf8"}));
if(ha.status!=="discarded"){console.error("in-memory projection says A is "+ha.status);process.exit(1);}
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
for(const k of JSON.parse(process.env.KEYSB)) if(l.locks[k]!==process.env.HIDB){console.error("survivor key released: "+k);process.exit(1);}
// STRICTLY NULL mid-drive: the press republishes the handoff view after its 2xx, so the element
// clears at the press, not at the end of the blocked drive. The two non-null cases are named
// apart because they are different defects: the pressed token back on the board means the
// press-time republish regressed; any OTHER token is a §M4 violation — an element over the
// remainder, the forbidden serialised follow-up.
const st=JSON.parse(cp.execFileSync("curl",["-sf","-H",auth,process.env.BASE+"/api/radar/state"],{encoding:"utf8"}));
if(st.handoffRecovery!==null){
  const which=st.handoffRecovery.token===process.env.TOKEN
    ? "the STALE pre-press element is still published — the press-time republish regressed"
    : "a NEW element surfaced for the remainder — a §M4 violation";
  console.error(which+": "+JSON.stringify(st.handoffRecovery));process.exit(1);}' \
  || fail 'the split-window invariants do not hold (order, A discarded, B held, element strictly null)'
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-split-window.json"

# ---- 4. the SIGKILL round proves B absent; everything settles, the element stays null ----------
PHASE=full-settle
p6_wait_for "$SETTLE_BOUND_S" 2 node -e 'const fs=require("fs");
const recs=fs.readFileSync(process.env.RADAR_DIR+"/handoffs/ledger.jsonl","utf8").trim().split("\n").map(JSON.parse);
const TERM=new Set(["resolved","abandoned","discarded"]);
const b=recs.filter((r)=>r.t==="status"&&r.id===process.env.HIDB&&TERM.has(r.to)).pop();
if(!b)process.exit(1);
const l=JSON.parse(fs.readFileSync(process.env.RADAR_DIR+"/handoffs/locks.json","utf8"));
if(Object.values(l.locks||{}).includes(process.env.HIDB))process.exit(2);
// The drive is over: the REPUBLISHED cache must now show A released too (deferred from the window,
// where the sweep that republishes it was still blocked inside the kill rounds).
if(Object.values(l.locks||{}).includes(process.env.HIDA))process.exit(3)' \
  || fail "B never settled (with both members' keys released on disk) within ${SETTLE_BOUND_S}s of the press"
# After the drive completes the blocked sweep finishes and republishes — the element must now be
# gone on the REAL pipeline, and stay gone. Polled, because the settle wait reads the ledger while
# the state publication lands at the end of the same sweep pass.
p6_wait_for "$(( 2 * 5 + 2 ))" 1 bash -c 'curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" | node -e "let d=\"\";process.stdin.on(\"data\",(c)=>d+=c).on(\"end\",()=>process.exit(JSON.parse(d).handoffRecovery===null?0:1))"' \
  || fail 'handoffRecovery did not clear after both members settled'
curl -sf -H "Authorization: Bearer $SERVER_TOKEN" "$BASE/api/radar/state" >"$EVIDENCE/state-settled.json"
cp "$RADAR_DIR/handoffs/ledger.jsonl" "$EVIDENCE/ledger.jsonl"
cp "$RADAR_DIR/handoffs/locks.json" "$EVIDENCE/locks-settled.json"

# ---- teardown ----------------------------------------------------------------------------------
PHASE=teardown
kill_uuid "$UUIDA"; kill_uuid "$UUIDB"
cat "$RADAR_DIR/server.log" >>"$EVIDENCE/server-full.log" 2>/dev/null || true
echo "S-011 PASS — evidence in $EVIDENCE"
