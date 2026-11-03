#!/bin/bash
# All blocks of one host: host-loop.sh <host> <tasks...>. Block order A1 B1 B2 A2 A3 B3 (arm:rep).
set -u
H=$1; shift
B=/home/mcpops/ags-tests/skill-ab
install() {
  case $H in
    codex) codex plugin marketplace add "$B/src-$1" > /dev/null && codex plugin add "agent-governance-suite@ags-ab-$1" > /dev/null ;;
    agy)   agy plugin install "$B/agy-$1/agent-governance-suite" > /dev/null ;;
  esac
}
uninstall() {
  case $H in
    codex) codex plugin remove "agent-governance-suite@ags-ab-$1" > /dev/null; codex plugin marketplace remove "ags-ab-$1" > /dev/null ;;
    agy)   agy plugin uninstall agent-governance-suite > /dev/null ;;
  esac
}
for block in A:1 B:1 B:2 A:2 A:3 B:3; do
  arm=${block%%:*}; rep=${block##*:}
  install "$arm" || { echo "{\"host\":\"$H\",\"arm\":\"$arm\",\"rep\":$rep,\"installFailed\":true}" >> "$B/results.jsonl"; continue; }
  for task in "$@"; do bash "$B/run-one.sh" "$H" "$arm" "$task" "$rep"; done
  uninstall "$arm"
done
echo "HOST_DONE $H" >> "$B/progress.log"
