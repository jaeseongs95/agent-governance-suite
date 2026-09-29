#!/bin/bash
export PATH=/tmp/node24/bin:$PATH
run() { local n=$1 impl=$2 mode=$3; local root=/tmp/$impl; ( cd $root && node --import tsx /tmp/ev/scripts/fuzz.mjs $impl $mode 1 200 2,4,8 /tmp/ev/$n-$impl-$mode ) > /tmp/ev/$n-$impl-$mode.log 2>&1; echo "EXIT=$?" >> /tmp/ev/$n-$impl-$mode.log; }
date -u > /tmp/ev/run-all.start
run 11 e9 mixed & run 14 v53 mixed & wait
run 12 e9 readonly & run 13 e9 missing & wait
date -u > /tmp/ev/run-all.end
