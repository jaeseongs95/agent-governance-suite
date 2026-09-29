#!/bin/bash
# previous-broker.test.ts at 906a023a against tag dist brokers, with and without AGS_PREVIOUS_BROKER_VERSION.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v276g; L=/home/[REDACTED]/v276b/logs; R=/home/[REDACTED]/agent-governance-suite; S=$L/previous-broker-summary.tsv; : > $S
for v in v2.7.5 v2.7.4 v2.7.3; do d=/home/[REDACTED]/v276b/prev-$v; mkdir -p $d; git -C $R show $v:mcp-server/dist/session-message-broker.mjs > $d/session-message-broker.mjs; echo -e "$v\tbroker-bytes=$(wc -c < $d/session-message-broker.mjs)\tsha256=$(sha256sum $d/session-message-broker.mjs | cut -c1-16)" >> $S; done
case_() { name=$1; tag=$2; ver=$3; b=/home/[REDACTED]/v276b/prev-$tag/session-message-broker.mjs
  if [ "$ver" = "UNSET" ]; then (echo "=== $name: broker $tag, AGS_PREVIOUS_BROKER_VERSION unset"; env -u AGS_PREVIOUS_BROKER_VERSION AGS_PREVIOUS_BROKER_PATH=$b pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.test.ts 2>&1) > $L/prev-$name.log
  else (echo "=== $name: broker $tag, AGS_PREVIOUS_BROKER_VERSION=$ver"; AGS_PREVIOUS_BROKER_VERSION=$ver AGS_PREVIOUS_BROKER_PATH=$b pnpm exec vitest run --reporter=verbose tests/session-messaging/previous-broker.test.ts 2>&1) > $L/prev-$name.log; fi
  rc=$?; echo -e "$name\t$tag\tversion=$ver\trc=$rc\t$(grep -E 'Tests +[0-9]' $L/prev-$name.log | tr -s ' ')\t$(grep -E '^ +×' $L/prev-$name.log | sed 's/.*> //' | tr '\n' '|')" >> $S; }
case_ P1-v2.7.5-as-2.7.5 v2.7.5 2.7.5
case_ P2-v2.7.4-as-2.7.4 v2.7.4 2.7.4
case_ P3-v2.7.3-as-2.7.3 v2.7.3 2.7.3
case_ P4-v2.7.5-unset v2.7.5 UNSET
case_ P5-v2.7.4-as-2.7.5-lie v2.7.4 2.7.5
case_ P6-v2.7.5-as-2.7.4-lie v2.7.5 2.7.4
case_ P7-v2.7.5-as-v2.7.5 v2.7.5 v2.7.5
case_ P8-v2.7.5-as-2.7-malformed v2.7.5 2.7
case_ P9-v2.7.3-as-2.7.5-lie v2.7.3 2.7.5
echo "leftover-broker-processes=$(ps -eo args | grep -c '[s]ession-message-broker')" >> $S
echo DONE >> $S
