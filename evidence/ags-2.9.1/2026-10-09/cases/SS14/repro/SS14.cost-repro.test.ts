import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import type { ProviderProfile, ProviderEvaluation } from "../../mcp-server/src/skill-classification/types.js";

// SS14 input only. Local provider port mocks do not invoke any vendor or issue host receipts.
describe("SS14 known-defect reproduction: invalid RESP with valid usage", () => {
  it("retains validated cost even when SS14 full-inventory response is missing a candidate", async () => {
    const fixture = JSON.parse(readFileSync("tests/skill-classification/fixtures.json", "utf8")).cases.find((c: any) => c.caseId === "SS14");
    const inventory = await loadSkillInventory({root: process.cwd()});
    const records: unknown[] = [];
    for (const omit of [false, true]) {
      const request = createClassificationRequest({requestId: `SS14-cost-${omit}`, operationId: `SS14-cost-${omit}`, originalPrompt: fixture.originalPrompt,
        inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
      const profile: ProviderProfile = {profileId: "SS14-mock-vendor", providerKind: "vendor", vendorId: "offline-mock", modelId: "offline-model",
        modelRevision: "offline-model", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true},
        approvedRouteRef: "offline-mock-only", qualificationRevision: "synthetic-test-only", adapterRevision: "test", promptRevision: "test",
        maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null,
        qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: "offline-model",
          promptRevision: "test", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
      profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
      const usage = {inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, actualCostUsd: 0.1};
      const evaluation: ProviderEvaluation = {response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
        requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS",
        judgments: inventory.skills.filter(s => !omit || s.skillId !== "test-engineering").map(s => ({skillId: s.skillId,
          judgment: fixture.oracle.required.includes(s.skillId) ? "needed" : "not-needed", reasonRefs: ["offline-control"], uncertaintyReason: null})), unresolvedItems: [], error: null},
        usage, dispatchState: "started", diagnostics: null};
      const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {"offline-mock": {limitUsd: 2, spentUsd: 0}}});
      let mockCalls = 0;
      const service = new SkillClassificationService({budget, providers: {vendor: {
        availability: async () => ({available: true, approved: true, routeKind: "remote", reasonCode: null}),
        classify: async () => {mockCalls++; return evaluation;}}}});
      const result = await service.classify({request, config: {jevEnabled: false, mode: "select", externalClassificationAllowed: true,
        providerProfileRegistryRef: "offline-mock", configRevision: "offline-mock", timeoutMs: 5000},
        registry: {schemaVersion: "1.0.0", profileRevision: "offline-mock", profiles: [profile]}, currentVendorId: "offline-mock"});
      expect(mockCalls).toBe(1);
      records.push({caseId: "SS14", boundary: omit ? "missing-test-engineering-judgment" : "valid-control", executionKind: "offline-mock", API0: true,
        requestDigest: request.requestDigest, suppliedUsage: usage, expectedCostUsd: 0.1, observedAttempt: result.attempts[0], budget: budget.snapshot()});
      if (!omit) {expect(result.attempts[0].usage.actualCostUsd).toBe(0.1); expect(budget.snapshot().reservations).toEqual([]);}
    }
    writeFileSync("ss14-repro-output/SS14.cost-repro.observations.json", JSON.stringify(records, null, 2));
    const invalid: any = records[1];
    expect(invalid.observedAttempt.errorCode).toBe("INVALID_PROVIDER_RESPONSE");
    // This assertion is expected RED at the frozen candidate; preserve the actual failure.
    expect(invalid.observedAttempt.usage.actualCostUsd).toBe(0.1);
    expect(invalid.budget.limits["vendor:offline-mock"].spentUsd).toBe(0.1);
    expect(invalid.budget.reservations).toEqual([]);
  });
});
