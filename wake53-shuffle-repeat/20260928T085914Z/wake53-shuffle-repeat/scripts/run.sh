#!/bin/bash
# usage: run.sh <tree:53|271> <label> <seed> <cond:normal|cpu1|stress> [vitest file filters...]
# Runs vitest with shuffled files+tests and fixed seed; writes JSON + full log to /tmp/ev/runs/.
export PATH=/tmp/node24/bin:$PATH
T=$1; L=$2; S=$3; C=$4; shift 4
mkdir -p /tmp/ev/runs; cd /tmp/v$T || exit 99
PFX=""; STRESS_PIDS=""
case $C in
  cpu1) PFX="taskset -c 0";;
  cpu1stress) PFX="taskset -c 0"; for i in $(seq 1 $(nproc)); do ( taskset -pc 0 $BASHPID >/dev/null; while :; do :; done ) & STRESS_PIDS="$STRESS_PIDS $!"; done;;
  stress) for i in $(seq 1 $(nproc)); do ( while :; do :; done ) & STRESS_PIDS="$STRESS_PIDS $!"; done;;
esac
START=$(date -u +%FT%TZ)
$PFX pnpm test --sequence.shuffle --sequence.seed=$S --reporter=default --reporter=json --outputFile.json=/tmp/ev/runs/$L.json "$@" > /tmp/ev/runs/$L.log 2>&1
RC=$?
[ -n "$STRESS_PIDS" ] && kill $STRESS_PIDS 2>/dev/null
echo "tree=v$T label=$L seed=$S cond=$C start=$START end=$(date -u +%FT%TZ) nproc=$(nproc) cmd='$PFX pnpm test --sequence.shuffle --sequence.seed=$S $*' EXIT=$RC" | tee -a /tmp/ev/runs/$L.log >> /tmp/ev/runs/index.txt
