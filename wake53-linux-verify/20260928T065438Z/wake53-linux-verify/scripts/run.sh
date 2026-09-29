#!/bin/bash
# usage: run.sh <logname> <dir> <cmd...>
export PATH=/tmp/node24/bin:$PATH
NAME=$1; LOG=/tmp/ev/$1.log; DIR=$2; shift 2
cd "$DIR"
{ echo "# CMD: $*"; echo "# CWD: $DIR"; echo "# START: $(date -u +%FT%TZ)"; } > "$LOG"
bash -c "$*" >> "$LOG" 2>&1; rc=$?
{ echo "# END: $(date -u +%FT%TZ)"; echo "EXIT=$rc"; } >> "$LOG"
echo "$NAME EXIT=$rc"
