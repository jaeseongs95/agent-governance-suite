#!/bin/bash
# One conversation of all turns in tasks.mjs: RUNTAG=<tag> run-one.sh <claude|codex> <A|B> <rep>
# Appends one JSON line to results.jsonl. The work folder is new for every call (it carries the run tag and is never reused).
# CLAUDE_MODE=resume (default): one `claude -p` process per turn, `--resume <id>` from turn 2.
# CLAUDE_MODE=stream: all turns through one process (claude-stream.mjs). Codex always uses `codex exec resume`.
set -u
. "$(dirname "$0")/lib.sh"
H=$1; A=$2; R=$3
: "${RUNTAG:?set RUNTAG}"
MODE=resume
[ "$H" = claude ] && MODE=${CLAUDE_MODE:-resume}
W=$B/work/$RUNTAG/$H-$A-r$R
if [ -e "$W" ]; then echo "work folder already exists, refusing to reuse it: $W" >&2; exit 2; fi
mkdir -p "$W/state/shared"
node "$B/fixture.mjs" "$W/repo" || { echo "fixture failed" >&2; exit 2; }
N=$(node "$B/tasks.mjs" --count)
export DISABLE_AUTOUPDATER=1 XDG_STATE_HOME="$W/state" AGENT_GOVERNANCE_SHARED_STATE_DIR="$W/state/shared"
touch "$W/marker"
cd "$W/repo" || exit 2

OFF=()
if [ "$H" = codex ]; then
  export RUST_LOG=info
  # Codex starts the MCP server only with variables listed in the plugin's .mcp.json env_vars (3.6.0 and later list the two above).
  while IFS= read -r -d '' flag; do OFF+=("$flag"); done < <(codex_off_flags "$A" 2> "$W/off-flags.err")
fi
HOOKFLAG=()
[ "$H" = claude ] && [ "${CLAUDE_HOOK_EVENTS:-0}" = 1 ] && HOOKFLAG=(--include-hook-events)

SID=""
[ "$H" = claude ] && SID=$(node -e 'console.log(crypto.randomUUID())')
: > "$W/turns.jsonl"

if [ "$MODE" = stream ]; then
  run_locked node "$B/claude-stream.mjs" "$W" "$W/repo" "$TURN_TIMEOUT" --session-id "$SID" --plugin-dir "$B/src-$A/claude-plugin" \
    ${HOOKFLAG[@]+"${HOOKFLAG[@]}"} --permission-mode bypassPermissions --max-turns 30
else
  for n in $(seq 1 "$N"); do
    log=$W/turn-$n.jsonl; err=$W/turn-$n.err
    if [ "$H" = codex ] && [ "$n" -gt 1 ] && [ -z "$SID" ]; then
      echo "{\"turn\":$n,\"skipped\":true,\"reason\":\"turn 1 gave no Codex thread id\"}" >> "$W/turns.jsonl"; continue
    fi
    P=$(node "$B/tasks.mjs" --prompt "$n")
    start=$(date +%s)
    case $H in
      claude)
        if [ "$n" -eq 1 ]; then SESSION=(--session-id "$SID"); else SESSION=(--resume "$SID"); fi
        run_locked timeout "$TURN_TIMEOUT" claude -p "$P" "${SESSION[@]}" --plugin-dir "$B/src-$A/claude-plugin" ${HOOKFLAG[@]+"${HOOKFLAG[@]}"} \
          --permission-mode bypassPermissions --max-turns 30 --output-format stream-json --verbose > "$log" 2> "$err" < /dev/null ;;
      codex)
        COMMON=(--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust)
        if [ "$n" -eq 1 ]; then
          run_locked timeout "$TURN_TIMEOUT" codex ${OFF[@]+"${OFF[@]}"} exec "${COMMON[@]}" -C "$W/repo" "$P" > "$log" 2> "$err" < /dev/null
        else
          # Options go before `resume`; the folder is the shell's current one (cd above), since `-C` is not repeated here.
          run_locked timeout "$TURN_TIMEOUT" codex ${OFF[@]+"${OFF[@]}"} exec "${COMMON[@]}" resume "$SID" "$P" > "$log" 2> "$err" < /dev/null
        fi ;;
    esac
    code=$?
    end=$(date +%s)
    if [ "$H" = codex ] && [ "$n" -eq 1 ]; then
      SID=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) { try { const e = JSON.parse(l); if (e.type === "thread.started") { console.log(e.thread_id); break; } } catch {} }' "$log")
    fi
    echo "{\"turn\":$n,\"exit\":$code,\"seconds\":$((end - start)),\"logBytes\":$(wc -c < "$log")}" >> "$W/turns.jsonl"
  done
fi

node "$B/check.mjs" "$H" "$W" "$B/ags-skills.txt" > "$W/check.json" 2> "$W/check-err.txt" || rm -f "$W/check.json"
touched=$(find "$HOME/.agent-governance-suite" "$HOME/.local/state/agent-governance-suite" -type f -newer "$W/marker" 2> /dev/null | wc -l)
instdiff=$(tr " " "," < "$B/work/$RUNTAG/install-diff-$H-$A-r$R.txt" 2> /dev/null)
dup=$(cat "$W"/turn-*.err "$W"/stream.err 2> /dev/null | grep -c 'skipping duplicate plugin MCP server name')
node "$B/record.mjs" "$B/results.jsonl" "$H" "$A" "$R" "$RUNTAG" "$W" \
  "{\"mode\":\"$MODE\",\"sessionId\":\"$SID\",\"defaultStateFilesTouched\":$touched,\"duplicateMcpWarnings\":$dup,\"installDiff\":\"$instdiff\",\"hookEvents\":\"${CLAUDE_HOOK_EVENTS:-0}\"}"
