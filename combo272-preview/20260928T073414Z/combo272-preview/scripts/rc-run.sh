#!/bin/bash
# Reconcile a disposable 2.7.1 state with the clean-room combined CLI (auto-started broker). No user state.
export PATH=/tmp/node24/bin:$PATH
set -u
CLI=/tmp/cr/codex/mcp-server/dist/session-message-cli.mjs
rm -rf /tmp/rc; mkdir -p /tmp/rc/home /tmp/rc/probe
cp -a /tmp/state-271/. /tmp/rc/A/ 2>/dev/null || { mkdir -p /tmp/rc/A && cp -a /tmp/state-271/. /tmp/rc/A/; }
mkdir -p /tmp/rc/B && cp -a /tmp/state-271/. /tmp/rc/B/
cp -a /tmp/state-271/. /tmp/rc/probe/
echo "== probe (separate copy) receipts"; node /tmp/ev/scripts/rc-inspect.mjs /tmp/rc/probe find-receipts > /tmp/ev/71-rc-probe.json; cat /tmp/ev/71-rc-probe.json | node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify(j.receipts));for(const w of j.wake)console.log(JSON.stringify(w))'
ATT() { node -e 'const s=require("/tmp/state-271/exp-state.json");console.log(s.targets[process.argv[1]].oldAttempt.attemptId)' "$1"; }
REC() { node -e 'const j=require("/tmp/ev/71-rc-probe.json");const r=j.receipts.filter(x=>x.sessionId===process.argv[1]);if(r.length!==1)throw new Error("receipts="+r.length);console.log(r[0].receiptId)' "$1"; }
T3A=$(ATT exp-T3-late-unknown); T6A=$(ATT exp-T6-ttl-late); T1A=$(ATT exp-T1-gen-unknown); T3R=$(REC exp-T3-late-unknown); T6R=$(REC exp-T6-ttl-late)
echo "T3 attempt=$T3A receipt=$T3R"; echo "T6 attempt=$T6A receipt=$T6R"; echo "T1 attempt=$T1A"
tgt() { printf '{"host":"codex","sessionId":"%s"}' "$1"; }
call() { # name dir extraEnv json
  local name=$1 dir=$2 extra=$3 json=$4
  echo "== CALL $name"; echo "stdin: $json"
  env -i PATH=$PATH HOME=/tmp/rc/home AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR=$dir $extra node $CLI <<<"$json"; echo "CLI_EXIT=$?"
}
echo "== A before"; node /tmp/ev/scripts/rc-inspect.mjs /tmp/rc/A > /tmp/ev/72-rc-A-before.json
sha256sum /tmp/rc/A/trust.sqlite3
call A1-T6-same-generation /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T6-ttl-late),\"attemptId\":\"$T6A\",\"sourceReceiptId\":\"$T6R\"}}"
call A2-T1-no-late /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T1-gen-unknown),\"attemptId\":\"$T1A\",\"sourceReceiptId\":\"$T3R\"}}"
call A3-T3-wrong-receipt /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T3-late-unknown),\"attemptId\":\"$T3A\",\"sourceReceiptId\":\"$T6R\"}}"
call A4-T3-extra-field /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T3-late-unknown),\"attemptId\":\"$T3A\",\"sourceReceiptId\":\"$T3R\",\"nowMs\":0}}"
call A5-T3-correct /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T3-late-unknown),\"attemptId\":\"$T3A\",\"sourceReceiptId\":\"$T3R\"}}"
call A6-T3-repeat /tmp/rc/A "" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T3-late-unknown),\"attemptId\":\"$T3A\",\"sourceReceiptId\":\"$T3R\"}}"
echo "== B: trust DB path pointed at a nonexistent file"
call B1-T3-missing-trust /tmp/rc/B "AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/rc/B-missing/trust.sqlite3" "{\"operation\":\"reconcile-wake-observation\",\"payload\":{\"target\":$(tgt exp-T3-late-unknown),\"attemptId\":\"$T3A\",\"sourceReceiptId\":\"$T3R\"}}"
echo "B-missing exists after call: $(test -e /tmp/rc/B-missing && echo yes || echo no)"
echo "== brokers running"; pgrep -af "^/tmp/node24/bin/node /tmp/cr/codex/mcp-server/dist/session-message-broker.mjs"
for p in $(pgrep -f "^/tmp/node24/bin/node /tmp/cr/codex/mcp-server/dist/session-message-broker.mjs --state-directory /tmp/rc/"); do kill $p; done; sleep 1
sha256sum /tmp/rc/A/trust.sqlite3; ls -la /tmp/rc/A /tmp/rc/B
node /tmp/ev/scripts/rc-inspect.mjs /tmp/rc/A > /tmp/ev/73-rc-A-after.json
node /tmp/ev/scripts/rc-inspect.mjs /tmp/rc/B > /tmp/ev/74-rc-B-after.json
