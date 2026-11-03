import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type TaskEnvelopeV1, WorkflowContractError } from "../../contracts/types.js";
import { canonicalJson } from "../../mcp-server/src/convergence-logic.js";
import { render, type StoredMessageRef } from "../../mcp-server/src/i18n.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { LATE_ADOPTION_LABEL, recordMessageRef } from "../../mcp-server/src/workflow-record-messages.js";
import { WorkflowService, type MinimalStartContinuity } from "../../mcp-server/src/workflow-service.js";

// docs/i18n-design.md 3, 6: workflow errors carry messageKey and params, keep root-locale text, and render per locale.
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const workspace = path.resolve(process.platform === "win32" ? "C:\\work\\i18n-repo" : "/work/i18n-repo");

function service(): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator);
}

const continuity: MinimalStartContinuity = { priorFileCount: () => 0, settle: () => undefined, beforeCommit: () => undefined, ownsRoot: () => false };

function task(capabilities: string[]): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0", taskId: "i18n-workflow", objective: "Plan a synthetic task.",
    scope: { included: ["synthetic"], excluded: [] }, acceptanceCriteria: ["The plan is recorded."], riskLevel: "low",
    workUnits: [], requiredCapabilities: capabilities, constraints: [],
    authorization: { allowedActions: [], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
}

const ref = (body: { messageKey?: string; params?: Readonly<Record<string, unknown>> } | null | undefined): StoredMessageRef =>
  ({ key: body?.messageKey ?? "", params: body?.params ?? {} });

describe("workflow error messages", () => {
  it("returns a service error with its key and params and the unchanged English text", () => {
    const result = service().startMinimalWorkflow({ goal: " ", stages: ["minimal-implementation"], acceptanceCriteria: ["done"], workspace }, null, continuity);
    expect(result.error).toEqual({
      code: "INVALID_INPUT", message: "goal must be a non-empty string.",
      messageKey: "workflow.service.goalNonEmptyString", params: {}, details: { field: "goal" },
    });
    expect(render(ref(result.error), "ko")).toBe("goal은 비어 있지 않은 문자열이어야 한다.");
  });

  it("renders a select-built sentence the same as the old template in English and as one sentence in Korean", () => {
    const result = service().startMinimalWorkflow({ goal: "g", stages: [], acceptanceCriteria: ["done"], workspace }, null, continuity);
    expect(result.error).toMatchObject({
      message: "stages must be a non-empty array of distinct non-empty strings.",
      messageKey: "workflow.service.distinctStringArray", params: { field: "stages", size: "nonEmpty" },
    });
    expect(render(ref(result.error), "ko")).toBe("stages은(는) 서로 다르고 비어 있지 않은 문자열로 된 비어 있지 않은 배열이어야 한다.");
  });

  it("keeps a sub-step's key when the minimal start rethrows it (execution subject select)", () => {
    const result = service().startMinimalWorkflow({ goal: "g", stages: ["minimal-implementation"], acceptanceCriteria: ["done"], workspace, writeTargets: ["synthetic"] }, null, continuity);
    expect(result.error).toMatchObject({
      code: "BINDING_REQUIRED", message: "bootstrap orchestration requires trusted host execution attestation.",
      messageKey: "workflow.service.requiresTrustedAttestation", params: { subject: "bootstrapOrchestration", stageId: "" },
    });
    expect(render(ref(result.error), "ko")).toBe("bootstrap 조율: 신뢰할 수 있는 호스트 실행 증명이 필요하다.");
  });

  it("stores plan blockers as keyed bodies", () => {
    const plan = service().planWorkflow(task(["no-such-capability"]));
    const blocker = plan.data?.errors.find(error => error.messageKey === "workflow.service.noProviderForCapability");
    expect(blocker).toEqual({
      code: "GATE_FAILED", message: "No enabled registry descriptor provides 'no-such-capability'.",
      messageKey: "workflow.service.noProviderForCapability", params: { capability: "no-such-capability" }, details: { capability: "no-such-capability" },
    });
    expect(render(ref(blocker), "ko")).toBe("'no-such-capability'을(를) 제공하는 활성 registry descriptor가 없다.");
  });

  it("names a canonical JSON subject through the catalog and shows an unknown one as given", () => {
    const thrown = (subject?: string) => {
      try { canonicalJson(Number.POSITIVE_INFINITY, subject); } catch (error) { return error as WorkflowContractError; }
      throw new Error("canonicalJson accepted a non-finite number");
    };
    expect(thrown().toBody()).toMatchObject({ message: "Convergence input contains a non-finite number.",
      messageKey: "workflow.convergence.nonFiniteNumber", params: { subject: "convergenceInput", label: "Convergence input" } });
    expect(render(ref(thrown().toBody()), "ko")).toBe("convergence 입력: 유한하지 않은 숫자가 들어 있다.");
    expect(thrown("Synthetic receipt").message).toBe("Synthetic receipt contains a non-finite number.");
  });
});

describe("workflow record sentences (workflowRecord, source locale ko)", () => {
  it("maps the stored root-locale text, the Korean text and rows stored before the catalog to one key", () => {
    const expected = { key: "workflowRecord.lateAdoption.constraint", params: { priorFileCount: 3 } };
    expect(recordMessageRef("Late adoption, evidence unverified: product files in this window had already changed before the workflow started (count: 3).")).toEqual(expected);
    // The exact constraint the 3.2.x server stored.
    expect(recordMessageRef("사후 편입·근거 미검증: workflow 시작 전 이 구간에서 제품 파일 3개가 이미 바뀌었다.")).toEqual(expected);
    expect(recordMessageRef("사후 편입·근거 미검증")).toEqual(LATE_ADOPTION_LABEL);
    expect(recordMessageRef("Keep scope fixed.")).toBeNull();
    expect(recordMessageRef("Keep 3 files fixed.")).toBeNull();
  });

  it("renders the label in both shipped locales", () => {
    expect(render(LATE_ADOPTION_LABEL, "ko")).toBe("사후 편입·근거 미검증");
    expect(render(LATE_ADOPTION_LABEL, "en")).toBe("Late adoption, evidence unverified");
  });
});
