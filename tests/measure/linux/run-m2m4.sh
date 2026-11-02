#!/usr/bin/env bash
# M2 (Linux) and M4 runner on the Linux test server. usage: run-m2m4.sh [m4StepSeconds]
set -u
export PATH=/home/mcpops/ags-tests/tester-7452-20261028-r01/runtime/node-v24.22.1-linux-x64/bin:$PATH
W=/home/mcpops/ags-tests/measure-dbms-20261102
cd "$W"
L=$W/logs
mkdir -p "$L" "$W/data"
echo "== m2 $(date -Is)"
rm -rf "$W/run"
node ipc-bench.mjs "$W/run" "$W/data/m2-pg" > "$L/m2-bench.log" 2>&1
echo "m2 exit=$?" >> "$L/m2-bench.log"
echo "== m4 $(date -Is)"
rm -rf "$W/run4"
node m4-load.mjs "$W/run4" "$W/data/m4-pg" "${1:-15}" > "$L/m4-load.log" 2> "$L/m4-load-steps.log"
echo "m4 exit=$?" >> "$L/m4-load.log"
echo "leftover service processes:"; pgrep -af "ipc-service.mjs" || echo none
echo "== done $(date -Is)"
