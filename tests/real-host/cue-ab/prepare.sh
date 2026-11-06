#!/bin/bash
# Exports both arms from the AGS checkout on the test server and measures their hook text.
#   A_REF=<git ref of the arm that sends the skill list with every message> B_REF=<git ref of the reduced candidate> bash prepare.sh
# Both refs must exist in AGS_REPO (fetch them first). Nothing is installed here; Codex installs happen per run in host-loop.sh.
set -eu
. "$(dirname "$0")/lib.sh"
: "${A_REF:?set A_REF}" "${B_REF:?set B_REF}"
AGS_REPO=${AGS_REPO:-/home/mcpops/ags-tests/claude-5970-311wt}

bash "$B/snapshot.sh" pre
mkdir -p "$B/static" "$B/work"
declare -A REF=([A]=$A_REF [B]=$B_REF)
: > "$B/ags-skills.txt.tmp"
for arm in A B; do
  ref=${REF[$arm]}
  commit=$(git -C "$AGS_REPO" rev-parse --verify "$ref^{commit}")
  rm -rf "${B:?}/src-$arm"; mkdir -p "$B/src-$arm"
  git -C "$AGS_REPO" archive "$commit" | tar -x -C "$B/src-$arm"
  # Codex: a local marketplace under its own name, so it never collides with another test's marketplace.
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.name="ags-cue-"+process.argv[2];j.plugins[0].source={source:"local",path:"./"};require("fs").writeFileSync(f,JSON.stringify(j,null,2))' \
    "$B/src-$arm/.agents/plugins/marketplace.json" "$arm"
  for f in claude-plugin/hooks/hooks.json hooks/hooks.json .codex-plugin/plugin.json claude-plugin/mcp-server/dist/continuity-hook.mjs mcp-server/dist/continuity-hook.mjs; do
    [ -f "$B/src-$arm/$f" ] || { echo "arm $arm ($ref) lacks $f" >&2; exit 1; }
  done
  for s in $(ls -1 "$B/src-$arm/skills"); do
    if [ -f "$B/src-$arm/skills/$s/SKILL.md" ]; then echo "$s" >> "$B/ags-skills.txt.tmp"; fi
  done
  echo "$arm ref=$ref commit=$commit skills=$(git -C "$AGS_REPO" rev-parse "$commit:skills") plugin.json=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$B/src-$arm/.codex-plugin/plugin.json")"
  node "$B/measure-hooks.mjs" claude "$B/src-$arm/claude-plugin" "$B/static/$arm-claude.json"
  node "$B/measure-hooks.mjs" codex "$B/src-$arm" "$B/static/$arm-codex.json"
done
# The union of both arms' skill names: check.mjs uses it to tell AGS skills from other skills, and does not know the arms.
sort -u "$B/ags-skills.txt.tmp" > "$B/ags-skills.txt"; rm -f "$B/ags-skills.txt.tmp"
echo "skills known: $(wc -l < "$B/ags-skills.txt")"

# Claude Code: does this build print hook lifecycle events in stream-json? (The test server's 2.1.314 is unconfirmed.)
if claude --help 2>&1 | grep -q -- '--include-hook-events'; then echo "CLAUDE_HOOK_EVENTS=1" > "$B/capabilities.env"; else echo "CLAUDE_HOOK_EVENTS=0" > "$B/capabilities.env"; fi
cat "$B/capabilities.env"
# The Codex form `codex exec [options] resume <id> <prompt>` is unconfirmed for this build: show what the CLI says.
codex exec resume --help 2>&1 | head -30 > "$B/snapshots/codex-exec-resume-help.txt"
echo "prepared. next: bash $B/main.sh"
