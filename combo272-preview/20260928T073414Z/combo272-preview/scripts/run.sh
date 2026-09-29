#!/bin/bash
# usage: run.sh <logname> <cmd...>   runs in /tmp/combo with Node24, logs to /tmp/ev/<logname>.log
export PATH=/tmp/node24/bin:$PATH
cd "${RUN_DIR:-/tmp/combo}"
L=/tmp/ev/$1.log; shift
echo "\$ $*" > "$L"; echo "START=$(date -u +%FT%TZ)" >> "$L"
"$@" >> "$L" 2>&1; rc=$?
echo "END=$(date -u +%FT%TZ)" >> "$L"; echo "EXIT=$rc" >> "$L"; echo "$(basename $L) EXIT=$rc"
