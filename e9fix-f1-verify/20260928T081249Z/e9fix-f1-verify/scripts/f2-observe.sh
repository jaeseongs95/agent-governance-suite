#!/usr/bin/env bash
# F2 observation only (out of scope): trust DB PRAGMA user_version=99 in R, reconcile through fix install CLI (CLI-spawned broker).
set -u; . /tmp/env.sh
for KIND in codex claude; do
B=/tmp/f2-$KIND; rm -rf $B; R=$B/R; mkdir -p $R $B/home; chmod 700 $R
S=$(cd /tmp/fix && SEED_SRC=/tmp/fix node --import tsx /tmp/ev/scripts/seed.mjs $R/session-messages.sqlite3 $R/trust.sqlite3)
node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA user_version=99");console.log("user_version",d.prepare("PRAGMA user_version").get().user_version);d.close()' $R/trust.sqlite3
P=$(node -e 's=JSON.parse(process.argv[1]);console.log(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' "$S")
for n in 1 2; do echo "$KIND run$n: $(cd /tmp/inst/fix/$KIND && echo "$P" | env -i PATH=$PATH HOME=$B/home AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$R node mcp-server/dist/session-message-cli.mjs)"; done
pkill -f "session-message-broker.mjs --state-directory $R" || true
done
