#!/bin/bash
# $1 = label; runs the slow-runner variant of the three affected tests
export PATH=/opt/node24/bin:$PATH
S=/tmp/claude-0/-home-user-agent-governance-suite/d12fc7a7-9717-5ea2-a8f9-25ec60e52e75/scratchpad; E=$S/ev274fix4
cd /home/[REDACTED]/agent-governance-suite
python3 $E/harness/slow-runner-variant.py apply
pnpm exec vitest run tests/session-messaging/presence-retention.test.ts -t "342-identity|B1" > $E/logs/slow-variant-$1-retention.log 2>&1; echo "exit=$?" >> $E/logs/slow-variant-$1-retention.log
AGS_PREVIOUS_BROKER_PATH=$S/prev/v2.7.3/mcp-server/dist/session-message-broker.mjs pnpm exec vitest run tests/session-messaging/previous-broker.test.ts -t "batched presence" > $E/logs/slow-variant-$1-previous-broker-v2.7.3.log 2>&1; echo "exit=$?" >> $E/logs/slow-variant-$1-previous-broker-v2.7.3.log
python3 $E/harness/slow-runner-variant.py restore
