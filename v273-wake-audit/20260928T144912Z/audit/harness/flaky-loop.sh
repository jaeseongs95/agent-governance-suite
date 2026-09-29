#!/bin/bash
# Run one named test N times in a worktree; print per-run status.
export PATH=/opt/node24/bin:$PATH
wt=$1; n=$2; label=$3
cd $wt
for i in $(seq 1 $n); do
  npx vitest run tests/mcp/korean-prose-cycle-receipt.test.ts -t "rejects a label leaked into the independent adjudicator input" > /tmp/claude-flaky-$label-$i.log 2>&1; rc=$?
  echo "$label run $i rc=$rc $(grep -E 'Tests ' /tmp/claude-flaky-$label-$i.log | tr -s ' ')"
  [ $rc -ne 0 ] && sed -n '1,80p' /tmp/claude-flaky-$label-$i.log
done
