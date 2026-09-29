#!/bin/bash
# 20 shuffled runs of session-messaging + stdio-integration test files, seeds 7001-7020
export PATH=/opt/node24/bin:$PATH
FILES="tests/session-messaging tests/mcp/stdio-integration.test.ts"
for s in $(seq 7001 7020); do
  /tmp/ev/scripts/run.sh 25-repeat-seed$s pnpm exec vitest run $FILES --maxWorkers=2 --sequence.shuffle --sequence.seed=$s --reporter=default --reporter=json --outputFile.json=/tmp/ev/25-repeat-seed$s.json
done
