#!/bin/bash
# Per-test durations of presence-retention. Usage: timing.sh <label> [fsync-delay-us]. With a delay, strace injects that
# delay after every fsync/fdatasync of vitest and its children (broker, race processes): a slow-disk runner.
export PATH=/opt/node24/bin:$PATH
label="$1"; delay="${2:-0}"; out="$LOGDIR/timing-$label.log"
cmd=(npx vitest run tests/session-messaging/presence-retention.test.ts --reporter=verbose)
if [ "$delay" != 0 ]; then strace -f -qq -o /dev/null -e trace=fsync,fdatasync -e inject=fsync,fdatasync:delay_exit="$delay" "${cmd[@]}" > "$out" 2>&1
else "${cmd[@]}" > "$out" 2>&1; fi
echo "exit=$?" >> "$out"
grep -E "(✓|×) .*(342-identity|B1:|two processes race)|Tests |exit=" "$out" | sed "s/^/[$label] /"
