import { describe, expect, it } from "vitest";
import { createClassificationRequest, digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { validateClassificationResponse, validateDecision } from "../../mcp-server/src/skill-classification/validation.js";
import type { ClassificationResult, ClassificationSnapshot, SkillMetadata, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

// Independent synthetic contract oracles; provider semantics and actual hosts remain NOT_RUN.
function fixture(options: { explicit?: string[]; required?: string[]; selected?: string[] | null; disabled?: boolean; dependency?: boolean; mode?: "select" | "shadow"; inventoryCount?: number } = {}) {
  const metadata = (id: string): SkillMetadata => ({ skillId: id, version: "1", description: `synthetic ${id} role`, enabled: true,
    installed: true, hostSupported: true, capabilities: ["read-only-analysis"], actions: ["read-only-analysis"], targets: ["queue"],
    constraints: [], applicability: ["queue invariants"], exclusions: ["general explanation"], dependencies: [], phases: [], sourceRefs: [] });
  const skills = [metadata("cs-engineering"), metadata("test-engineering"), metadata("orchestrator")];
  while (skills.length < (options.inventoryCount ?? 3)) skills.push(metadata(`synthetic-skill-${skills.length}`));
  if (options.disabled) skills[0]!.enabled = false;
  if (options.dependency) skills[0]!.dependencies = ["test-engineering"];
  const request = createClassificationRequest({ requestId: "request-v", operationId: "operation-v", originalPrompt: "읽기 전용으로 분석해 줘. 코드 수정은 하지 마.",
    inventory: { skills, issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "fixture-taxonomy" }, classificationCriteriaRef: "fixture-criteria" });
  const result: ClassificationResult = { request, response: { schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: skills.map(x => ({ skillId: x.skillId,
      judgment: x.skillId === "cs-engineering" ? "needed" : "not-needed", reasonRefs: ["fixture:source-role"], uncertaintyReason: null })), unresolvedItems: [], error: null },
    config: { jevEnabled: true, mode: options.mode ?? "select", providerProfileRegistryRef: "fixture-profiles", externalClassificationAllowed: false, configRevision: "config-1", timeoutMs: 1000 },
    profileRevision: "profile-1", attempts: [], snapshot: { taskRevision: null, configRevision: "config-1", profileRevision: "profile-1", inventoryDigest: request.inventoryDigest,
      requestDigest: request.requestDigest, cancelled: false } };
  const selected = options.selected === undefined ? ["cs-engineering"] : options.selected;
  const decision: SkillSelectionDecisionV1 = { schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(result.response),
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, taskRevision: null, configRevision: "config-1", profileRevision: "profile-1",
    explicitSkillIds: options.explicit ?? [], ruleRequiredSkillIds: options.required ?? [], agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: "mock agent independently inspected the public synthetic request" })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ["fixture:request-role"] })),
    unresolvedSkillReferences: [], selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null,
    hostReceipt: selected === null ? null : { receiptId: "synthetic-only-unit", host: "mock-host", requestDigest: request.requestDigest,
      inventoryDigest: request.inventoryDigest, agentSelectedSkillIds: selected, acceptedAt: "2000-01-01T00:00:00Z" } };
  return { request, result, decision };
}

describe("classification response public validation (SS21/27/29/30)", () => {
  it.each(["SUCCESS", "PARTIAL", "UNCERTAIN"] as const)("rejects empty or omitted judgments in error-free %s responses", status => {
    const f = fixture(), uncertain = { ...f.result.response, status, judgments: f.result.response.judgments.map(x => ({ ...x,
      judgment: "uncertain" as const, uncertaintyReason: "synthetic semantic uncertainty" })), unresolvedItems: [{ skillId: "orchestrator", reasonCode: "SEMANTIC_UNCERTAINTY" }] };
    expect(validateClassificationResponse(f.request, { ...uncertain, judgments: [] })).toContain("MISSING_CANDIDATE_JUDGMENT");
    expect(validateClassificationResponse(f.request, { ...uncertain, judgments: uncertain.judgments.slice(0, 2) })).toContain("MISSING_CANDIDATE_JUDGMENT");
  });
  it("allows complete all-uncertain judgments with reasons but rejects fabricated UNCERTAIN status", () => {
    const f = fixture();
    const full = { ...f.result.response, status: "UNCERTAIN" as const, judgments: f.result.response.judgments.map(x => ({ ...x,
      judgment: "uncertain" as const, uncertaintyReason: "the synthetic request is ambiguous" })) };
    expect(validateClassificationResponse(f.request, full)).toEqual([]);
    expect(validateClassificationResponse(f.request, { ...full, judgments: full.judgments.map(x => ({ ...x, uncertaintyReason: null })) })).toContain("MISSING_UNCERTAINTY_REASON");
    expect(validateClassificationResponse(f.request, { ...f.result.response, status: "UNCERTAIN" })).toContain("MISSING_UNCERTAINTY_EVIDENCE");
    const definiteNoSkill = { ...f.result.response, status: "UNCERTAIN" as const, judgments: f.result.response.judgments.map(x => ({ ...x, judgment: "not-needed" as const })) };
    expect(validateClassificationResponse(f.request, definiteNoSkill)).toContain("MISSING_UNCERTAINTY_EVIDENCE");
  });
  it.each(["UNAVAILABLE", "INVALID", "UNCERTAIN"] as const)("preserves global %s failure without inventing judgments for 24 unobserved candidates", status => {
    const f = fixture({ inventoryCount: 24 });
    const failure = { ...f.result.response, status, judgments: [], unresolvedItems: [{ skillId: null, reasonCode: "TRANSPORT_OUTCOME_UNKNOWN" }],
      error: { code: "TRANSPORT_OUTCOME_UNKNOWN", retryable: false, dispatchState: "unknown" as const } };
    expect(f.request.skills).toHaveLength(24);
    expect(validateClassificationResponse(f.request, failure)).toEqual([]);
    if (status !== "UNCERTAIN") expect(validateClassificationResponse(f.request, { ...failure, error: null })).toContain("FAILURE_WITHOUT_ERROR");
    else expect(validateClassificationResponse(f.request, { ...failure, error: null })).toContain("MISSING_CANDIDATE_JUDGMENT");
  });
  it("validates complete multi-candidate judgments with exact digest bindings", () => {
    const f = fixture();
    expect(validateClassificationResponse(f.request, f.result.response)).toEqual([]);
    expect(validateClassificationResponse(f.request, { ...f.result.response, requestDigest: `sha256:${"b".repeat(64)}` })).toContain("RESPONSE_BINDING_requestDigest");
    expect(validateClassificationResponse(f.request, { ...f.result.response, judgments: f.result.response.judgments.slice(0, 2) })).toContain("MISSING_CANDIDATE_JUDGMENT");
  });
  it("rejects unknown, duplicate and invalid output without creating negative judgments", () => {
    const f = fixture(); const item = f.result.response.judgments[0]!;
    expect(validateClassificationResponse(f.request, { ...f.result.response, judgments: [...f.result.response.judgments, { ...item, skillId: "unregistered" }] })).toContain("UNKNOWN_SKILL_ID");
    expect(validateClassificationResponse(f.request, { ...f.result.response, judgments: [...f.result.response.judgments, item] })).toContain("DUPLICATE_SKILL_ID");
    expect(validateClassificationResponse(f.request, { ...f.result.response, judgments: [{ ...item, reasonRefs: [] }, ...f.result.response.judgments.slice(1)] })).toContain("MISSING_JUDGMENT_REASON");
    expect(validateClassificationResponse(f.request, { ...f.result.response, status: "INVALID", error: null })).toContain("FAILURE_WITHOUT_ERROR");
  });
  it("preserves optional uncertainty as PARTIAL and forbids SUCCESS disguising it", () => {
    const f = fixture();
    const response = { ...f.result.response, status: "PARTIAL" as const, judgments: f.result.response.judgments.map(x => x.skillId === "orchestrator" ?
      { ...x, judgment: "uncertain" as const, uncertaintyReason: "optional phase linking is unclear" } : x), unresolvedItems: [{ skillId: "orchestrator", reasonCode: "OPTIONAL_UNCERTAIN" }] };
    expect(validateClassificationResponse(f.request, response)).toEqual([]);
    expect(validateClassificationResponse(f.request, { ...response, status: "SUCCESS" })).toContain("SUCCESS_WITH_UNRESOLVED_ITEMS");
  });
});

describe("AGENT selection public validation (SS08/15/18/23/34/38)", () => {
  it("cannot disguise an unknown-dispatch UNCERTAIN failure as completed SELECTED", () => {
    const f = fixture(); f.result.response.status = "UNCERTAIN";
    f.result.response.error = { code: "PROVIDER_TIMEOUT", retryable: false, dispatchState: "unknown" };
    f.decision.classificationResponseRef = digestClassificationValue(f.result.response);
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toContain("CLASSIFICATION_UNAVAILABLE_CANNOT_COMPLETE_SELECTION");
  });
  it.each(["UNAVAILABLE", "INVALID"] as const)("cannot mark %s classification as completed SELECTED", status => {
    const f = fixture(); f.result.response.status = status;
    f.result.response.error = { code: "SYNTHETIC_PROVIDER_FAILURE", retryable: false, dispatchState: "not-started" };
    f.decision.classificationResponseRef = digestClassificationValue(f.result.response);
    const checked = validateDecision(f.result, f.decision, f.result.snapshot);
    expect(checked.valid).toBe(false);
    expect(checked.errors).toContain("CLASSIFICATION_UNAVAILABLE_CANNOT_COMPLETE_SELECTION");
  });
  it("accepts independently reasoned final sets without copying provider advice", () => {
    const f = fixture({ selected: ["test-engineering"] });
    const result = validateDecision(f.result, f.decision, f.result.snapshot);
    expect(result.valid).toBe(true);
    expect(result.neededSkillIds).toEqual(["cs-engineering"]);
    expect(result.runnableSkillIds).toEqual(["test-engineering"]);
    expect(f.decision.agentSelectedSkillIds).toEqual(["test-engineering"]);
  });
  it("reports explicit, mandatory and dependency omissions without rewriting selected", () => {
    const f = fixture({ explicit: ["cs-engineering"], required: ["orchestrator"], selected: ["test-engineering"] });
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toEqual(expect.arrayContaining(["REQUIRED_SKILL_OMITTED:cs-engineering", "REQUIRED_SKILL_OMITTED:orchestrator"]));
    expect(f.decision.agentSelectedSkillIds).toEqual(["test-engineering"]);
    const dependency = fixture({ dependency: true });
    expect(validateDecision(dependency.result, dependency.decision, dependency.result.snapshot).errors).toContain("DEPENDENCY_OMITTED:cs-engineering:test-engineering");
  });
  it.each([{ field: "enabled", reason: "DISABLED" }, { field: "installed", reason: "NOT_INSTALLED" }, { field: "hostSupported", reason: "HOST_UNSUPPORTED" }] as const)("keeps needed skill while %s blocks runnable with PARTIAL", ({ field, reason }) => {
    const f = fixture(); f.result.request.skills[0]![field] = false; f.decision.selectionStatus = "PARTIAL";
    const checked = validateDecision(f.result, f.decision, f.result.snapshot);
    expect(checked.valid).toBe(true);
    expect(checked.neededSkillIds).toEqual(["cs-engineering"]);
    expect(checked.runnableSkillIds).toEqual([]);
    expect(checked.blockedItems).toEqual([{ skillId: "cs-engineering", reasonCode: reason }]);
    f.decision.selectionStatus = "SELECTED";
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toContain("UNRESOLVED_SELECTION_MARKED_COMPLETE");
  });
  it("distinguishes unresolved null from accepted empty and rejects missing acceptance", () => {
    const f = fixture({ selected: null });
    expect(validateDecision(f.result, f.decision, f.result.snapshot).valid).toBe(true);
    f.decision.selectionStatus = "SELECTED";
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toContain("SELECTION_NOT_OBSERVED");
    const empty = fixture({ selected: [] });
    expect(validateDecision(empty.result, empty.decision, empty.result.snapshot).valid).toBe(true);
    empty.decision.hostReceipt = null;
    expect(validateDecision(empty.result, empty.decision, empty.result.snapshot).errors).toContain("HOST_RECEIPT_MISMATCH");
  });
  it("requires applicability and selection reasons, detects alias and duplicate IDs", () => {
    const f = fixture(); f.decision.applicabilityChecks = [];
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toContain("APPLICABILITY_UNRESOLVED:cs-engineering");
    f.decision.selectionReasons = [];
    expect(validateDecision(f.result, f.decision, f.result.snapshot).errors).toContain("SELECTION_REASON_MISSING:cs-engineering");
    const alias = fixture({ selected: ["CS"] });
    expect(validateDecision(alias.result, alias.decision, alias.result.snapshot).errors).toContain("UNKNOWN_SELECTED_SKILL:CS");
    const duplicate = fixture({ selected: ["cs-engineering", "cs-engineering"] });
    expect(validateDecision(duplicate.result, duplicate.decision, duplicate.result.snapshot).errors).toContain("DUPLICATE_SELECTED_SKILL");
  });
  it.each(["taskRevision", "configRevision", "profileRevision", "inventoryDigest", "requestDigest"] as const)("rejects stale %s", field => {
    const f = fixture();
    const current: ClassificationSnapshot = { ...f.result.snapshot, [field]: field.endsWith("Digest") ? `sha256:${"f".repeat(64)}` : "new-revision" };
    expect(validateDecision(f.result, f.decision, current).errors).toContain(`STALE_${field}`);
    expect(validateDecision(f.result, f.decision, { ...f.result.snapshot, cancelled: true }).errors).toContain("TASK_CANCELLED");
  });
  it("allows settled independent work despite optional uncertainty, and shadow cannot claim advice applied", () => {
    const f = fixture(); f.result.response.status = "PARTIAL";
    f.result.response.unresolvedItems = [{ skillId: "orchestrator", reasonCode: "OPTIONAL_UNCERTAIN" }];
    f.result.response.judgments[2] = { skillId: "orchestrator", judgment: "uncertain", reasonRefs: [], uncertaintyReason: "optional linking" };
    f.decision.classificationResponseRef = digestClassificationValue(f.result.response); f.decision.selectionStatus = "PARTIAL";
    expect(validateDecision(f.result, f.decision, f.result.snapshot).valid).toBe(true);
    const shadow = fixture({ mode: "shadow" });
    expect(validateDecision(shadow.result, shadow.decision, shadow.result.snapshot).errors).toContain("SHADOW_ADVICE_APPLIED");
    shadow.decision.adviceApplied = false;
    expect(validateDecision(shadow.result, shadow.decision, shadow.result.snapshot).valid).toBe(true);
  });
});
