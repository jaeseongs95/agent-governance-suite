import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aggregate, canonicalSet, oracleDigest, pairedMatrix, sameSet, scoreCase, scorePairs, type Observation } from "./evaluation.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, projectClassificationRequest, validateClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { createNativeClassificationAdapters, type NativeClassificationAdapterDefinition } from "../../mcp-server/src/skill-classification/native-adapters.js";
import { validateClassificationResponse } from "../../mcp-server/src/skill-classification/validation.js";
import type { ProviderProfile, SkillClassificationResponseV1 } from "../../mcp-server/src/skill-classification/types.js";

// SS38 only. Representative records below are SS38 evaluator sentinels, not
// semantic reruns, host observations, or signed selection receipts.
const output = resolve(process.env.SS38_EVIDENCE_OUTPUT ?? ".");
const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const source = corpus.cases.find((c: any) => c.caseId === "SS38");
const fixture = (id: string) => corpus.cases.find((c: any) => c.caseId === id);
const traces: any[] = [];
const record = (id: string, variant: string, input: unknown, expected: unknown, observed: unknown) =>
  traces.push({ id, variant, executionKind: "offline-mock", input, expected, observed, realAgentSelection: false });
const hash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
function sentinel(id: string, ids: string[] | null, host: "codex" | "claude", extra: Partial<Observation> = {}): Observation {
  const requestDigest = hash(`SS38/SYNTHETIC/request/${id}`), inventoryDigest = hash("SS38/SYNTHETIC/inventory");
  return { caseId: id, layer: "selected", state: "PASS", skillIds: ids,
    selectionStatus: ids === null ? "NEEDS_INPUT" : "SELECTED", reasonCodes: [], selectionReasons: [],
    executionKind: "offline-mock", host, requestDigest, inventoryDigest,
    conditionDigest: hash("SS38/SYNTHETIC/condition"),
    hostReceipt: ids === null ? null : { receiptId: "SS38-UNSIGNED-SYNTHETIC-ONLY", host, requestDigest,
      inventoryDigest, agentSelectedSkillIds: ids, acceptedAt: "2000-01-01T00:00:00Z" },
    stageEvidence: { read: false, applied: false, verified: false }, ...extra };
}
const pair = (id: string) => pairedMatrix().find(p => p.caseId === id)!;
const score = (trials: any[]) => scorePairs(trials, corpus.cases, corpus.inventorySkillIds);
const summary = (r: ReturnType<typeof score>) => ({ comparedPairs: r.comparedPairs, unmatchedPairs: r.unmatchedPairs,
  notRunPairs: r.notRunPairs, exactSetAgreement: r.exactSetAgreement, completedPurposeRate: r.completedPurposeRate,
  issues: r.issues, verdict: r.verdict, stability: r.stability, records: r.records.filter(x => x.status !== "NOT_RUN") });
beforeAll(() => { mkdirSync(output, { recursive: true }); vi.stubGlobal("fetch", () => { throw new Error("SS38_EXTERNAL_API_FORBIDDEN"); }); });
afterAll(() => { writeFileSync(`${output}/SS38.observations.json`, JSON.stringify({ caseId: "SS38", source, apiCalls: 0,
  unsignedSentinelWarning: "All receipts and selected sets in test inputs are offline sentinels. Actual selected/read/applied/verified remain NOTRUN.", traces }, null, 2) + "\n"); vi.unstubAllGlobals(); });

describe("SS38 isolated specification boundaries", () => {
  it("freezes SS38 null oracle and all eight variants", () => {
    const expected = { oracle: null, originalPrompt: null, variants: ["paired-matrix", "replay-contract", "independent-provider-live", "host-selection-live", "unmatched-pair", "same-wrong", "null-vs-empty", "allowed-alternative-disagreement"] };
    const observed = { oracle: source.oracle, originalPrompt: source.originalPrompt, variants: source.variants };
    record("source", "paired-matrix", source, expected, observed);
    expect(observed).toEqual(expected);
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(() => scoreCase(source, undefined, corpus.inventorySkillIds)).toThrow("NO_SEMANTIC_ORACLE:SS38");
  });
  it("retains exact 10 by 4 by 3 paired matrix and all missing slots", () => {
    const matrix = pairedMatrix(), r = score([]);
    const expected = corpus.pairedMatrix.caseIds.flatMap((id: string) => corpus.pairedMatrix.paths.flatMap((path: string) => [1,2,3].map(rep => `${id}/${path}/${rep}`)));
    record("matrix", "paired-matrix", [], { pairIds: expected, pairs: 120, hostSlots: 240, agreement: null }, { matrix, score: summary(r) });
    expect(matrix.map(x => x.pairId)).toEqual(expected);
    expect(r.notRunPairs).toBe(120); expect(r.exactSetAgreement).toBeNull();
    expect(matrix.every(x => x.codex === null && x.claude === null)).toBe(true);
  });
  it("rejects duplicate and invalid pair keys", () => {
    const p = pair("SS01"), input = [p, p, { ...p, pairId: "nonexistent" }];
    const r = score(input); record("pair-keys", "paired-matrix", input, ["DUPLICATE_PAIR", "INVALID_PAIR_KEY"], summary(r));
    expect(r.issues).toEqual(["DUPLICATE_PAIR", "INVALID_PAIR_KEY"]); expect(r.verdict).toBe("INCOMPLETE_OR_FAIL");
  });
  it("counts one missing host as NOTRUN", () => {
    const input = [{ ...pair("SS01"), codex: sentinel("SS01", ["ponytail"], "codex") }];
    const r = score(input); record("one-host", "paired-matrix", input, { notRunPairs: 120, comparedPairs: 0 }, summary(r));
    expect(r.notRunPairs).toBe(120); expect(r.comparedPairs).toBe(0);
  });
  it.each(["conditionDigest", "inventoryDigest"] as const)("excludes unmatched %s from agreement denominator", field => {
    const input = [{ ...pair("SS01"), codex: sentinel("SS01", ["ponytail"], "codex"), claude: sentinel("SS01", ["ponytail"], "claude", { [field]: hash("different") }) }];
    const r = score(input); record(`unmatched-${field}`, "unmatched-pair", input, { unmatchedPairs: 1, comparedPairs: 0, notRunPairs: 119 }, summary(r));
    expect(r.unmatchedPairs).toBe(1); expect(r.comparedPairs).toBe(0); expect(r.notRunPairs).toBe(119);
  });
  it("same wrong sets agree but fail both golden purposes", () => {
    const input = [{ ...pair("SS03"), codex: sentinel("SS03", ["ponytail"], "codex"), claude: sentinel("SS03", ["ponytail"], "claude") }];
    const r = score(input); record("same-wrong", "same-wrong", input, { agreement: 1, codexGolden: "FAIL", claudeGolden: "FAIL", completedPurposeRate: 0 }, summary(r));
    expect(r.exactSetAgreement).toBe(1); expect(r.records.find(x => x.pairId === input[0].pairId)).toMatchObject({ status: "FAIL", codexGolden: "FAIL", claudeGolden: "FAIL" });
  });
  it("keeps allowed alternatives purpose PASS and agreement false", () => {
    const ids = fixture("SS04").oracle.required;
    const input = [{ ...pair("SS04"), codex: sentinel("SS04", ids, "codex"), claude: sentinel("SS04", [...ids, "ponytail"], "claude") }];
    const r = score(input); record("alternatives", "allowed-alternative-disagreement", input, { status: "FAIL", agreement: false, codexGolden: "PASS", claudeGolden: "PASS" }, summary(r));
    expect(r.records.find(x => x.pairId === input[0].pairId)).toMatchObject({ status: "FAIL", agreement: false, codexGolden: "PASS", claudeGolden: "PASS" });
  });
  it("distinguishes null from valid no-skill []", () => {
    const input = [{ ...pair("SS09"), codex: sentinel("SS09", null, "codex"), claude: sentinel("SS09", [], "claude") }];
    const r = score(input); record("null-empty", "null-vs-empty", input, { sameSet: false, codexGolden: "FAIL", claudeGolden: "PASS", status: "FAIL" }, summary(r));
    expect(sameSet(null, [])).toBe(false);
    expect(r.records.find(x => x.pairId === input[0].pairId)).toMatchObject({ agreement: false, codexGolden: "FAIL", claudeGolden: "PASS", status: "FAIL" });
    expect(canonicalSet(null)).toBeNull(); expect(canonicalSet([])).toEqual([]);
  });
  it("excludes two unobserved null selections from exact-set agreement", () => {
    const input = [{ ...pair("SS09"), codex: sentinel("SS09", null, "codex", { state: "NOT_RUN" }), claude: sentinel("SS09", null, "claude", { state: "NOT_RUN" }) }];
    const r = score(input); record("null-null-unobserved", "null-vs-empty", input, { comparedPairs: 0, exactSetAgreement: null }, summary(r));
    expect(r.comparedPairs, "Unobserved nulls are not actual selected sets").toBe(0); expect(r.exactSetAgreement).toBeNull();
  });
  it("does not mark three NOTRUN selections stable", () => {
    const input = pairedMatrix().filter(p => p.caseId === "SS09" && p.path === "jev-on").map(p => ({ ...p,
      codex: sentinel("SS09", null, "codex", { state: "NOT_RUN" }), claude: sentinel("SS09", null, "claude", { state: "NOT_RUN" }) }));
    const r = score(input); record("notrun-stability", "paired-matrix", input, { stableGroups: [0,0], notRunGroups: [40,40] }, summary(r));
    expect(r.stability.map(x => x.stableGroups), "Missing observations cannot prove within-host repeat stability").toEqual([0,0]);
  });
  it("reports missing read/applied as a separate pair failure", () => {
    const input = [{ ...pair("SS01"), codex: sentinel("SS01", ["ponytail"], "codex"), claude: sentinel("SS01", ["ponytail"], "claude") }];
    const r = score(input), stages = aggregate([fixture("SS01")], [input[0].codex], "selected", corpus.inventorySkillIds).stageCoverage;
    record("missing-stages", "host-selection-live", input, "Separate read/applied failure must be reported; selected-only PASS cannot satisfy SS38", { pair: summary(r), separateStageCoverage: stages });
    const rec: any = r.records.find(x => x.pairId === input[0].pairId);
    expect(rec.status !== "PASS" || rec.stageFailures?.length > 0, "SS38 requires separate failures for recommendations/selection with missing read/applied").toBe(true);
  });
  it("retains supplied normalized selections in paired evidence records", () => {
    const input = [{ ...pair("SS09"), codex: sentinel("SS09", [], "codex"), claude: sentinel("SS09", [], "claude") }];
    const r = score(input); record("preserve-pair-evidence", "null-vs-empty", input, { codexSkillIds: [], claudeSkillIds: [] }, summary(r));
    const rec = r.records.find(x => x.pairId === input[0].pairId)!;
    expect(rec.codex, "[] input must remain distinguishable from absent null in emitted pair evidence").not.toBeNull();
    expect(rec.codex?.skillIds).toEqual([]);
  });
  it("does not treat absent equality evidence as a matched pair", () => {
    const input = [{ ...pair("SS01"), codex: sentinel("SS01", ["ponytail"], "codex", { conditionDigest: "" }), claude: sentinel("SS01", ["ponytail"], "claude", { conditionDigest: "" }) }];
    const r = score(input); record("missing-equivalence", "unmatched-pair", input, "UNMATCHED/FAIL without validated equality evidence", summary(r));
    expect(r.comparedPairs, "Two empty condition digests are not an input equivalence check").toBe(0);
  });
  it("measures actual set variation independently by host", () => {
    const input = pairedMatrix().filter(p => p.caseId === "SS01" && p.path === "jev-on").map(p => ({ ...p,
      codex: sentinel("SS01", ["ponytail"], "codex"), claude: sentinel("SS01", p.repetition === 3 ? [] : ["ponytail"], "claude") }));
    const r = score(input); record("repeat-variation", "paired-matrix", input, { codexStable: 1, claudeUnstable: 1 }, summary(r));
    expect(r.stability[0].stableGroups).toBe(1); expect(r.stability[1].unstableGroups).toBe(1);
  });
  it("replays shared REQ/RESP records through both real decoders for every planned slot", async () => {
    const inventory = await loadSkillInventory({ root: process.cwd() }); expect(inventory.issues).toEqual([]);
    const replays: any[] = [];
    for (const p of pairedMatrix()) {
      const request = createClassificationRequest({ requestId: `SS38-replay/${p.pairId}`, operationId: `SS38-replay/${p.pairId}`, originalPrompt: fixture(p.caseId).originalPrompt, inventory,
        classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md" });
      validateClassificationRequest(request);
      // Intentionally generic support record; no golden labels, final selected set,
      // provider route, permission, or host activity is inferred from these judgments.
      const response: SkillClassificationResponseV1 = { schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
        requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS",
        judgments: inventory.skills.map(s => ({ skillId: s.skillId, judgment: "not-needed", reasonRefs: ["SS38-SYNTHETIC-REPLAY-ONLY"], uncertaintyReason: null })), unresolvedItems: [], error: null };
      const profile: ProviderProfile = { profileId: "SS38-synthetic", providerKind: "vendor", vendorId: "synthetic", modelId: "synthetic-model", modelRevision: "synthetic-model", reasoningEffort: "high",
        supportedOptions: { reasoningEfforts: ["high"], structuredOutput: true }, approvedRouteRef: "SYNTHETIC-NO-ROUTE", qualificationRevision: "SYNTHETIC-NOT-LIVE",
        qualification: { status: "NOT_RUN", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "synthetic-model", promptRevision: "synthetic", validUntil: "2000-01-01T00:00:00Z", profileConfigurationDigest: hash("synthetic") },
        adapterRevision: "synthetic", promptRevision: "synthetic", maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: null, judgmentPolicy: null };
      const outputs: any[] = [];
      for (const host of ["codex", "claude"] as const) {
        const definition: NativeClassificationAdapterDefinition = { adapterId: host, host, executable: resolve(output, "SS38-NEVER-EXECUTED"), workingDirectory: output,
          approvalRef: "SYNTHETIC-ONLY", capabilityEvidenceRef: "SYNTHETIC-ONLY", retryPolicyVerified: true, retryPolicyEvidenceRef: "SYNTHETIC-ONLY", isolationEvidenceRef: "SYNTHETIC-ONLY", isolationArgs: [], timeoutMs: 1000, maximumOutputBytes: 1000000 };
        let wireInput = "";
        const decode = async (resp: SkillClassificationResponseV1) => {
          const adapters = createNativeClassificationAdapters([definition], async invocation => {
            wireInput = invocation.input;
            return { exitCode: 0, stdout: host === "codex" ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(resp) } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }) : JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: resp, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) };
          });
          return adapters.get(host)!.invokeStructured(request, profile, new AbortController().signal);
        };
        const valid = await decode(response);
        expect(valid.response).toEqual(response); expect(validateClassificationResponse(request, valid.response)).toEqual([]);
        await expect(decode({ ...response, requestDigest: hash("wrong-bound-response") })).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
        outputs.push({ host, response: valid.response, usage: valid.usage, wireInput, corruptedBindingRejected: true, runner: "mock; no spawn/CLI/API" });
      }
      expect(outputs[0].wireInput).toEqual(outputs[1].wireInput);
      expect(outputs[0].response).toEqual(outputs[1].response); expect(outputs[0].usage).toEqual(outputs[1].usage);
      expect(projectClassificationRequest(request).payload.originalPrompt).toBe(fixture(p.caseId).originalPrompt);
      replays.push({ pairId: p.pairId, pathLabelOnly: p.path, request, expectedResponse: response, outputs });
    }
    writeFileSync(`${output}/SS38.replay-contract.json`, JSON.stringify({ executionKind: "offline-mock", routeDispatches: 0, apiCalls: 0,
      count: replays.length, agentSelectedSkillIds: null, warning: "Planned route labels only; no JEV/fallback route executed; mock CLI runner uses real REQ validation, wire construction and host-specific RESP decoders", replays }, null, 2) + "\n");
    record("replay", "replay-contract", { sharedRecords: 120, hosts: ["codex","claude"], inventoryDigest: inventory.inventoryDigest }, { parityCount: 120, badBindingRejectedPerHost: 120 }, { parityCount: replays.length, apiCalls: 0, routeDispatches: 0 });
    expect(replays).toHaveLength(120);
  });
  it.skip("independent-provider-live requires explicit route/profile/budget authority; NOTRUN", () => {});
  it.skip("host-selection-live requires two real independent AGENT decisions and signed stage evidence; NOTRUN", () => {});
});
