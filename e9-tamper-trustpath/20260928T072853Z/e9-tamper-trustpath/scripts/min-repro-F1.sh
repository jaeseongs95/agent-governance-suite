#!/usr/bin/env bash
# Minimal F1 repro (a2): broker bound to R accepts historical evidence from the DEFAULT trust DB it is not bound to.
# Prereq: /tmp/e9 worktree at e9b4c73 with pnpm install (for seed only); /tmp/install/codex = git archive e9b4c73.
set -eu; export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH
B=$(mktemp -d); H=$B/home; D=$H/.agent-governance-suite/session-messaging; R=$B/R; mkdir -p $R $D; chmod 700 $R
cd /tmp/e9
S=$(node --import tsx /tmp/ev/scripts/seed.mjs $R/session-messages.sqlite3 $D/trust.sqlite3)   # receipt only in DEFAULT trust DB
( cd /tmp/install/codex && env -i PATH=$PATH HOME=$H node mcp-server/dist/session-message-broker.mjs --state-directory $R ) &
for i in $(seq 50); do [ -f $R/endpoint.json ] && break; sleep 0.1; done
P=$(node -e 's=JSON.parse(process.argv[1]);console.log(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' "$S")
echo "$P" | env -i PATH=$PATH HOME=$H AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$R node /tmp/install/codex/mcp-server/dist/session-message-cli.mjs
echo "R/trust.sqlite3 exists: $([ -e $R/trust.sqlite3 ] && echo yes || echo no)  (broker wake reader is bound to this path)"
pkill -f "session-message-broker.mjs --state-directory $R"
# Expected (secure): reconciled=false.  Observed at e9b4c73: reconciled=true (evidence read from $D/trust.sqlite3).
