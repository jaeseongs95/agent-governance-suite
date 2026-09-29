#!/bin/bash
# 10x repeat of the three presence test files at 906a023a (candidate worktree, clean).
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v276d; L=/home/[REDACTED]/v276b/logs; : > $L/repeat10.tsv
for i in $(seq 1 10); do
  pnpm exec vitest run --reporter=verbose tests/session-messaging/presence-deadline.test.ts tests/session-messaging/presence-retention.test.ts tests/session-messaging/presence-batches.test.ts > $L/repeat-$i.log 2>&1; rc=$?
  echo -e "run$i\trc=$rc\t$(grep -E 'Tests +[0-9]' $L/repeat-$i.log | tr -s ' ')\tslow-real-broker:$(grep -E 'slow real broker' $L/repeat-$i.log | grep -oE '[0-9]+ms$')" >> $L/repeat10.tsv
done
echo "leftover-broker-processes=$(ps -eo args | grep -c '[s]ession-message-broker')" >> $L/repeat10.tsv; echo DONE >> $L/repeat10.tsv
