#!/bin/bash
# Randomized-order repeats of interaction-focused test files. Seeds fixed and recorded.
FILES="tests/session-messaging tests/session-board tests/mcp/trust-provenance.test.ts tests/mcp/tool-schema-profile.test.ts tests/tooling/skill-context-optimization.test.mjs tests/tooling/claude-plugin.test.mjs"
for s in 11 272 4242 53053 99991; do
  RUN_DIR=/tmp/combo /tmp/ev/scripts/run.sh 40-shuffle-seed$s pnpm exec vitest run $FILES --sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=$s --reporter=default --reporter=json --outputFile.json=/tmp/ev/40-shuffle-seed$s.json
done
