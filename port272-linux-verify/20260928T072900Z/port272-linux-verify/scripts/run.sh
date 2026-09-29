#!/bin/bash
# usage: run.sh <logname> <cmd...>  (cwd = $DIR)
. /tmp/ev/scripts/env.sh
LOG=/tmp/ev/$1.log; shift
cd "${DIR:-/tmp/cand}"
echo "\$ $* (cwd=$PWD, start $(date -u +%FT%TZ))" > "$LOG"
"$@" >> "$LOG" 2>&1; rc=$?
echo "EXIT=$rc" >> "$LOG"; echo "$(basename $LOG .log) EXIT=$rc"
