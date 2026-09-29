#!/bin/bash
# 10x repeat of the presence tests, then previous-broker runs (tag dist brokers), in the candidate worktree.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v276c; L=/home/[REDACTED]/v276/logs; R=/home/[REDACTED]/agent-governance-suite; [ -n "$VERSIONS" ] || : > $L/repeat10.txt
[ -n "$VERSIONS" ] || for i in $(seq 1 10); do
  pnpm exec vitest run tests/session-messaging/presence-deadline.test.ts tests/session-messaging/presence-retention.test.ts tests/session-messaging/presence-batches.test.ts > $L/repeat-$i.log 2>&1; rc=$?
  echo -e "run$i\trc=$rc\t$(grep -E 'Tests +[0-9]' $L/repeat-$i.log | tr -s ' ')\t$(grep -E 'Duration' $L/repeat-$i.log | tr -s ' ')" >> $L/repeat10.txt
done
[ -n "$VERSIONS" ] || echo "leftover-broker-processes=$(ps -eo args | grep -c '[s]ession-message-broker')" >> $L/repeat10.txt
[ -n "$VERSIONS" ] || : > $L/previous-broker-summary.txt
for v in ${VERSIONS:-v2.7.5 v2.7.4 v2.7.3}; do
  git -C $R rev-parse -q --verify "$v^{commit}" >/dev/null || { echo "$v\tMISSING-TAG" >> $L/previous-broker-summary.txt; continue; }
  d=$(mktemp -d /home/[REDACTED]/v276/prev-$v-XXXX); git -C $R show $v:mcp-server/dist/session-message-broker.mjs > $d/session-message-broker.mjs
  c=$(git -C $R rev-parse $v^{commit})
  (echo "=== previous-broker $v ($c), candidate test"; AGS_PREVIOUS_BROKER_PATH=$d/session-message-broker.mjs pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.test.ts 2>&1) > $L/previous-broker-$v.log
  echo -e "$v\tcandidate-test\trc=$?\t$(grep -E 'Tests +[0-9]' $L/previous-broker-$v.log | tr -s ' ')" >> $L/previous-broker-summary.txt
  # The 3706167d version of the test (strict: a managed-wake-aware previous broker must keep the latch).
  git -C $R show 3706167d:tests/session-messaging/previous-broker.test.ts > tests/session-messaging/previous-broker.strict-audit.test.ts
  (echo "=== previous-broker $v ($c), 3706167d strict test"; AGS_PREVIOUS_BROKER_PATH=$d/session-message-broker.mjs pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.strict-audit.test.ts 2>&1) > $L/previous-broker-$v-strict-3706167d-test.log
  echo -e "$v\tstrict-3706167d-test\trc=$?\t$(grep -E 'Tests +[0-9]' $L/previous-broker-$v-strict-3706167d-test.log | tr -s ' ')" >> $L/previous-broker-summary.txt
  rm -f tests/session-messaging/previous-broker.strict-audit.test.ts
done
echo DONE >> $L/previous-broker-summary.txt
