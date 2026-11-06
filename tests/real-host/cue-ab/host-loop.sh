#!/bin/bash
# All blocks of one host: RUNTAG=<tag> BLOCKS=<n> host-loop.sh <claude|codex>
# One block is A B B A (SEQUENCE can change it for a smoke run). Every run gets a new work folder (run tag + arm + rep). Runs of one host go one after another.
set -u
. "$(dirname "$0")/lib.sh"
H=$1
: "${RUNTAG:?set RUNTAG}"
BLOCKS=${BLOCKS:-2}   # SEQUENCE overrides the order inside a block (smoke runs use SEQUENCE="A")

install_arm() {  # codex only: arm $1, run $2
  codex plugin marketplace add "$B/src-$1" > /dev/null && codex plugin add "agent-governance-suite@ags-cue-$1" > /dev/null || return 1
  # The installed copy must be the arm's tree: count differing files (0 expected).
  local installed
  installed=$(ls -d "$HOME/.codex/plugins/cache/ags-cue-$1/agent-governance-suite"/*/ 2> /dev/null | head -1)
  mkdir -p "$B/work/$RUNTAG"
  echo "$(diff -rq "$B/src-$1/skills" "${installed}skills" 2>&1 | wc -l) $(diff -rq "$B/src-$1/mcp-server/dist" "${installed}mcp-server/dist" 2>&1 | wc -l)" > "$B/work/$RUNTAG/install-diff-$H-$1-r$2.txt"
}
uninstall_arm() {
  codex plugin remove "agent-governance-suite@ags-cue-$1" > /dev/null 2>&1
  codex plugin marketplace remove "ags-cue-$1" > /dev/null 2>&1
  return 0
}

if [ "$H" = codex ]; then
  # A plugin whose name contains a dot cannot be switched off with -c; stop before any run instead of testing a mixed state.
  if codex_off_flags A 2>&1 > /dev/null | grep -q UNDISABLEABLE; then
    echo "codex: another AGS plugin cannot be disabled with -c; remove it or change plan" >&2
    echo "{\"host\":\"codex\",\"runTag\":\"$RUNTAG\",\"preflightFailed\":\"undisableable AGS plugin\"}" >> "$B/results.jsonl"; exit 3
  fi
fi

rep_a=0; rep_b=0
for ((block = 1; block <= BLOCKS; block++)); do
  for arm in ${SEQUENCE:-A B B A}; do
    if [ "$arm" = A ]; then rep_a=$((rep_a + 1)); rep=$rep_a; else rep_b=$((rep_b + 1)); rep=$rep_b; fi
    if [ "$H" = codex ]; then
      if ! install_arm "$arm" "$rep"; then
        echo "{\"host\":\"$H\",\"arm\":\"$arm\",\"rep\":$rep,\"runTag\":\"$RUNTAG\",\"installFailed\":true}" >> "$B/results.jsonl"
        uninstall_arm "$arm"; continue
      fi
    fi
    bash "$B/run-one.sh" "$H" "$arm" "$rep"
    [ "$H" = codex ] && uninstall_arm "$arm"
  done
done
echo "HOST_DONE $H $RUNTAG $(date -u +%FT%TZ)" >> "$B/progress.log"
