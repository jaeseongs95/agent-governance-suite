import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService, renderHookText } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { intakeHookOutput } from "../../mcp-server/src/intake-hook.js";
import { installedSkillTargets, skillIntakeText, skillTargetsContext } from "../../mcp-server/src/skill-intake.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// Skills are split by purpose. A skill chosen by the nature of the problem (CS, tests, repeated failures) went unused
// because nothing at the message boundary matched the message against those purposes, and a skill called on an
// earlier turn kept applying to later turns. Each installed skill's targets and the rule limiting an earlier skill to
// the judgment it was called for reach the agent at every context start; each message's cue points at them.
const session = "d0360-skill-purpose";
const stores = new Set<SqliteContinuityStore>();
const directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function service() {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, new ContractValidator(), new InMemoryWorkflowStore(), () => new Date("2026-11-04T00:00:00.000Z"));
}

function cue(locale: Record<string, string> = {}) {
  const output = handleContinuityHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "x" }, service(), "codex", locale) as
    { hookSpecificOutput?: { additionalContext?: string } };
  return output.hookSpecificOutput?.additionalContext ?? "";
}

function skillsDirectory(skills: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "ags-skill-targets-"));
  directories.push(directory);
  for (const [name, classification] of Object.entries(skills)) {
    mkdirSync(join(directory, name));
    if (classification !== undefined) writeFileSync(join(directory, name, "classification.json"), JSON.stringify(classification));
  }
  return pathToFileURL(directory + "/");
}

describe("per-message skill purpose cue", () => {
  // AGS3-D-0032 candidate: the list and the matching rules travel once per context start (intake hook), and the
  // per-message cue keeps one line that points at them.
  it("lists the purpose of the skills chosen by the nature of the problem, from the installed classification, at context start", () => {
    const text = skillTargetsContext("en");
    // Expected lines written from skills/*/classification.json by hand, not by the function under test.
    expect(text).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(text).toContain("- test-engineering: tests, regression-tests");
    expect(text).toContain("- blocker-diagnostician: failure-episodes, evidence");
    expect(text).toContain("- minimal-implementation: deliverables, documents, data, configuration, procedures, dependencies");
    // The retired skills are not offered.
    expect(text).not.toContain("context-continuity");
    expect(text).not.toContain("ponytail");
    // Every context start carries it, after the intake pointer; it is model-only text in MODEL_LOCALE.
    const start = intakeHookOutput({ hook_event_name: "SessionStart", source: "compact", session_id: session }, "codex") as
      { hookSpecificOutput: { additionalContext: string } };
    expect(start.hookSpecificOutput.additionalContext.endsWith(`\n${text}`)).toBe(true);
    // The per-message cue points at the list instead of repeating it.
    expect(cue()).not.toContain("- minimal-implementation:");
    expect(cue()).toContain("against the skill targets and call each match");
    // The host locale does not change model-only text.
    expect(cue({ AGENT_GOVERNANCE_LOCALE: "ko" })).toBe(cue());
    expect(cue({ AGENT_GOVERNANCE_LOCALE: "en" })).toBe(cue());
  });

  it("asks to match every message, questions included, and to call the matching skills now", () => {
    const message = cue();
    // 4.0.0 (token optimization): the context-start line keeps the per-message matching by the judgment to make; the
    // per-message cue carries "questions included" and "call before that judgment or action" once, on every message.
    expect(skillTargetsContext("en")).toContain("Skill targets. Match each message by the judgment you will make, not names or keywords");
    expect(message).toContain("Before answering or the next tool, match this message (questions and check requests included)");
    expect(message).toContain("call each match before that judgment or action");
    // The old notice told the agent to add nothing for a question; a question can still need a skill.
    expect(message).not.toContain("a question, a greeting, a progress check");
    // The Korean catalog keeps the same rule for a reader of that catalog.
    expect(skillTargetsContext("ko")).toContain("실제로 할 판단으로 메시지마다 대조한다");
    expect(renderHookText(service().checkpointCueForSession(session), "ko"))
      .toContain("이 메시지(질문·확인 요청 포함)를 스킬 대상과 대조해 맞는 스킬을 그 판단·행동 전에 호출하고");
  });

  it("limits a skill called on an earlier turn to the judgment it was called for and carries the choice to subagents", () => {
    const en = skillTargetsContext("en");
    expect(en).toContain("an earlier skill's guidance covers only what it was called for.");
    const ko = skillTargetsContext("ko");
    // One sentence now says both that an earlier skill covers only its own judgment and so not a new purpose.
    expect(ko).toContain("앞서 호출한 스킬의 지침은 그때 호출한 판단·행동에만 적용된다.");
    // 4.0.0 (token optimization): the delegation rule is read in the intake, and the brief requirements in the skill
    // that writes the brief (coordinate-subagents), instead of at every context start.
    // A fragment, not the whole sentence: claude-plugin.test.mjs keeps every whole intake sentence in the shared source.
    expect(skillIntakeText("ko")).toContain("독립 완료·검증 단위는 직접 수행을 기본값으로 삼지 말고 `coordinate-subagents`로 위임 여부를 정한다");
    const coordinate = readFileSync(fileURLToPath(new URL("../../skills/coordinate-subagents/SKILL.md", import.meta.url)), "utf8");
    const description = /^description: (.*)$/mu.exec(coordinate)?.[1] ?? "";
    expect(description).toContain("A brief names goal, scope, forbidden areas, write ownership, chosen skills and completion and verification criteria, and never hands off waiting (watching results, polling).");
  });

  it("derives the list from the installed directories: sorted, skipping directories without classification", () => {
    const directory = skillsDirectory({
      zeta: { targets: ["z-target"] },
      alpha: { targets: ["a-one", "a-two"] },
      notes: undefined,
    });
    expect(installedSkillTargets(directory)).toBe("- alpha: a-one, a-two\n- zeta: z-target");
  });

  it("fails loudly on a classification without targets instead of dropping that skill", () => {
    expect(() => installedSkillTargets(skillsDirectory({ broken: { targets: [] } }))).toThrow("Skill classification has no targets: broken");
    expect(() => installedSkillTargets(skillsDirectory({ broken: { targets: ["ok", 3] } }))).toThrow("broken");
    expect(() => installedSkillTargets(skillsDirectory({ empty: undefined }))).toThrow("No installed skill declares classification targets.");
  });
});
