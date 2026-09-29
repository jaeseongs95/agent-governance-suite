#!/bin/bash
# SIGKILL the candidate opener at random points during the schema-1 rebuild of a large real v2.7.2 DB.
export PATH=/opt/node24/bin:$PATH
W=/home/[REDACTED]/audit-out/work/crash; mkdir -p $W; rm -f $W/*.sqlite3*
cd /home/[REDACTED]/ags-base && npx tsx audit-harness/make-v272-db.ts $W/golden.sqlite3 400000 >/dev/null
node /home/[REDACTED]/audit-out/harness/snapshot.mjs $W/golden.sqlite3 > $W/golden.json
cd /home/[REDACTED]/ags-audit
# Measure one uninterrupted open.
cp $W/golden.sqlite3 $W/t.sqlite3; s=$(date +%s%3N); npx tsx audit-harness/open-candidate.ts $W/t.sqlite3 >/dev/null; e=$(date +%s%3N); echo "uninterrupted open ms: $((e-s))"
for i in $(seq 1 30); do
  rm -f $W/t.sqlite3*; cp $W/golden.sqlite3 $W/t.sqlite3
  delay=$(( 300 + RANDOM % 1500 ))
  node --import tsx audit-harness/open-candidate.ts $W/t.sqlite3 >/dev/null 2>&1 & pid=$!
  sleep "0.$(printf '%03d' $((delay % 1000)))"; [ $delay -ge 1000 ] && sleep 1
  kill -9 $pid 2>/dev/null; killed=$?; wait $pid 2>/dev/null
  snap=$(node /home/[REDACTED]/audit-out/harness/snapshot.mjs $W/t.sqlite3)
  v=$(echo "$snap" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));const g=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ok=s.integrity==="ok"&&s.wakeRows===g.wakeRows&&s.wakeDigest===g.wakeDigest&&s.messagesDigest===g.messagesDigest&&((s.version===0&&!s.wakeSqlHasRetired&&!s.wakeColumns.includes("retired_at"))||(s.version===1&&s.wakeSqlHasRetired&&s.wakeColumns.includes("retired_at")&&s.indexes.includes("wake_active_target")));console.log(`v=${s.version} rows=${s.wakeRows} integrity=${s.integrity} consistent=${ok}`)' $W/golden.json)
  # Reopen after the crash must succeed and converge on version 1 with identical rows.
  npx tsx audit-harness/open-candidate.ts $W/t.sqlite3 >/dev/null 2>&1; rc=$?
  after=$(node /home/[REDACTED]/audit-out/harness/snapshot.mjs $W/t.sqlite3 | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));const g=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`reopen v=${s.version} same=${s.wakeDigest===g.wakeDigest&&s.wakeRows===g.wakeRows}`)' $W/golden.json)
  echo "run $i delay=${delay}ms killed=$([ $killed = 0 ] && echo yes || echo no-already-exited) $v reopen_rc=$rc $after"
done
