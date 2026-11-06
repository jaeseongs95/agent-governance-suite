import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { installedSkillTargets } from "../../mcp-server/src/skill-intake.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// Skills are split by purpose. A skill chosen by the nature of the problem (CS, tests, repeated failures) went unused
// because nothing at the message boundary matched the message against those purposes, and a skill called on an
// earlier turn kept applying to later turns. The per-message cue carries each installed skill's targets and limits an
// earlier skill to the judgment it was called for.
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
  it("lists the purpose of the skills chosen by the nature of the problem, from the installed classification", () => {
    const text = cue();
    // Expected lines written from skills/*/classification.json by hand, not by the function under test.
    expect(text).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(text).toContain("- test-engineering: tests, regression-tests");
    expect(text).toContain("- blocker-diagnostician: failure-episodes, evidence");
    expect(text).toContain("- ponytail: code, libraries, dependencies");
    // The retired skill is not offered.
    expect(text).not.toContain("context-continuity");
  });

  it("asks to match every message, questions included, and to call the matching skills now", () => {
    const ko = cue();
    expect(ko).toContain("스킬은 목적별로 나뉘어 있다.");
    expect(ko).toContain("맞는 스킬은 그 판단·행동 전에 지금 호출한다(질문·확인 요청도 포함한다)");
    const en = cue({ AGENT_GOVERNANCE_LOCALE: "en" });
    expect(en).toContain("call every matching skill now, before that judgment or action (questions and check requests included)");
    // The old notice told the agent to add nothing for a question; a question can still need a skill.
    expect(ko).not.toContain("질문·인사·진행 확인");
    expect(en).not.toContain("a question, a greeting, a progress check");
  });

  it("limits a skill called on an earlier turn to the judgment it was called for and carries the choice to subagents", () => {
    const ko = cue();
    expect(ko).toContain("앞서 호출한 스킬의 지침은 그때의 판단·행동에만 적용된다.");
    expect(ko).toContain("이번 목적에 맞지 않는 이전 스킬 지침은 적용하지 않는다.");
    expect(ko).toContain("독립적으로 완료·검증할 수 있는 일이 있으면 직접 하기 전에 서브에이전트 위임을 검토한다. 맡길 때는 지시문에 목표·범위·금지 구역·쓰기 소유, 고른 스킬과 완료·검증 기준을 적고, 빌드 감시·진행 폴링 같은 대기는 맡기지 않는다.");
    const en = cue({ AGENT_GOVERNANCE_LOCALE: "en" });
    expect(en).toContain("A skill called earlier applies only to the judgment or action it was called for");
    expect(en).toContain("When some work can be completed and verified on its own, consider delegating it to a subagent before doing it yourself. When delegating, write the goal, scope, forbidden areas, write ownership, the chosen skills and the completion and verification criteria in the brief, and do not hand off waiting such as watching a build or polling progress.");
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
