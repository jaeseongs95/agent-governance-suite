#!/bin/bash
# Usage: run-matrix.sh <srcRoot> <ver> <seedFrom> <seedTo> <steps> <parallel>
set -u
SRC=$1; VER=$2; FROM=$3; TO=$4; STEPS=$5; PAR=$6
export PATH=/tmp/node24/bin:$PATH
OUT=/tmp/ev/results-$VER
mkdir -p $OUT
for N in 2 4 8; do
  LOG=/tmp/ev/10-matrix-$VER-n$N.log
  echo "START $(date -u +%FT%TZ) ver=$VER src=$SRC n=$N seeds=$FROM..$TO steps=$STEPS par=$PAR" >> $LOG
  seq $FROM $TO | xargs -P $PAR -I{} sh -c "cd $SRC && node --import tsx --no-warnings /tmp/ev/scripts/orchestrator.mjs $SRC {} $N $STEPS $OUT 2>&1 || echo 'ORCH_EXIT seed={} n=$N code='\$?" >> $LOG
  echo "END $(date -u +%FT%TZ)" >> $LOG
done
