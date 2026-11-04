import { afterEach, describe, expect, it } from "vitest";

import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { skillIntakeServerInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// agy 1.4.12 connects the AGS MCP server and lists its tools but does not show the server instructions to the model
// (Linux test server, 2026-11-04). The shared intake therefore also travels in the common session-start hook context,
// through the same host adapters every host already uses, without a host branch.
const stores: SqliteContinuityStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function service(): ContinuityService {
  const store = new SqliteContinuityStore(":memory:");
  stores.push(store);
  return new ContinuityService(store, new ContractValidator(), new InMemoryWorkflowStore(), () => new Date("2026-11-04T01:00:00.000Z"));
}

function context(output: Record<string, unknown>): string {
  const specific = output.hookSpecificOutput as { hookEventName?: string; additionalContext?: string } | undefined;
  expect(specific?.hookEventName).toBe("SessionStart");
  return specific?.additionalContext ?? "";
}

describe("shared intake at session start", () => {
  it("renders the same text as the MCP server instructions", () => {
    for (const locale of ["ko", "en"] as const) {
      expect(skillIntakeText(locale)).toBe(skillIntakeServerInstructions(locale));
    }
  });

  it.each(["claude-code", "codex", "antigravity"])("%s gets the intake at every session start, ahead of any restore card", (host) => {
    const continuity = service(), session = `intake-${host}`;
    for (const source of ["startup", "clear", "resume", "compact"]) {
      const text = context(handleContinuityHook({ hook_event_name: "SessionStart", source, session_id: session }, continuity, host, {}, "ko"));
      expect(text.startsWith(skillIntakeText("ko"))).toBe(true);
    }
  });

  it("does not add the intake to a turn, a tool boundary or a session end", () => {
    const continuity = service(), session = "intake-other-events";
    const intake = skillIntakeText("ko");
    for (const input of [
      { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "x" },
      { hook_event_name: "Stop", session_id: session },
      { hook_event_name: "SessionEnd", session_id: session },
    ]) {
      expect(JSON.stringify(handleContinuityHook(input, continuity, "codex", {}, "ko"))).not.toContain(JSON.stringify(intake).slice(1, 80));
    }
  });
});
