#!/usr/bin/env bash
# F1 real-process reproduction (adapted from J2 f1.sh). Usage: f1.sh <ver:e9|fix> <inst:codex|claude> <case> <outlog>
# broker: env -i PATH HOME node <INST>/mcp-server/dist/session-message-broker.mjs --state-directory R
# CLI:    env -i PATH HOME AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=R node <INST>/mcp-server/dist/session-message-cli.mjs
# AGENT_GOVERNANCE_TRUST_DB_PATH is never set for broker/CLI (only inside seed.mjs, the fixture writer).
set -u
. /tmp/env.sh
VER=$1; KIND=$2; CASE=$3; LOG=$4
INST=/tmp/inst/$VER/$KIND; SRC=/tmp/$VER
BASE=/tmp/f1/$VER-$KIND-$CASE; rm -rf "$BASE"; mkdir -p "$BASE/home"
H=$BASE/home; D=$H/.agent-governance-suite/session-messaging
R=$BASE/R
case $CASE in c-same) R=$D;; esac
mkdir -p "$R"; chmod 700 "$R"
SEED() { ( cd "$SRC" && SEED_SRC=$SRC node --import tsx /tmp/ev/scripts/seed.mjs "$@" ); }
# Observation must never open DBs in place: copy R/D DB files to a scratch dir and dump the copies.
SN=0
dumpsafe() { SN=$((SN+1)); local S=$BASE/snap-$SN; mkdir -p "$S/R" "$S/D"
  for f in "$R"/session-messages.sqlite3* "$R"/trust.sqlite3*; do [ -f "$f" ] && cp "$f" "$S/R/"; done
  for f in "$D"/trust.sqlite3*; do [ -f "$f" ] && cp "$f" "$S/D/"; done
  echo "(dump of scratch copies; R/trust.sqlite3 present=$([ -e "$R/trust.sqlite3" ] && echo yes || echo no), D/trust.sqlite3 present=$([ -e "$D/trust.sqlite3" ] && echo yes || echo no))"
  node /tmp/ev/scripts/dump.mjs "$S/R/session-messages.sqlite3" "$S/R/trust.sqlite3" "$S/D/trust.sqlite3"; rm -rf "$S"; }
dstate() { if [ -d "$D" ]; then (cd "$D" && for f in $(ls -A | sort); do echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -c1-16) ino=$(stat -c %i "$f") mtime=$(stat -c %.9Y "$f") ctime=$(stat -c %.9Z "$f")"; done); else echo NO_DIR; fi; }
{
echo "## VER=$VER KIND=$KIND CASE=$CASE INST=$INST"; echo "R=$R"; echo "DEFAULT_TRUST=$D/trust.sqlite3"
case $CASE in
  a1)  # valid evidence only in R (broker-bound); default path has an unrelated trust DB
    SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json"
    mkdir -p "$D"; SEED_NONCE=unrelated-nonce-abcdefghijklmnop SEED "$BASE/other-session.sqlite3" "$D/trust.sqlite3" > /dev/null ;;
  a2)  # valid evidence only in default path; R has NO trust DB at all
    SEED "$R/session-messages.sqlite3" "$D/trust.sqlite3" > "$BASE/seed.json" ;;
  a3)  # R has a trust DB (unrelated key, no original receipt); valid original only in default path (J2 a2 construction)
    SEED "$R/session-messages.sqlite3" "$D/trust.sqlite3" > "$BASE/seed.json"
    SEED_NONCE=unrelated-nonce-abcdefghijklmnop SEED "$BASE/other-session.sqlite3" "$R/trust.sqlite3" > /dev/null ;;
  b)   # default trust DB/dir absent
    SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
  b0)  # no trust DB anywhere: receipt written to a throwaway path outside R and D, then that path is deleted
    SEED "$R/session-messages.sqlite3" "$BASE/throwaway/trust.sqlite3" > "$BASE/seed.json"; rm -rf "$BASE/throwaway" ;;
  c-same) # R == default state directory
    SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
  c2)  # broker auto-spawned by the public CLI (env inherited)
    SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
esac
echo "seed: $(cat $BASE/seed.json)"
ENVB=(env -i PATH="$PATH" HOME="$H")
ENVC=(env -i PATH="$PATH" HOME="$H" AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR="$R")
echo "--- default dir before (taken before any observation):"; dstate | tee "$BASE/d-before.txt"
echo "--- before"; dumpsafe
if [ "$CASE" != c2 ]; then
  echo "cmd: env -i PATH HOME=$H node $INST/mcp-server/dist/session-message-broker.mjs --state-directory $R  (cwd=$INST)"
  ( cd "$INST" && exec "${ENVB[@]}" node mcp-server/dist/session-message-broker.mjs --state-directory "$R" ) & BP=$!
  for i in $(seq 1 100); do [ -f "$R/endpoint.json" ] && break; sleep 0.1; done
  echo "endpoint present: $([ -f "$R/endpoint.json" ] && echo yes || echo no)"
fi
P=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' "$BASE/seed.json")
echo "cmd: echo '<payload>' | env -i PATH HOME=$H AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$R node $INST/mcp-server/dist/session-message-cli.mjs"
for n in 1 2; do
  OUT=$(cd "$INST" && echo "$P" | "${ENVC[@]}" node mcp-server/dist/session-message-cli.mjs 2>&1); echo "run$n exit=$? out=$OUT"
  echo "RESULT run$n $(echo "$OUT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);console.log(j.ok===false?"ERROR":String(j.data?.reconciled))}catch{console.log("PARSE_FAIL")}})')"
done
BPID=$(pgrep -f "session-message-broker.mjs --state-directory $R" | head -1)
[ -n "$BPID" ] && echo "broker pid=$BPID env AGENT_GOVERNANCE_* keys: $(tr '\0' '\n' < /proc/$BPID/environ | grep '^AGENT_GOVERNANCE_' | cut -d= -f1 | tr '\n' ' ')|count=$(tr '\0' '\n' < /proc/$BPID/environ | grep -c '^AGENT_GOVERNANCE_')"
echo "--- default dir after (broker live, before dump):"; dstate | tee "$BASE/d-after.txt"
echo "--- after (broker live)"; dumpsafe
pkill -f "session-message-broker.mjs --state-directory $R"; sleep 0.5
echo "--- default dir after broker stop:"; dstate | tee "$BASE/d-after-stop.txt"
if cmp -s "$BASE/d-before.txt" "$BASE/d-after-stop.txt"; then echo "RESULT default_untouched=yes"; else echo "RESULT default_untouched=NO"; diff "$BASE/d-before.txt" "$BASE/d-after-stop.txt"; fi
echo "RESULT R_trust_exists_after=$([ -e "$R/trust.sqlite3" ] && echo yes || echo no)"
echo "RESULT R_trust_files_after=$(ls -A "$R" | grep -c "^trust.sqlite3")"
echo "RESULT default_dir_exists_after=$([ -d "$D" ] && echo yes || echo no)"
} > "$LOG" 2>&1
