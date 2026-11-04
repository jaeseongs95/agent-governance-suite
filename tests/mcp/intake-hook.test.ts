import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveHostLocale } from "../../mcp-server/src/i18n.js";
import { intakeHookOutput } from "../../mcp-server/src/intake-hook.js";
import { skillIntakeServerInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// agy 1.4.12 connects the AGS MCP server and lists its tools, but does not show the server instructions to the model
// (Linux test server, 2026-11-04: quoting the instructions frame without tools gave NONE 2/2, naming plan_workflow and
// start_workflow gave 2/2). The shared intake therefore also travels as session-start hook context on the hosts whose
// package registers the intake hook. The hook itself never asks which host it is: the host adapter decides.
const root = path.resolve(import.meta.dirname, "../..");
type AgyEvent = (raw: Record<string, unknown>, event: string, hook: string | undefined, options: Record<string, unknown>) => Promise<unknown>;
const { executeAntigravityHookEvent } = await import(new URL("../../antigravity-connector/hooks/antigravity-hook-runner.mjs", import.meta.url).href) as { executeAntigravityHookEvent: AgyEvent };
const SOURCES = ["startup", "fork", "clear", "resume", "compact"];

describe("shared session-start intake", () => {
  it("is the same text as the MCP server instructions intake, in both package locales", () => {
    for (const locale of ["ko", "en"] as const) expect(skillIntakeText(locale)).toBe(skillIntakeServerInstructions(locale));
  });

  it.each(["codex", "antigravity", "claude-code"])("the %s adapter gets it at every session start and nowhere else", (host) => {
    for (const source of SOURCES) {
      expect(intakeHookOutput({ hook_event_name: "SessionStart", source, session_id: `intake-${host}`, conversationId: `intake-${host}` }, host, "ko"))
        .toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: skillIntakeText("ko") } });
    }
    for (const input of [
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x" },
      { hook_event_name: "Stop", session_id: "s" },
      { hook_event_name: "SessionEnd", session_id: "s" },
      { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "true" } },
    ]) expect(intakeHookOutput(input, host, "ko")).toEqual({});
  });

  it("Codex registers it for every session start with a context limit that holds the whole text", () => {
    const groups = (JSON.parse(readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher?: string; hooks: { command: string; additionalContextLimit?: number }[] }[] };
    }).hooks.SessionStart;
    const group = groups.find((entry) => entry.hooks.some((hook) => hook.command.includes("mcp-server/dist/intake-hook.mjs")));
    expect(group).toBeDefined();
    for (const source of SOURCES) expect(new RegExp(group!.matcher!, "u").test(source)).toBe(true);
    const limit = group!.hooks[0]!.additionalContextLimit ?? 0;
    for (const locale of ["ko", "en"] as const) expect(limit).toBeGreaterThanOrEqual(skillIntakeText(locale).length);
  });

  it("agy runs the intake stage at session start and injects the text as a system message", async () => {
    const seen: string[] = [];
    await executeAntigravityHookEvent({ conversationId: "intake-agy-stages", hook_event_name: "SessionStart" }, "SessionStart", undefined, {
      stageRunner: async (stage: string, _event: string, _raw: unknown, currentToolInput: unknown) => {
        seen.push(stage);
        return { output: {}, updatedToolInput: currentToolInput, mutated: false };
      },
    });
    expect(seen).toContain("intake");

    const injected = await executeAntigravityHookEvent({ conversationId: "intake-agy-text", hook_event_name: "SessionStart" }, "SessionStart", "intake",
      { intakeHook: (input: Record<string, unknown>, host: string) => intakeHookOutput(input, host, resolveHostLocale().locale) });
    expect(injected).toEqual({ injectSteps: [{ systemMessage: { systemMessage: skillIntakeText(resolveHostLocale().locale) } }] });
  });
});
