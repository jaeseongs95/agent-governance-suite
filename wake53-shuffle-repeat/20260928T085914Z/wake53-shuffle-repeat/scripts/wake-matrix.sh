#!/bin/bash
# Wake-related subset: 30x normal, 10x single CPU (taskset -c 0), 10x with CPU stress (nproc busy loops). Distinct seed per run.
T=${1:-53}
F="tests/session-messaging/ tests/session-board/ tests/mcp/trust-provenance"
for i in $(seq 1 30); do s=$((2000+i)); /tmp/ev/scripts/run.sh $T wake-v$T-normal-s$s $s normal $F; done
for i in $(seq 1 10); do s=$((3000+i)); /tmp/ev/scripts/run.sh $T wake-v$T-cpu1-s$s $s cpu1 $F; done
for i in $(seq 1 10); do s=$((4000+i)); /tmp/ev/scripts/run.sh $T wake-v$T-stress-s$s $s stress $F; done
