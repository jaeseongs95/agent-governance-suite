#!/bin/bash
# usage: run.sh <logname> <cmd...> ; runs in /tmp/c with Node24 PATH, logs full output + EXIT
N=$1; LOG=/tmp/ev/$1.log; shift
cd /tmp/c
{ echo "# CMD: $*"; echo "# START: $(date -u +%FT%TZ) node=$(node -v)"; } > "$LOG"
"$@" >> "$LOG" 2>&1; rc=$?
echo "# END: $(date -u +%FT%TZ)" >> "$LOG"; echo "EXIT=$rc" >> "$LOG"
echo "$N EXIT=$rc"
