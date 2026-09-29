#!/bin/bash
# utf8-framing.test.ts 10x at fd3f486a. HOME and XDG dirs point at a fresh directory per run; anything the run writes there is listed.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v277c; L=/home/[REDACTED]/v277/logs; : > $L/repeat10.tsv
for i in $(seq 1 10); do
  h=$(mktemp -d /home/[REDACTED]/v277/home-XXXX); before=$(ls /tmp | grep -c '^ags-utf8-framing-')
  HOME=$h XDG_STATE_HOME=$h/state XDG_DATA_HOME=$h/data XDG_CONFIG_HOME=$h/config pnpm exec vitest run --reporter=verbose tests/session-messaging/utf8-framing.test.ts > $L/repeat-$i.log 2>&1; rc=$?
  written=$(cd $h && find . -mindepth 1 -not -path './.cache*' -not -path './.local/share/pnpm*' -not -path './.npm*' | grep -v '^\./\.cache$' | head -5 | tr '\n' ',')
  echo -e "run$i\trc=$rc\t$(grep -E 'Tests +[0-9]' $L/repeat-$i.log | tr -s ' ')\t$(grep -E 'Duration' $L/repeat-$i.log | tr -s ' ')\thome-writes=[$written]\ttmp-left=$(( $(ls /tmp | grep -c '^ags-utf8-framing-') - before ))" >> $L/repeat10.tsv
  rm -rf $h
done
echo "leftover-broker-processes=$(ps -eo args | grep -c '[s]ession-message-broker')" >> $L/repeat10.tsv; echo DONE >> $L/repeat10.tsv
