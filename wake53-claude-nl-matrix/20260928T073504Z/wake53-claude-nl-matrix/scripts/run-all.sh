#!/bin/bash
# sequential matrix; r01 (chat rep1) already run separately
P=/tmp/ev/scripts/prompts
run(){ /tmp/ev/scripts/nl-matrix.sh "$@"; PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH node /tmp/ev/scripts/analyze.mjs /tmp/ev/runs/$1; }
run r02-p1-coding-1 coding fib $P/p1-coding.txt
run r03-p2-review-1 review review $P/p2-review.txt
run r04-p3-explain-1 explain none $P/p3-explain.txt
run r05-p4-multistep-1 multistep proj $P/p4-multistep.txt
run r06-p5a-prose-1 explicit-skill prose $P/p5a-prose.txt
run r07-p5b-ponytail-1 explicit-skill ponytail $P/p5b-ponytail.txt
run r08-p7-highrisk-1 highrisk push $P/p7-highrisk.txt
run r09-p1-coding-2 coding fib $P/p1-coding.txt
run r10-p2-review-2 review review $P/p2-review.txt
run r11-p3-explain-2 explain none $P/p3-explain.txt
run r12-p4-multistep-2 multistep proj $P/p4-multistep.txt
run r13-p5a-prose-2 explicit-skill prose $P/p5a-prose.txt
run r14-p5b-ponytail-2 explicit-skill ponytail $P/p5b-ponytail.txt
run r15-p6-chat-2 chat none $P/p6-chat.txt
run r16-p7-highrisk-2 highrisk push $P/p7-highrisk.txt
echo ALLDONE
