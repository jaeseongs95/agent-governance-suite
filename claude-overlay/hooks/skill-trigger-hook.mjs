#!/usr/bin/env node
// Claude transport for the shared intake. Selection stays in the shared skill.
import { readFileSync } from "node:fs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "SessionStart") {
    // The MCP initialization already carries the current shared policy. This adapter adds only host invocation syntax.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "Claude Code 호출: MCP 서버 instructions의 공통 접수 기준을 따르고, 선택한 설치 스킬은 Skill 도구나 /agent-governance-suite:<skill-name> 명령으로 실제 호출한다.",
    } }));
  }
} catch {
  // Optional host context must not block the session.
}
