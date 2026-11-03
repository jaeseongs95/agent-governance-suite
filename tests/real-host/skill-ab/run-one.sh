#!/bin/bash
# One run: run-one.sh <host> <arm> <task> <rep>. Appends one JSON line to results.jsonl.
set -u
H=$1; A=$2; T=$3; R=$4
B=/home/mcpops/ags-tests/skill-ab
W=$B/work/$H-$A-$T-$R
rm -rf "$W"; mkdir -p "$W/state/shared"
node "$B/fixture.mjs" "$T" "$W/repo"
P=$(node "$B/fixture.mjs" --prompt "$T")
cd "$W/repo"
export DISABLE_AUTOUPDATER=1 XDG_STATE_HOME="$W/state" AGENT_GOVERNANCE_SHARED_STATE_DIR="$W/state/shared"
start=$(date +%s)
case $H in
  claude) timeout 900 claude -p "$P" --plugin-dir "$B/src-$A/claude-plugin" --permission-mode bypassPermissions \
            --max-turns 40 --output-format stream-json --verbose > "$W/log.jsonl" 2> "$W/err.txt" < /dev/null ;;
  codex)  timeout 900 codex -c 'plugins."agent-governance-suite@ags-test-7452-21fd-native-r01".enabled=false' \
            -c 'plugins."agent-governance-suite@ags-test-7452-7bc6-d01-r01".enabled=false' \
            exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
            -C "$W/repo" "$P" > "$W/log.jsonl" 2> "$W/err.txt" < /dev/null ;;
  agy)    timeout 900 agy -p "$P" --dangerously-skip-permissions --output-format stream-json --print-timeout 840s \
            > "$W/log.jsonl" 2> "$W/err.txt" < /dev/null ;;
esac
code=$?
end=$(date +%s)
check=$(node "$B/check.mjs" "$T" "$W/repo" "$W/log.jsonl" 2> "$W/check-err.txt" || echo '{"error":"check failed"}')
echo "{\"host\":\"$H\",\"arm\":\"$A\",\"task\":\"$T\",\"rep\":$R,\"exit\":$code,\"seconds\":$((end-start)),\"check\":$check}" >> "$B/results.jsonl"
