#!/bin/bash
# copies each finished run's Claude transcript into its run dir and re-runs analysis
for d in /tmp/ev/runs/*/; do
  rid=$(basename "$d"); [ -f "$d/exit" ] || continue
  sid=$(sed -n 's/.*session_id=\([0-9a-f-]*\).*/\1/p' "$d/cmd.txt" | head -1)
  src=/tmp/nlwork/$rid/home/.claude/projects/-tmp-nlwork-${rid//./-}-repo/$sid.jsonl
  [ -f "$src" ] && cp "$src" "$d/transcript.jsonl"
  PATH=/tmp/node-v24.21.0-linux-x64/bin:$PATH node /tmp/ev/scripts/analyze.mjs "$d" > "$d/analysis.json" 2> "$d/analyze.err"
done
