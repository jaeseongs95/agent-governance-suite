import {afterEach, describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {ClassificationProviderError, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// TD-002/004, CONC-CANCEL-004, DIST-IDEMPOTENCY-002/RETRY-003/ORDER-004.
// Public service boundary; fake transport/clock only. Provider-live/host selection are NOT_RUN here.
function fixture() {
  const request = createClassificationRequest({requestId: "request", operationId: "operation", originalPrompt: "읽기 전용, 수정 금지. 검토만 해라.",
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경분 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low",
    supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`, qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 50}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {vendor: {approvalRef: "fixture-quota", remainingCalls: 2}}});
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req) => evaluation(req))});
  const jev = provider(), vendor = provider();
  const service = new SkillClassificationService({providers: {jev, vendor}, budget});
  return {input, budget, evaluation, jev, vendor, service, profile};
}
afterEach(() => vi.useRealTimers());
// Explicit synthetic requalification for tests of a different boundary; never production quality evidence.
function requalifyFixtureProfile(profile: ProviderProfile, revision: string) {
  profile.qualificationRevision = revision;
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
}

import {writeFileSync} from "node:fs";
describe("SS24 late malformed response cost retention",()=>{
 it("SS24 boundary valid paid usage must survive malformed late response",async()=>{
  const f=fixture();let release!: (v:ProviderEvaluation)=>void;
  const snapshot={taskRevision:f.input.request.confirmedContext.taskRevision,configRevision:"c1",profileRevision:"pr1",inventoryDigest:f.input.request.inventoryDigest,requestDigest:f.input.request.requestDigest,cancelled:false};
  f.input.getCurrentSnapshot=()=>snapshot;
  vi.mocked(f.jev.classify).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.service.classify(f.input);
  await vi.waitFor(()=>expect(f.jev.classify).toHaveBeenCalledTimes(1));
  snapshot.configRevision="c2";
  const invalid={...f.evaluation(),response:{...f.evaluation().response,judgments:[]}};
  release(invalid);const result=await pending;
  writeFileSync("SS24-evidence/boundary-invalid-late-cost.observed.json",JSON.stringify({executionKind:"new-offline-mock",input:invalid,currentSnapshot:snapshot,expected:{jevSpentUsd:0.1,reportedPaidUsage:0.1},observed:{result,budget:f.budget.snapshot()},callCounts:{jev:f.jev.classify.mock.calls.length,vendor:f.vendor.classify.mock.calls.length},linkedKnownDefect:"유효 비용이 invalid RESP와 함께 유실",realAgentStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}},null,2)+"\n");
  expect(result.response.error?.code).toBe("STALE_CLASSIFICATION");expect(f.vendor.classify).not.toHaveBeenCalled();
  expect(f.budget.snapshot().limits.jev?.spentUsd,"known cost must not be erased when late response is invalid").toBe(0.1);
 });
});
