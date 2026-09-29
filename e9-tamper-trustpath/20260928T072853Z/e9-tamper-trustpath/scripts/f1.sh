#!/usr/bin/env bash
# F1 real-process reproduction. Usage: f1.sh <case> <outlog>
set -u
export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH
CASE=$1; LOG=$2; INST=${INST:-/tmp/install/codex}
BASE=/tmp/f1/$CASE; rm -rf "$BASE"; mkdir -p "$BASE/home"
H=$BASE/home; D=$H/.agent-governance-suite/session-messaging   # default state dir => default trust path D/trust.sqlite3
R=$BASE/R
case $CASE in c-same) R=$D;; esac
mkdir -p "$R"; chmod 700 "$R"
SEED="node --import tsx /tmp/ev/scripts/seed.mjs"
{
echo "## CASE=$CASE INST=$INST"; echo "R=$R"; echo "DEFAULT_TRUST=$D/trust.sqlite3"
cd /tmp/e9
case $CASE in
  a1-receipt-in-R-other-default)  # valid evidence only in R (broker-bound); default has an unrelated trust DB
    $SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json"
    mkdir -p "$D"; SEED_NONCE=unrelated-nonce-abcdefghijklmnop $SEED "$BASE/other-session.sqlite3" "$D/trust.sqlite3" > /dev/null ;;
  a2-receipt-only-in-default)     # valid evidence only in the default (NOT broker-bound) trust DB; R has its own unrelated trust DB
    $SEED "$R/session-messages.sqlite3" "$D/trust.sqlite3" > "$BASE/seed.json"
    SEED_NONCE=unrelated-nonce-abcdefghijklmnop $SEED "$BASE/other-session.sqlite3" "$R/trust.sqlite3" > /dev/null ;;
  b-no-default)                   # default trust DB absent
    $SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
  c-same)                         # R == default state directory
    $SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
  c2-cli-spawned)                 # broker auto-spawned by the public CLI (env inherited)
    $SEED "$R/session-messages.sqlite3" "$R/trust.sqlite3" > "$BASE/seed.json" ;;
esac
echo "seed: $(cat $BASE/seed.json)"
ENVB=(env -i PATH="$PATH" HOME="$H")          # broker env: no AGENT_GOVERNANCE_* vars
ENVC=(env -i PATH="$PATH" HOME="$H" AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR="$R")
echo "--- before"; node /tmp/ev/scripts/dump.mjs "$R/session-messages.sqlite3" "$R/trust.sqlite3" "$D/trust.sqlite3"
if [ "$CASE" != c2-cli-spawned ]; then
  echo "cmd: env -i PATH HOME=$H node $INST/mcp-server/dist/session-message-broker.mjs --state-directory $R  (cwd=$INST)"
  ( cd "$INST" && "${ENVB[@]}" node mcp-server/dist/session-message-broker.mjs --state-directory "$R" ) & BP=$!
  for i in $(seq 1 50); do [ -f "$R/endpoint.json" ] && break; sleep 0.1; done
  echo "endpoint present: $([ -f "$R/endpoint.json" ] && echo yes || echo no)"
  echo "broker env AGENT_GOVERNANCE_* keys: $(tr '\0' '\n' < /proc/$(pgrep -f "session-message-broker.mjs --state-directory $R" | head -1)/environ 2>/dev/null | grep -c '^AGENT_GOVERNANCE_')"
fi
P=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' "$BASE/seed.json")
echo "cmd: echo '$P' | env -i PATH HOME=$H AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$R node $INST/mcp-server/dist/session-message-cli.mjs"
for n in 1 2; do
  OUT=$(cd "$INST" && echo "$P" | "${ENVC[@]}" node mcp-server/dist/session-message-cli.mjs); echo "run$n exit=$? out=$OUT"
done
echo "--- after"; node /tmp/ev/scripts/dump.mjs "$R/session-messages.sqlite3" "$R/trust.sqlite3" "$D/trust.sqlite3"
pkill -f "session-message-broker.mjs --state-directory $R" ; sleep 0.3
echo "default dir exists after: $([ -d "$D" ] && echo yes || echo no); files: $(ls -A "$D" 2>/dev/null | tr '\n' ' ')"
} > "$LOG" 2>&1
