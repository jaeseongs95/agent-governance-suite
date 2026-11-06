#!/bin/bash
# Full A/B run: bash main.sh  (after prepare.sh). Claude and Codex go in parallel, each through its own A B B A blocks.
#   BLOCKS=2 (default: 4 conversations per arm and host)   HOSTS="claude codex"   RUNTAG=<tag>   HEAVY_LOCK=<flock path>
# Run it detached (setsid nohup bash main.sh > main.out 2>&1 &) and read progress.log; a block of 8 conversations x 7 turns takes hours.
set -u
. "$(dirname "$0")/lib.sh"
for f in src-A src-B ags-skills.txt; do [ -e "$B/$f" ] || { echo "run prepare.sh first ($f missing)" >&2; exit 2; }; done
export RUNTAG=${RUNTAG:-$(date -u +%Y%m%dT%H%M%SZ)}
export BLOCKS=${BLOCKS:-2}
HOSTS=${HOSTS:-"claude codex"}
echo "START $(date -u +%FT%TZ) runtag=$RUNTAG blocks=$BLOCKS hosts=$HOSTS" >> "$B/progress.log"
for host in $HOSTS; do bash "$B/host-loop.sh" "$host" & done
wait
echo "ALL_DONE $RUNTAG $(date -u +%FT%TZ)" >> "$B/progress.log"
