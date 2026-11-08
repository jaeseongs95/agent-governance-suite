import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const flat = (text: string) => text.replace(/\s+/gu, " ");

function task(capabilities: string[]): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "minimal-implementation-routing",
    objective: "Make the requested change with the smallest complete result.",
    scope: { included: ["docs/**"], excluded: [] },
    acceptanceCriteria: ["The change works."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Make the change.", dependencies: [], writeTargets: ["docs/guide.md"] }],
    requiredCapabilities: capabilities,
    constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: true },
  };
}

function plannedCapabilities(capabilities: string[]): Array<{ capability: string; order: number; skillId: string }> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const planned = service.planWorkflow(task(capabilities));
  expect(planned.error).toBeNull();
  return planned.data!.stages.map((stage) => ({ capability: stage.requiredCapability, order: stage.order, skillId: stage.skillId }));
}

describe("minimal-implementation at the implementation step", () => {
  it("routes the minimal-implementation capability to the AGS skill after the scope baseline and before the pre-mutation gate and scope verification", () => {
    const stages = plannedCapabilities(["change-scope-assurance", "minimal-implementation", "mutation-risk-preflight", "change-scope-baseline-capture"]);
    expect(stages.map((stage) => stage.capability)).toEqual([
      "change-scope-baseline-capture",
      "minimal-implementation",
      "mutation-risk-preflight",
      "change-scope-assurance",
    ]);
    expect(stages.find((stage) => stage.capability === "minimal-implementation")?.skillId).toBe("minimal-implementation");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { skills: Array<{ skillId: string; providers: Array<{ capabilities: string[]; phase: string; phaseOrder: number }> }> };
    expect(registry.skills.some((skill) => skill.skillId === "ponytail")).toBe(false);
    const provider = registry.skills.find((skill) => skill.skillId === "minimal-implementation")!.providers[0]!;
    expect(provider).toMatchObject({ capabilities: ["minimal-implementation"], phase: "implementation", phaseOrder: 44 });
  });

  it("keeps the implementation-stage boundaries in the shared and Claude orchestrator copies", () => {
    for (const copy of ["skills/orchestrator/SKILL.md", "claude-plugin/skills/orchestrator/SKILL.md"]) {
      const text = `${readFileSync(`${root}${copy}`, "utf8")}\n${readFileSync(`${root}${copy.replace("SKILL.md", "references/entry-details.md")}`, "utf8")}`;
      expect(text).toContain("이 단계는 변경 전 기준선 뒤, 위험한 상태 변경의 사전 점검과 범위·수용 근거 확인 전에 실행된다.");
      expect(text).toContain("배포·태그처럼 별도 승인 경계에 있는 작업은 필요한 사전 점검 뒤에 실행한다.");
      expect(text).toContain("시험 실행, 되돌릴 수 있는 작업 사본 저장과 자동 검사 실행(예: 작업 브랜치의 커밋·push, CI)에는 추가 PRE나 승인을 요구하지 않는다.");
      expect(text).not.toContain("배포·push·태그처럼 사전 점검 대상인 작업은 사전 점검 뒤에 실행하고");
      expect(text).toContain("범위와 수용 기준은 명시적 요청으로 보고 줄이지 않으며");
      expect(text).toContain("작업 계약이 없으면 사용자 요청이 정한 범위를 같은 기준으로 삼는다.");
      expect(text).not.toMatch(/ponytail/u);
    }
  });

  it("applies to every kind of deliverable, not only code, and stays out of reviews and answers on both hosts", () => {
    for (const copy of ["skills/minimal-implementation/SKILL.md", "claude-plugin/skills/minimal-implementation/SKILL.md"]) {
      const text = flat(readFileSync(`${root}${copy}`, "utf8"));
      expect(text).toContain("결과물의 종류(코드, 문서, 데이터, 설정, 절차, 디자인)는 가리지 않는다.");
      expect(text).toContain("결과물을 만들거나 바꾸는 응답에 적용한다.");
      expect(text).toContain("검토·감사·검증·완료 판정, 설명·조사만 하는 답에는 적용하지 않는다.");
      expect(text).toContain("사용자·프로젝트·저장소 지시(보고 형식, 언어, 시험 위치·도구)가 출력·시험 규칙보다 우선한다.");
      expect(text).toContain("명시적으로 요청된 것은 줄이지 않는다.");
      expect(text).toContain("축소판을 내고 원래 요구를 원하느냐고 되묻지 않는다.");
    }
    for (const agent of ["independent-auditor", "deliberation-reviewer"]) {
      expect(readFileSync(`${root}claude-plugin/agents/${agent}.md`, "utf8")).toMatch(/\ndisallowedTools: Write, Edit, NotebookEdit, Agent, Skill\r?\n/u);
    }
  });

  it("adds no minimal-implementation stage when the plan does not ask for it", () => {
    const stages = plannedCapabilities(["change-scope-baseline-capture", "change-scope-assurance"]);
    expect(stages.map((stage) => stage.capability)).not.toContain("minimal-implementation");
  });

  it("ships as an internal AGS skill with no upstream pin and no always-on hooks", () => {
    expect(existsSync(`${root}skills/ponytail`)).toBe(false);
    expect(readdirSync(`${root}skills/minimal-implementation`).sort()).toEqual(["LICENSE", "SKILL.md", "VERSION", "agents", "classification.json"]);
    expect(readFileSync(`${root}skills/minimal-implementation/VERSION`, "utf8").trim()).toBe("1.0.0");
    const skill = readFileSync(`${root}skills/minimal-implementation/SKILL.md`, "utf8");
    expect(skill).toMatch(/^---\r?\nname: minimal-implementation\r?\n/u);
    expect(skill).toMatch(/\nlicense: MIT\r?\n/u);
    // The Codex skill validator rejects argument-hint; neither copy carries one now that intensity levels are gone.
    expect(skill).not.toMatch(/\nargument-hint:/u);
    expect(readFileSync(`${root}claude-plugin/skills/minimal-implementation/SKILL.md`, "utf8")).not.toMatch(/\nargument-hint:/u);
    const lock = JSON.parse(readFileSync(`${root}skills/source-lock.json`, "utf8")) as { sources: Array<Record<string, unknown>> };
    expect(lock.sources.some((source) => source.skillId === "ponytail")).toBe(false);
    expect(lock.sources.find((source) => source.skillId === "minimal-implementation")).toMatchObject({
      path: "skills/minimal-implementation", version: "1.0.0", updatePolicy: "internal",
    });
    const hooks = readFileSync(`${root}hooks/hooks.json`, "utf8") + readFileSync(`${root}claude-overlay/hooks/hooks.json`, "utf8");
    expect(hooks).not.toMatch(/ponytail|minimal-implementation/iu);
    expect(readFileSync(`${root}claude-overlay/hooks/skill-trigger-hook.mjs`, "utf8")).not.toMatch(/ponytail/iu);
  });
});

describe("substitutes never make a result complete (AGS3-D-0083)", () => {
  it("states the rule in the skill and in the intake every host receives", () => {
    const skill = flat(readFileSync(`${root}skills/minimal-implementation/SKILL.md`, "utf8"));
    expect(skill).toContain("## 대체물로 완료를 만들지 않는다");
    expect(skill).toContain("이런 것이 낸 통과·출력은 완료 근거로 세지 않는다.");
    expect(skill).toContain("기본값은 꺼짐으로 하고, 이름이나 표시로 구분하고, 실제 경로에서 쓰이지 않는지 확인한다.");
    expect(skill).toContain("「완료」로 보고하지 않고 위치(파일·줄·항목), 이유, 실제 경로로 바꿀 조건을 적는다.");
    expect(skill).toContain("오류를 삼키거나 다른 원인·성공 상태로 바꾸지 않는다.");
    const intake = readFileSync(`${root}skills/orchestrator/references/intake.md`, "utf8");
    // Fragments, not the whole sentence: claude-plugin.test.mjs keeps every whole intake sentence in the shared source.
    expect(intake).toContain("모의·고정값·자리 채움·조용한 대체 경로·삼킨 오류가 낸 통과는 근거가 아니며");
    expect(intake).toContain("남은 대체물은 위치와 함께 미검증으로 적는다");
    // The rule sits in check 3 (making, changing and reporting), which applies to every field.
    const check3 = intake.split("\n").find((line) => line.startsWith("3. "))!;
    expect(check3).toContain("삼킨 오류가 낸 통과는 근거가 아니며");
    expect(check3).toContain("남은 대체물은 위치와 함께 미검증으로 적는다");
  });
});

// AGS3-D-0084: the implementation step could not record an actual failure. The provider is found by its capability so
// the same test runs against the pre-fix registry, where it failed.
describe("the implementation step records an actual failure as failed (AGS3-D-0084)", () => {
  function started() {
    const validator = new ContractValidator();
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    // Only an orchestrated plan starts a run; a direct plan is refused by startWorkflow.
    const planned = service.planWorkflow({ ...task(["minimal-implementation"]), orchestration: { requested: true, mcpAvailable: true } });
    expect(planned.error).toBeNull();
    const started = service.startWorkflow(planned.data!);
    expect(started.error).toBeNull();
    const receipt = started.data!;
    const stage = receipt.plan.stages.find((candidate) => candidate.requiredCapability === "minimal-implementation")!;
    return { service, receipt, stage };
  }
  function result(receipt: { runId: string; revision: number }, stageId: string, state: string, status: string, errorCode: string | null) {
    return {
      schemaVersion: "1.0.0",
      runId: receipt.runId,
      stageId,
      expectedRevision: receipt.revision,
      state,
      output: {
        schemaVersion: "1.0.0",
        kind: "output",
        output: { status, summary: `the change ${status}` },
        artifacts: [],
        error: errorCode === null ? null : { code: errorCode, message: errorCode, details: null },
      },
      evidence: [{ artifactId: "run-log", kind: "document", locator: "artifact://minimal-implementation/run-log", verified: true, note: "" }],
      findings: [],
      blockers: [],
      error: errorCode === null ? null : { code: errorCode, message: errorCode, details: null },
    } as never;
  }

  it("records a failed run as failed with GATE_FAILED", () => {
    const { service, receipt, stage } = started();
    expect(service.recordStageResult(result(receipt, stage.stageId, "failed", "failed", "GATE_FAILED")))
      .toMatchObject({ ok: true, data: { state: "failed", error: { code: "GATE_FAILED" } } });
  });

  it("records missing evidence as blocked with MISSING_EVIDENCE", () => {
    const { service, receipt, stage } = started();
    expect(service.recordStageResult(result(receipt, stage.stageId, "blocked", "blocked", "MISSING_EVIDENCE")))
      .toMatchObject({ ok: true, data: { state: "blocked", error: { code: "MISSING_EVIDENCE" } } });
  });

  it("refuses to record a failed run as passed", () => {
    const { service, receipt, stage } = started();
    const recorded = service.recordStageResult(result(receipt, stage.stageId, "passed", "failed", null));
    expect(recorded.ok).toBe(false);
  });
});
