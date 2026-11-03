#!/bin/bash
# Full A/B run under the shared heavy lock: the three hosts run in parallel, each through its own blocks.
set -u
B=/home/mcpops/ags-tests/skill-ab
export PATH="/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin:$HOME/.local/bin:$PATH"
TASKS=${TASKS:-"T1 T2 T3 T4 C0"}
echo "START $(date -u +%FT%TZ) tasks=$TASKS" >> "$B/progress.log"
for host in claude codex agy; do bash "$B/host-loop.sh" "$host" $TASKS & done
wait
echo "ALL_DONE $(date -u +%FT%TZ)" >> "$B/progress.log"
