#!/bin/bash
# Full vitest suite repeated under normal parallel load; record whether the Korean receipt test fails each time.
export PATH=/opt/node24/bin:$PATH
for wt in /home/[REDACTED]/ags-base /home/[REDACTED]/ags-audit; do
  label=$(basename $wt)
  for i in 1 2 3; do
    cd $wt; pnpm exec vitest run --exclude 'tests/audit/**' > /tmp/claude-full-$label-$i.log 2>&1; rc=$?
    echo "$label full run $i rc=$rc $(grep -E '^ +Tests ' /tmp/claude-full-$label-$i.log | tr -s ' ') leak-test-failed=$(grep -c '× rejects a label leaked' /tmp/claude-full-$label-$i.log)"
    grep -E '×|FAIL' /tmp/claude-full-$label-$i.log | head -5
  done
done
