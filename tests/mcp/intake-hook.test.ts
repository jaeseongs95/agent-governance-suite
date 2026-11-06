import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveHostLocale } from "../../mcp-server/src/i18n.js";
import { intakeHookOutput } from "../../mcp-server/src/intake-hook.js";
import { skillIntakeServerInstructions } from "../../mcp-server/src/server.js";
import { skillIntakePointer, skillIntakeText } from "../../mcp-server/src/skill-intake.js";

// agy 1.4.12 connects the AGS MCP server and lists its tools, but does not show the server instructions to the model
// (Linux test server, 2026-11-04: quoting the instructions frame without tools gave NONE 2/2, naming plan_workflow and
// start_workflow gave 2/2). The shared intake therefore also travels as hook context at every context start on the
// hosts whose package registers the intake hook. After agy `/compact` a conversation that got the whole intake at
// session start answered NONE when asked for its first sentence (agy 1.5.0, 2026-11-04; the uncompacted control quoted
// it), so the hook context is a short pointer to the installed intake, repeated at every context start. The hook itself
// never asks which host it is: the host adapter decides what a context start is.
const root = path.resolve(import.meta.dirname, "../..");
type AgyEvent = (raw: Record<string, unknown>, event: string, hook: string | undefined, options: Record<string, unknown>) => Promise<unknown>;
const { executeAntigravityHookEvent } = await import(new URL("../../antigravity-connector/hooks/antigravity-hook-runner.mjs", import.meta.url).href) as { executeAntigravityHookEvent: AgyEvent };
const SOURCES = ["startup", "fork", "clear", "resume", "compact"];

describe("shared context-start intake", () => {
  it("is the same text as the MCP server instructions intake, in both package locales", () => {
    for (const locale of ["ko", "en"] as const) expect(skillIntakeText(locale)).toBe(skillIntakeServerInstructions(locale));
  });

  it("hook context is a short pointer to the installed intake file that holds the intake block", () => {
    // 3.8.0 (AGS3-D-0032): the block lives in references/intake.md; SKILL.md keeps only a pointer line, so invoking the
    // orchestrator skill does not load the intake a second time.
    const installed = path.join(root, "skills", "orchestrator", "references", "intake.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain("<!-- skill-intake:start -->");
    const skill = readFileSync(path.join(root, "skills", "orchestrator", "SKILL.md"), "utf8");
    expect(skill).not.toContain("<!-- skill-intake:");
    expect(skill).toContain("](references/intake.md)");
    for (const locale of ["ko", "en"] as const) {
      const pointer = skillIntakePointer(locale);
      expect(pointer).toContain(installed);
      expect(Buffer.byteLength(pointer, "utf8")).toBeLessThan(Buffer.byteLength(skillIntakeText(locale), "utf8") / 10);
    }
  });

  it.each(["codex", "antigravity", "claude-code"])("the %s adapter gets the pointer at every session start and nowhere else", (host) => {
    for (const source of SOURCES) {
      expect(intakeHookOutput({ hook_event_name: "SessionStart", source, session_id: `intake-${host}`, conversationId: `intake-${host}` }, host, "ko"))
        .toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: skillIntakePointer("ko") } });
    }
    for (const input of [
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x" },
      { hook_event_name: "Stop", session_id: "s" },
      { hook_event_name: "SessionEnd", session_id: "s" },
      { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "true" } },
    ]) expect(intakeHookOutput(input, host, "ko")).toEqual({});
  });

  it("Codex registers it for every session start, compaction included, with a context limit that holds the pointer", () => {
    const groups = (JSON.parse(readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher?: string; hooks: { command: string; additionalContextLimit?: number }[] }[] };
    }).hooks.SessionStart;
    const group = groups.find((entry) => entry.hooks.some((hook) => hook.command.includes("mcp-server/dist/intake-hook.mjs")));
    expect(group).toBeDefined();
    for (const source of SOURCES) expect(new RegExp(group!.matcher!, "u").test(source)).toBe(true);
    const limit = group!.hooks[0]!.additionalContextLimit ?? 0;
    for (const locale of ["ko", "en"] as const) expect(limit).toBeGreaterThanOrEqual(skillIntakePointer(locale).length);
  });

  // agy has no compaction hook event, and PreInvocation's initialNumSteps counts every step and does not drop at
  // compaction (15 -> 18 across `/compact`), so its context start is each turn's first model call (invocationNum 0).
  it("agy gets the pointer at each turn's first model call, the first turn included, as an ephemeral message", async () => {
    const seen: string[] = [];
    await executeAntigravityHookEvent({ conversationId: "intake-agy-stages", hook_event_name: "SessionStart" }, "SessionStart", undefined, {
      stageRunner: async (stage: string, _event: string, _raw: unknown, currentToolInput: unknown) => {
        seen.push(stage);
        return { output: {}, updatedToolInput: currentToolInput, mutated: false };
      },
    });
    expect(seen).toEqual(["session-message", "continuity"]);

    // Behavior 6 (d7585d74): the same first call also runs the turn stage after intake; a stub stands in for the
    // continuity hook here (its cue is covered in antigravity-turn-cue.test.mjs) so no real state store is opened.
    const turnHook = path.join(mkdtempSync(path.join(os.tmpdir(), "ags-intake-turn-")), "turn.mjs");
    writeFileSync(turnHook, "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: \"UserPromptSubmit\", additionalContext: \"TURN-CUE\" } }));\n");
    const options = {
      continuityHookPath: turnHook,
      sessionMessageHook: () => ({}),
      spawnSync: () => ({ status: 0 }),
      writeStderr: () => undefined,
      intakeHook: (input: Record<string, unknown>, host: string) => intakeHookOutput(input, host, resolveHostLocale().locale),
    };
    expect(await executeAntigravityHookEvent({ conversationId: "intake-agy-turn", invocationNum: 0, initialNumSteps: 18 }, "PreInvocation", undefined, options))
      .toEqual({ injectSteps: [{ ephemeralMessage: skillIntakePointer(resolveHostLocale().locale) }, { ephemeralMessage: "TURN-CUE" }] });
    for (const [event, input] of [
      ["PreInvocation", { conversationId: "intake-agy-turn", invocationNum: 1, initialNumSteps: 21 }],
      ["PreInvocation", { conversationId: "intake-agy-turn" }],
      ["PostInvocation", { conversationId: "intake-agy-turn", invocationNum: 0 }],
    ] as const) expect(await executeAntigravityHookEvent(input, event, undefined, options)).toEqual({});
  });
});
