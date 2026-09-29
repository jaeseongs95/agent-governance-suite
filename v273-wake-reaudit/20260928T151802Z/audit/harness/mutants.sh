#!/bin/bash
# Mutation check: apply a mutant to the candidate copy, rebuild dist, run the writer's tests, restore.
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-mut
T="tests/session-messaging/wake-liveness.test.mjs tests/session-messaging/session-message.test.ts"
run() {
  name=$1
  node scripts/build.mjs >/dev/null 2>&1
  npx vitest run $T > /home/[REDACTED]/reaudit/logs/mutant-$name.log 2>&1; rc=$?
  echo "mutant=$name rc=$rc $(grep -E '^ +Tests ' /home/[REDACTED]/reaudit/logs/mutant-$name.log | tr -s ' ')"
  grep -E '^ +×|FAIL ' /home/[REDACTED]/reaudit/logs/mutant-$name.log | sort -u | head -8
  git checkout -q HEAD -- . ; git status --short | grep -v '^??'
}
run baseline-unmutated-rerun
sed -i 's/blocksEmptyWakePrompt: host === "codex"/blocksEmptyWakePrompt: true/' mcp-server/src/host-input-adapter.ts; git diff --stat | tail -1; run M2-capability-always-true
sed -i 's/blocksEmptyWakePrompt: host === "codex"/blocksEmptyWakePrompt: false/' mcp-server/src/host-input-adapter.ts; git diff --stat | tail -1; run M3-capability-always-false
sed -i 's/if (profile.blocksEmptyWakePrompt \&\& !result.recognized \&\& result.retired === true/if (!result.recognized \&\& result.retired === true/' mcp-server/src/session-message-hook.ts; git diff --stat | tail -1; run M4-retired-block-ignores-capability
