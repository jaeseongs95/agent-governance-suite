import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveHostLocale } from "../../mcp-server/src/i18n.js";
import { intakeHookOutput } from "../../mcp-server/src/intake-hook.js";
import { skillIntakeServerInstructions } from "../../mcp-server/src/server.js";
import { skillIntakePointer, skillIntakeText, skillTargetsContext } from "../../mcp-server/src/skill-intake.js";

// AGS3-D-0032 candidate: a context start carries the pointer and the installed skill targets that each message's cue
// points at, so the list is not repeated with every message.
const contextStart = (locale: "ko" | "en") => [skillIntakePointer(locale), skillTargetsContext(locale)].join(String.fromCharCode(10));

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

  it("uses successful retained reads rather than visibility to decide when to reread", () => {
    const required = {
      ko: [
        "성공적으로 읽은 근거와 본문이 함께 유지될 때만 재읽기를 생략한다",
        "그렇지 않거나 압축으로 근거나 본문을 잃으면",
        "과업 작업 전에 그 절을 읽고 따른다",
        "실패·부분 출력·다른 판본은 성공한 읽기로 세지 않는다",
      ],
      en: [
        "skip rereading only while the current context retains both evidence of a successful read",
        "and that text",
        "Otherwise, including after either is lost to compaction",
        "read that section before task work and follow it",
        "Failed reads, partial output, or another revision do not count as a successful read",
      ],
    };
    for (const locale of ["ko", "en"] as const) {
      const pointer = skillIntakePointer(locale);
      for (const fragment of required[locale]) expect(pointer).toContain(fragment);
      expect(pointer).not.toContain(locale === "ko" ? "보이지 않으면" : "not visible in this conversation");
    }
  });

  it.each(["codex", "antigravity", "claude-code"])("the %s adapter gets the pointer and skill targets at every session start and nowhere else", (host) => {
    for (const source of SOURCES) {
      expect(intakeHookOutput({ hook_event_name: "SessionStart", source, session_id: `intake-${host}`, conversationId: `intake-${host}` }, host, "ko"))
        .toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: contextStart("ko") } });
    }
    for (const input of [
      { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x" },
      { hook_event_name: "Stop", session_id: "s" },
      { hook_event_name: "SessionEnd", session_id: "s" },
      { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "true" } },
    ]) expect(intakeHookOutput(input, host, "ko")).toEqual({});
  });

  it("Codex registers it for every session start, compaction included, with a context limit that holds the pointer and targets", () => {
    const groups = (JSON.parse(readFileSync(path.join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher?: string; hooks: { command: string; additionalContextLimit?: number }[] }[] };
    }).hooks.SessionStart;
    const group = groups.find((entry) => entry.hooks.some((hook) => hook.command.includes("mcp-server/dist/intake-hook.mjs")));
    expect(group).toBeDefined();
    for (const source of SOURCES) expect(new RegExp(group!.matcher!, "u").test(source)).toBe(true);
    const limit = group!.hooks[0]!.additionalContextLimit ?? 0;
    for (const locale of ["ko", "en"] as const) expect(limit).toBeGreaterThanOrEqual(contextStart(locale).length);
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
    // It answers only the turn stage's UserPromptSubmit; PostInvocation's continuity step reaches it too and gets nothing.
    const turnHook = (raw: string) => JSON.parse(raw).hook_event_name === "UserPromptSubmit"
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "TURN-CUE" } }) : "";
    const options = {
      continuityHook: turnHook,
      sessionMessageHook: () => ({}),
      sessionBoardHook: async () => "",
      writeStderr: () => undefined,
      intakeHook: (input: Record<string, unknown>, host: string) => intakeHookOutput(input, host, resolveHostLocale().locale),
    };
    expect(await executeAntigravityHookEvent({ conversationId: "intake-agy-turn", invocationNum: 0, initialNumSteps: 18 }, "PreInvocation", undefined, options))
      .toEqual({ injectSteps: [{ ephemeralMessage: contextStart(resolveHostLocale().locale) }, { ephemeralMessage: "TURN-CUE" }] });
    for (const [event, input] of [
      ["PreInvocation", { conversationId: "intake-agy-turn", invocationNum: 1, initialNumSteps: 21 }],
      ["PreInvocation", { conversationId: "intake-agy-turn" }],
      ["PostInvocation", { conversationId: "intake-agy-turn", invocationNum: 0 }],
    ] as const) expect(await executeAntigravityHookEvent(input, event, undefined, options)).toEqual({});
  });

  // AGS3-D-0068: after each model call the continuity hook runs under PostInvocation's own name (a step inside the
  // turn), and what it adds is a persistent step: a subagent's role context must outlive the next call.
  it("agy runs the continuity step after each model call and keeps its text", async () => {
    const seen: string[] = [];
    await executeAntigravityHookEvent({ conversationId: "agy-step", invocationNum: 2 }, "PostInvocation", undefined, {
      stageRunner: async (stage: string, _event: string, _raw: unknown, currentToolInput: unknown) => {
        seen.push(stage);
        return { output: {}, updatedToolInput: currentToolInput, mutated: false };
      },
    });
    expect(seen).toEqual(["session-message", "continuity"]);

    const echo = (raw: string) => {
      const input = JSON.parse(raw) as { hook_event_name: string; session_id: string };
      return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: `STEP ${input.hook_event_name} ${input.session_id}` } });
    };
    expect(await executeAntigravityHookEvent({ conversationId: "agy-step", invocationNum: 2 }, "PostInvocation", undefined,
      { continuityHook: echo, sessionMessageHook: () => ({}), writeStderr: () => undefined }))
      .toEqual({ injectSteps: [{ systemMessage: { systemMessage: "STEP PostInvocation agy-step" } }] });
  });
});
