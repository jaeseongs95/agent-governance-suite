#!/bin/bash
# Exports both arms from the test checkout: full trees (Claude, Codex) and the agy package subset.
set -eu
B=/home/mcpops/ags-tests/skill-ab
R=/home/mcpops/ags-tests/claude-5970-311wt
declare -A REF=([A]=v3.2.1 [B]=c38319ac)
for arm in A B; do
  ref=${REF[$arm]}
  rm -rf "$B/src-$arm" "$B/agy-$arm"; mkdir -p "$B/src-$arm" "$B/agy-$arm"
  git -C "$R" archive "$ref" | tar -x -C "$B/src-$arm"
  # Codex: a local marketplace with its own name, so it never collides with another test's marketplace.
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.name="ags-ab-"+process.argv[2];j.plugins[0].source={source:"local",path:"./"};require("fs").writeFileSync(f,JSON.stringify(j,null,2))' \
    "$B/src-$arm/.agents/plugins/marketplace.json" "$arm"
  paths=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.paths.join(" "))' "$B/src-$arm/release/antigravity-package.json")
  git -C "$R" archive --prefix=agent-governance-suite/ "$ref" -- $paths ':(exclude,glob)antigravity-connector/**/*.test.mjs' | tar -x -C "$B/agy-$arm"
  echo "$arm $ref $(git -C "$R" rev-parse "$ref^{commit}") skills=$(git -C "$R" rev-parse "$ref:skills")"
done
