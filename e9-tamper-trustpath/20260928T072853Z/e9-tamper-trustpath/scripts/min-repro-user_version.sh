#!/usr/bin/env bash
# trust DB with PRAGMA user_version=99 (TrustStore refuses to open it) is still accepted by reconcile's read-only reader.
set -eu; export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH
B=$(mktemp -d); R=$B/R; mkdir -p $R $B/home; chmod 700 $R; cd /tmp/e9
S=$(node --import tsx /tmp/ev/scripts/seed.mjs $R/session-messages.sqlite3 $R/trust.sqlite3)
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA user_version=99");d.close()' $R/trust.sqlite3
P=$(node -e 's=JSON.parse(process.argv[1]);console.log(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' "$S")
echo "$P" | env -i PATH=$PATH HOME=$B/home AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$R node /tmp/install/codex/mcp-server/dist/session-message-cli.mjs
pkill -f "session-message-broker.mjs --state-directory $R" || true
# Expected: reconciled=false (schema newer than supported).  Observed at e9b4c73: reconciled=true.
