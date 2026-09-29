#!/bin/bash
set -u; . /tmp/ev/scripts/env.sh
C=2b53e325f549a9ebd32a143d1d11f7b4393355fa; G="git -C /tmp/cand"
rm -rf /tmp/inst; mkdir -p /tmp/inst/codex /tmp/inst/claude /tmp/inst/state
$G archive $C | tar -x -C /tmp/inst/codex; echo "codex archive EXIT=$?"
$G archive $C:claude-plugin | tar -x -C /tmp/inst/claude; echo "claude archive EXIT=$?"
for t in codex claude; do echo "$t node_modules present: $(find /tmp/inst/$t -name node_modules -maxdepth 3 | wc -l)"; done
echo "== blob check (every archived file vs git blob id)"
for spec in "codex:" "claude:claude-plugin/"; do t=${spec%%:*}; pre=${spec#*:}
  $G ls-tree -r $C:${pre%/} 2>/dev/null >/dev/null || true
  if [ -z "$pre" ]; then $G ls-tree -r $C > /tmp/inst/$t.lstree; else $G ls-tree -r $C:${pre%/} > /tmp/inst/$t.lstree; fi
  bad=0; n=0; nsk=0
  while IFS=$'\t' read -r meta path; do set -- $meta; [ "$2" = blob ] || continue; n=$((n+1)); case "$path" in skills/*) nsk=$((nsk+1));; esac
    f=/tmp/inst/$t/$path
    if [ "$1" = 120000 ]; then h=$(readlink "$f" | tr -d '\n' | git hash-object --stdin); else h=$(git hash-object "$f"); fi
    [ "$h" = "$3" ] || { bad=$((bad+1)); echo "MISMATCH $t $path"; }
  done < /tmp/inst/$t.lstree
  echo "$t: files=$n skills_files=$nsk mismatches=$bad"
done
echo "== dist identity root vs claude-plugin"
for f in mcp-server/dist/server.mjs; do sha256sum /tmp/inst/codex/$f /tmp/inst/claude/$f; done
(cd /tmp/inst/codex/mcp-server/dist && find . -type f | sort | xargs sha256sum) > /tmp/inst/codex.dist.sum
(cd /tmp/inst/claude/mcp-server/dist && find . -type f | sort | xargs sha256sum) > /tmp/inst/claude.dist.sum
diff /tmp/inst/codex.dist.sum /tmp/inst/claude.dist.sum && echo "mcp-server/dist: IDENTICAL ($(wc -l < /tmp/inst/codex.dist.sum) files)"
echo "== runtime identity"; diff -r /tmp/inst/codex/runtime /tmp/inst/claude/runtime && echo "runtime: IDENTICAL"
echo "== contracts identity"; diff -rq /tmp/inst/codex/contracts /tmp/inst/claude/contracts && echo "contracts: IDENTICAL"
echo "== skills: files differing between root skills/ and claude-plugin/skills/"
diff -rq /tmp/inst/codex/skills /tmp/inst/claude/skills
echo "== orchestrator references identity"
for f in /tmp/inst/codex/skills/orchestrator/references/*; do b=$(basename $f); cmp -s $f /tmp/inst/claude/skills/orchestrator/references/$b && echo "SAME $b" || echo "DIFF $b"; done
echo "== link targets in orchestrator SKILL.md resolve (both trees)"
for t in codex claude; do for l in $(grep -oE '\]\((references/[^)#]+)' /tmp/inst/$t/skills/orchestrator/SKILL.md | sed 's/](//' | sort -u); do [ -f /tmp/inst/$t/skills/orchestrator/$l ] && echo "$t OK $l" || echo "$t MISSING $l"; done; done
echo "== MCP probe codex tree"
H=/tmp/inst/state/home-codex; mkdir -p $H
node /tmp/ev/scripts/mcp-probe.mjs /tmp/inst/codex mcp-server/dist/server.mjs "{\"HOME\":\"$H\",\"XDG_STATE_HOME\":\"$H/.state\",\"AGENT_GOVERNANCE_HOST_ATTESTATION\":\"codex\",\"AGENT_GOVERNANCE_DB_PATH\":\"$H/workflows.sqlite3\",\"AGENT_GOVERNANCE_CONTINUITY_DB_PATH\":\"$H/continuity.sqlite3\"}"; echo "codex probe EXIT=$?"
echo "== MCP probe claude tree"
H=/tmp/inst/state/home-claude; D=/tmp/inst/state/claude-data; mkdir -p $H $D
node /tmp/ev/scripts/mcp-probe.mjs /tmp/inst/claude /tmp/inst/claude/mcp-server/dist/server.mjs "{\"HOME\":\"$H\",\"XDG_STATE_HOME\":\"$H/.state\",\"CLAUDE_PLUGIN_ROOT\":\"/tmp/inst/claude\",\"CLAUDE_PLUGIN_DATA\":\"$D\",\"AGENT_GOVERNANCE_DB_PATH\":\"$D/workflows.sqlite3\",\"AGENT_GOVERNANCE_CONTINUITY_DB_PATH\":\"$D/continuity.sqlite3\",\"AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE\":\"anthropic\",\"AGENT_GOVERNANCE_HOST_ATTESTATION\":\"claude-code\"}"; echo "claude probe EXIT=$?"
