#!/usr/bin/env bash
# Real-process subset: installed (node_modules-free) CLI auto-spawns broker; env consistent (R == trust dir).
set -u; export PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH; INST=${INST:-/tmp/install/codex}
cd /tmp/e9
for CASE in ${CASES:-control mac-flip trust-user_version-99 trust-missing session-lock-7s session-lock-25s trust-file-0444-nobody trust-dir-0555-nobody}; do
  B=/tmp/pm/$CASE; rm -rf $B; mkdir -p $B/home $B/R; chmod 700 $B/R; R=$B/R
  node --import tsx /tmp/ev/scripts/seed.mjs $R/session-messages.sqlite3 $R/trust.sqlite3 > $B/seed.json
  echo "## CASE=$CASE INST=$INST R=$R"
  case $CASE in
    mac-flip) node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);const r=d.prepare("SELECT receipt_id,receipt_json FROM input_source_receipts").get();const j=JSON.parse(r.receipt_json);j.integrityToken=(j.integrityToken[0]==="A"?"B":"A")+j.integrityToken.slice(1);d.prepare("UPDATE input_source_receipts SET receipt_json=? WHERE receipt_id=?").run(JSON.stringify(j),r.receipt_id);d.close()' $R/trust.sqlite3;;
    trust-user_version-99) node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA user_version=99");d.close()' $R/trust.sqlite3
      echo "contrast: new TrustStore() on this file -> $(node --import tsx -e 'import("/tmp/e9/mcp-server/src/trust-store.ts").then(m=>{try{new m.TrustStore(process.argv[1]);console.log("opened")}catch(e){console.log("THROW "+e.code+" "+e.message)}})' $R/trust.sqlite3)";;
    trust-missing) rm -f $R/trust.sqlite3*;;
    trust-dir-0555) :;;
  esac
  [ -e $R/trust.sqlite3 ] && node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close()' $R/trust.sqlite3
  RUN=(); case $CASE in *-nobody) chown -R 65534:65534 $B; RUN=(setpriv --reuid=65534 --regid=65534 --clear-groups);; esac
  # start broker via CLI ping-less path: first CLI call spawns it. For lock case, pre-spawn broker with a harmless status call.
  P=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(JSON.stringify({operation:"reconcile-wake-observation",payload:{target:s.target,attemptId:s.attemptId,sourceReceiptId:s.sourceReceiptId}}))' $B/seed.json)
  ENVC=("${RUN[@]}" env -i PATH="$PATH" HOME="$B/home" AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR="$R")
  (cd $INST && echo '{"operation":"pending","payload":{"target":{"host":"portable","sessionId":"nobody"}}}' | "${ENVC[@]}" node mcp-server/dist/session-message-cli.mjs >/dev/null)
  case $CASE in trust-dir-0555*) chmod 555 $R;; trust-file-0444*) chmod 444 $R/trust.sqlite3;; esac
  echo "runas=${RUN[*]:-root} perms: $(stat -c "%a %U" $R $R/trust.sqlite3 2>/dev/null | tr "\n" " ")"
  if [[ $CASE = session-lock-* ]]; then H=${CASE#session-lock-}; H=${H%s}; node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec("BEGIN EXCLUSIVE");console.log("LOCKED");setTimeout(()=>{d.exec("ROLLBACK");d.close()},Number(process.argv[2])*1000)' $R/session-messages.sqlite3 $H & sleep 0.5; fi
  ls -la $R | awk '{print $1,$5,$9}' | grep -E 'trust|session-messages' > $B/files-before
  sha256sum $R/trust.sqlite3* 2>/dev/null > $B/sha-before
  START=$(date +%s%3N); OUT=$(cd $INST && echo "$P" | "${ENVC[@]}" node mcp-server/dist/session-message-cli.mjs); EC=$?; END=$(date +%s%3N)
  echo "cli exit=$EC ms=$((END-START)) out=$OUT"
  wait 2>/dev/null
  chmod 755 $R; [ -e $R/trust.sqlite3 ] && chmod 600 $R/trust.sqlite3
  ls -la $R | awk '{print $1,$5,$9}' | grep -E 'trust|session-messages' > $B/files-after
  sha256sum $R/trust.sqlite3* 2>/dev/null > $B/sha-after
  echo "trust files diff:"; diff $B/sha-before $B/sha-after && echo "  (none)"; diff $B/files-before $B/files-after | grep -E '^[<>]' | sed 's/^/  /'
  node /tmp/ev/scripts/dump.mjs $R/session-messages.sqlite3 | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log("wake:",JSON.stringify(o.wake_nonces.map(w=>({state:w.state,observed_at:w.observed_at,consumed_at:w.consumed_at}))),"messages:",JSON.stringify(o.messages),"obs:",o.input_observations)'
  echo "trust exists after: $([ -e $R/trust.sqlite3 ] && echo yes || echo no)"
  if [[ $CASE = session-lock-* ]]; then sleep ${POSTWAIT:-0}; echo "after POSTWAIT=${POSTWAIT:-0}s:"; node /tmp/ev/scripts/dump.mjs $R/session-messages.sqlite3 | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log("wake:",JSON.stringify(o.wake_nonces.map(w=>({state:w.state,observed_at:w.observed_at,consumed_at:w.consumed_at}))))'; fi
  pkill -f "session-message-broker.mjs --state-directory $R"; sleep 0.3
done
