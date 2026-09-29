#!/usr/bin/env bash
# Mutation probes for the v2.7.3 intake regression tests. Usage: mutations.sh <mutation-worktree> <logdir>
# Each mutant is applied to a disposable detached worktree at the candidate SHA, checked, then restored with git.
set -u
export PATH=/opt/node24/bin:$PATH
W="$1"; L="$2"; mkdir -p "$L"; cd "$W"
S='개념 설명이나 명령 이력 조회는 그 행동을 실행하는 요청이 아니다.'
TESTS="tests/tooling/claude-plugin.test.mjs tests/mcp/tool-schema-profile.test.ts tests/tooling/skill-context-optimization.test.mjs"
restore() { git checkout -q -- . && git clean -fdq && [ -z "$(git status --porcelain)" ] || { echo "RESTORE FAILED"; exit 9; }; }
edit() { node -e '
const fs=require("fs");const [f,a,b,mode]=process.argv.slice(1);let t=fs.readFileSync(f,"utf8");
if(mode==="append"){t+=b;}else{if(!t.includes(a)){console.error("anchor missing in "+f);process.exit(3);}t=t.replace(a,b);}
fs.writeFileSync(f,t);' "$@"; }
check() { # name, regen(0/1)
  local n="$1" regen="$2"
  { git diff --stat; git diff | head -60; } > "$L/$n.diff"
  if [ "$n" != M0-control ] && [ -z "$(git status --porcelain)" ]; then echo "EMPTY-MUTANT (anchor missing)" >> "$L/$n.result"; fi
  if [ "$regen" = 1 ]; then pnpm -s claude:build > "$L/$n.claude-build.log" 2>&1; echo "claude:build=$?" >> "$L/$n.result"; fi
  node scripts/build.mjs > "$L/$n.build.log" 2>&1; echo "build=$?" >> "$L/$n.result"
  npx vitest run $TESTS > "$L/$n.vitest.log" 2>&1; echo "vitest=$?" >> "$L/$n.result"
  pnpm -s claude:check > "$L/$n.claude-check.log" 2>&1; echo "claude:check=$?" >> "$L/$n.result"
  pnpm -s lint > "$L/$n.lint.log" 2>&1; echo "lint=$?" >> "$L/$n.result"
  grep -E '✗|×|FAIL' "$L/$n.vitest.log" | head -12 >> "$L/$n.result"
  echo "== $n"; cat "$L/$n.result"; restore
}
restore
# M0 control: unmodified candidate must pass
check M0-control 0
# M1: copy one common intake sentence into Claude overlay / MCP source / Codex-side files
edit claude-overlay/README.md "" "
- $S
" append; check M1a-overlay-readme-copy 1
edit claude-overlay/adaptations/orchestrator.json '이 절은 호출 방식과 실행 관측만 바꾸며' "$S 이 절은 호출 방식과 실행 관측만 바꾸며"; check M1b-overlay-adaptation-copy 1
edit claude-overlay/hooks/skill-trigger-hook.mjs '명령으로 실제 호출한다.`' "명령으로 실제 호출한다. $S\`"; check M1c-overlay-hook-copy 1
edit mcp-server/src/server.ts '설치된 스킬 호출 방식으로 실행한다.' "설치된 스킬 호출 방식으로 실행한다. $S"; check M1d-mcp-source-copy 0
edit hooks/hooks.json '"hooks": {' "\"x-note\": \"$S\", \"hooks\": {"; check M1e-codex-hooks-copy-probe 0
edit mcp-server/src/plugin-info.ts '' "
// $S
" append; check M1f-other-mcp-source-copy-probe 0
# M2: drop the intake from exactly one schema profile
edit mcp-server/src/server.ts 'export function serverInstructions(): string {
  return `${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}`;' 'export function serverInstructions(profile: ToolSchemaProfile = "anthropic"): string {
  return profile === "anthropic" ? `${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}` : SESSION_MESSAGE_SERVER_INSTRUCTIONS;'
edit mcp-server/src/server.ts 'instructions: serverInstructions() }' 'instructions: serverInstructions(toolSchemaProfile) }'; check M2a-default-profile-drops-intake 0
edit mcp-server/src/server.ts 'export function serverInstructions(): string {
  return `${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}`;' 'export function serverInstructions(profile: ToolSchemaProfile = "default"): string {
  return profile === "default" ? `${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}` : SESSION_MESSAGE_SERVER_INSTRUCTIONS;'
edit mcp-server/src/server.ts 'instructions: serverInstructions() }' 'instructions: serverInstructions(toolSchemaProfile) }'; check M2b-anthropic-profile-drops-intake 0
edit claude-overlay/hooks/skill-trigger-hook.mjs 'additionalContext: `${intake}\n\n' 'additionalContext: `'; check M2c-claude-hook-drops-intake 1
# M3: change one sentence
edit skills/orchestrator/SKILL.md '그 스킬을 직접 호출한다.' '그 스킬을 바로 호출한다.'; check M3a-shared-sentence-changed-regenerated 1
edit claude-plugin/skills/orchestrator/SKILL.md '그 스킬을 직접 호출한다.' '그 스킬을 바로 호출한다.'; check M3b-generated-sentence-changed-only 0
edit claude-overlay/adaptations/orchestrator.json '실제 호출한다. 사용자가' '실제 호출한다. 실패 영향이 낮으면 스킬을 생략한다. 사용자가'; check M3c-overlay-adds-policy-sentence 1
echo done
