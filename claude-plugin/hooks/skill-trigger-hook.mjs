#!/usr/bin/env node
// Claude transport for the shared intake. Selection stays in the shared skill.
import { readFileSync } from "node:fs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "SessionStart") {
    const intake = readFileSync(new URL("../skills/orchestrator/SKILL.md", import.meta.url), "utf8")
      .match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)?.[1];
    if (intake) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${intake}\n\nClaude Code 호출: 선택한 설치 스킬은 Skill 도구나 /agent-governance-suite:<skill-name> 명령으로 실제 호출한다.`,
      } }));
    }
  }
} catch {
  // Optional host context must not block the session.
}
