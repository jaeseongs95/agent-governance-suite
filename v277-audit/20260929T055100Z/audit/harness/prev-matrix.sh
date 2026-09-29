#!/bin/bash
# previous-broker.test.ts (fd3f486a) against tag dist brokers; also the 9e76a07b client against the v2.7.6 broker.
export PATH=/opt/node24/bin:$PATH
L=/home/[REDACTED]/v277/logs; R=/home/[REDACTED]/agent-governance-suite; S=$L/previous-broker-summary.tsv; : > $S
for v in v2.7.6 v2.7.5 v2.7.3; do d=/home/[REDACTED]/v277/prev-$v; mkdir -p $d; git -C $R show $v:mcp-server/dist/session-message-broker.mjs > $d/session-message-broker.mjs
  echo -e "$v\tcommit=$(git -C $R rev-parse --short=12 $v^{commit})\tbytes=$(wc -c < $d/session-message-broker.mjs)\tsha256=$(sha256sum $d/session-message-broker.mjs | cut -c1-16)" >> $S; done
case_() { name=$1; wt=$2; tag=$3; ver=$4; b=/home/[REDACTED]/v277/prev-$tag/session-message-broker.mjs
  if [ "$ver" = "UNSET" ]; then (echo "=== $name: worktree $wt, broker $tag, version unset"; cd $wt && env -u AGS_PREVIOUS_BROKER_VERSION AGS_PREVIOUS_BROKER_PATH=$b pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.test.ts 2>&1) > $L/prev-$name.log
  else (echo "=== $name: worktree $wt, broker $tag, AGS_PREVIOUS_BROKER_VERSION=$ver"; cd $wt && AGS_PREVIOUS_BROKER_VERSION=$ver AGS_PREVIOUS_BROKER_PATH=$b pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.test.ts 2>&1) > $L/prev-$name.log; fi
  rc=$?; echo -e "$name\t$tag\tversion=$ver\trc=$rc\t$(grep -E 'Tests +[0-9]' $L/prev-$name.log | tr -s ' ')\t$(grep -E '^ +×' $L/prev-$name.log | sed 's/.*> //' | cut -c1-90 | tr '\n' '|')" >> $S; }
C=/home/[REDACTED]/ags-v277c; B=/home/[REDACTED]/ags-v277b
case_ P1-v2.7.6-as-2.7.6 $C v2.7.6 2.7.6
case_ P2-v2.7.5-as-2.7.5 $C v2.7.5 2.7.5
case_ P3-v2.7.3-as-2.7.3 $C v2.7.3 2.7.3
case_ P4-v2.7.6-unset $C v2.7.6 UNSET
case_ P5-v2.7.6-as-2.7.7-lie $C v2.7.6 2.7.7
# The candidate test file with the 9e76a07b client and source (response side must fail).
git -C $R show fd3f486a:tests/session-messaging/previous-broker.test.ts > $B/tests/session-messaging/previous-broker.test.ts
case_ P6-9e76a07b-client-v2.7.6-as-2.7.6 $B v2.7.6 2.7.6
git -C $B checkout -- tests/session-messaging/previous-broker.test.ts
echo "leftover-broker-processes=$(ps -eo args | grep -c '[s]ession-message-broker')" >> $S; echo DONE >> $S
