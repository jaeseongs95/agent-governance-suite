#!/bin/bash
# Extra: v53 cpu1stress x10 (seeds 5001-5010); then v271 baseline wake matrix (same seeds as v53).
F="tests/session-messaging/ tests/session-board/ tests/mcp/trust-provenance"
for i in $(seq 1 10); do s=$((5000+i)); /tmp/ev/scripts/run.sh 53 wake-v53-cpu1stress-s$s $s cpu1stress $F; done
/tmp/ev/scripts/wake-matrix.sh 271
for i in $(seq 1 10); do s=$((5000+i)); /tmp/ev/scripts/run.sh 271 wake-v271-cpu1stress-s$s $s cpu1stress $F; done
