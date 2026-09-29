#!/bin/bash
# Audit-only timing runs of the real slow broker lookup in the candidate worktree (the audit test file is removed afterwards).
export PATH=/opt/node24/bin:$PATH
cd /home/[REDACTED]/ags-v276c; L=/home/[REDACTED]/v276/logs; export AGS_AUDIT_LOG=$L/timing.jsonl; : > $AGS_AUDIT_LOG
T=tests/audit-v276/slow-timing.audit.test.ts
one() { AGS_AUDIT_LABEL=$1 AGS_AUDIT_SLOW_MS=$2 pnpm exec vitest run $T >> $L/timing-vitest.log 2>&1; echo "$1 rc=$?" >> $L/timing-rc.txt; }
: > $L/timing-rc.txt; : > $L/timing-vitest.log
for i in $(seq 1 10); do one normal-1000ms 1000; done
one normal-1900ms 1900
for i in 1 2; do one retry-path-3000ms 3000; done
# CPU saturation: one busy loop per core while the lookup runs.
pids=(); for c in $(seq 1 $(nproc)); do node -e 'for(;;){}' & pids+=($!); done
for i in $(seq 1 5); do one cpu-saturated-1000ms 1000; done
for i in 1 2 3; do AGS_AUDIT_LABEL=x pnpm exec vitest run tests/session-messaging/presence-retention.test.ts --reporter=verbose > $L/cpu-saturated-presence-retention-$i.log 2>&1; echo "cpu-saturated presence-retention run$i rc=$?" >> $L/timing-rc.txt; done
kill "${pids[@]}"
# Slow disk and ptrace overhead: 20 ms after every fsync/fdatasync of vitest and its children.
for i in 1 2 3; do AGS_AUDIT_LABEL=fsync20ms-1000ms AGS_AUDIT_SLOW_MS=1000 strace -f -qq -o /dev/null -e trace=fsync,fdatasync -e inject=fsync,fdatasync:delay_exit=20000 pnpm exec vitest run $T >> $L/timing-vitest.log 2>&1; echo "fsync20ms-1000ms rc=$?" >> $L/timing-rc.txt; done
strace -f -qq -o /dev/null -e trace=fsync,fdatasync -e inject=fsync,fdatasync:delay_exit=20000 pnpm exec vitest run tests/session-messaging/presence-retention.test.ts --reporter=verbose > $L/fsync20ms-presence-retention.log 2>&1; echo "fsync20ms presence-retention rc=$?" >> $L/timing-rc.txt
# Cold start: the first lookup spawns the broker (dist), whose start is delayed.
: > $L/cold-start.jsonl
for d in 0 12000 17000; do node --import tsx /home/[REDACTED]/v276/harness/cold-start-probe.mts /home/[REDACTED]/ags-v276c $d 90 >> $L/cold-start.jsonl 2>> $L/cold-start.err; done
echo DONE >> $L/timing-rc.txt
