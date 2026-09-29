#!/bin/bash
# Final-tree mutation run: Q mutants (ported anchors) and wake M1-M4; candidate tests only.
export PATH=/opt/node24/bin:$PATH
WT=/home/[REDACTED]/ags-fmut; OUT=/home/[REDACTED]/final/logs/mutants; mkdir -p $OUT; cd $WT
echo -e "mutant\tapply\tbuild\tcandidate_rc\tcandidate_summary\tfailed_tests" > $OUT/mutants.tsv
apply() {
  case $1 in
    BASELINE) return 0;;
    W-M1-revert-F1-store) git apply -R /home/[REDACTED]/final/wake-M1-F1.patch;;
    W-M2-capability-always-true) sed -i 's/blocksEmptyWakePrompt: host === "codex"/blocksEmptyWakePrompt: true/' mcp-server/src/host-input-adapter.ts; git diff --quiet && return 1 || return 0;;
    W-M3-capability-always-false) sed -i 's/blocksEmptyWakePrompt: host === "codex"/blocksEmptyWakePrompt: false/' mcp-server/src/host-input-adapter.ts; git diff --quiet && return 1 || return 0;;
    W-M4-retired-block-ignores-capability) sed -i 's/if (profile.blocksEmptyWakePrompt \&\& !result.recognized \&\& result.retired === true/if (!result.recognized \&\& result.retired === true/' mcp-server/src/session-message-hook.ts; git diff --quiet && return 1 || return 0;;
    *) python3 /home/[REDACTED]/final/mutants-q-final.py "$WT" "$1";;
  esac
}
for m in BASELINE $(python3 /home/[REDACTED]/final/mutants-q-final.py --list) W-M1-revert-F1-store W-M2-capability-always-true W-M3-capability-always-false W-M4-retired-block-ignores-capability; do
  git checkout -q HEAD -- .
  apply $m > $OUT/$m.apply.log 2>&1; a=$?
  git diff -- mcp-server/src > $OUT/$m.diff
  node scripts/build.mjs > $OUT/$m.build.log 2>&1; b=$?
  timeout 900 npx vitest run tests/session-messaging tests/session-board > $OUT/$m.candidate.log 2>&1; c=$?
  s=$(grep -E "^\s+Tests " $OUT/$m.candidate.log | tail -1 | sed 's/^ *//')
  f=$(grep -E "^ +×|^\s+FAIL " $OUT/$m.candidate.log | grep -c FAIL)
  echo -e "$m\t$a\t$b\t$c\t$s\t$f" >> $OUT/mutants.tsv
done
git checkout -q HEAD -- .; node scripts/build.mjs >/dev/null 2>&1; git status --porcelain > $OUT/final-status.txt
echo done > $OUT/DONE
