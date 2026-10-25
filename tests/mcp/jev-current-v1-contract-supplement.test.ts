// r02: 의미 필드·validator 누락·wire null/[] 단언을 보강한 current r06 v1 미실행 초안.
// 제품 default/profile 변경 없이 단일 구현자가 tests/mcp에
// 통합한 뒤 기존 runner로 검사한다. 이 파일은 실모델 의미 정확도를 검증하지 않는다.
import {describe, expect, it, vi} from "vitest";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, digestClassificationValue, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {ApprovedRouteClassificationProvider, jevNoulWireAdapter, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {digestProviderProfileConfiguration, validateProviderProfile} from "../../mcp-server/src/skill-classification/profiles.js";
import {validateClassificationResponse} from "../../mcp-server/src/skill-classification/validation.js";
import type {ProviderProfile, SkillMetadata} from "../../mcp-server/src/skill-classification/types.js";

const FIXTURE_ADAPTER_REVISION = "jev-noul-v1";
const FIXTURE_PROMPT_REVISION = "fixture-current-v1-question";
const NOW = Date.parse("2026-01-01T00:00:00Z");
function skill(skillId: string): SkillMetadata {
  return {skillId, version: "fixture-1", description: "고정 diff 읽기 전용 검토",
    enabled: true, installed: true, hostSupported: true, capabilities: ["fixture-review"],
    actions: ["review"], targets: ["diff"], constraints: ["no-write"],
    applicability: ["고정 diff의 결함 검토 요청"], exclusions: ["제품 파일 수정 요청만 있음"],
    dependencies: [], phases: [], sourceRefs: []};
}
function request(skills: SkillMetadata[], actions: string[] | null = null) {
  return createClassificationRequest({requestId: "fixture-j30-request", operationId: "fixture-j30-operation",
    originalPrompt: "고정 diff를 읽고 결함을 검토해. 수정하지 마.",
    confirmedContext: {actions}, contextSources: actions === null ? [] : [{field: "actions", reference: "fixture:confirmed-actions"}],
    inventory: {skills, issues: [], inventoryDigest: digestClassificationValue({skills}), taxonomyRevision: "fixture-taxonomy-1"},
    classificationCriteriaRef: "fixture:closed-review-rule"});
}
function qualified(req: ReturnType<typeof request>): ProviderProfile {
  // 합성 component fixture 전용이다. 운영 자격의 PASS 발급 절차가 아니다.
  const profile: ProviderProfile = {profileId: "fixture-j30-profile", providerKind: "jev", vendorId: "typesafe",
    modelId: "fixture-model", modelRevision: "fixture-model", reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "fixture-route",
    qualificationRevision: "fixture-q1", adapterRevision: FIXTURE_ADAPTER_REVISION, promptRevision: FIXTURE_PROMPT_REVISION,
    maximumInputBytes: 1_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4,
    judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2},
    qualification: {status: "PASS", inventoryDigest: req.inventoryDigest, taxonomyRevision: req.taxonomyRevision,
      modelRevision: "fixture-model", promptRevision: FIXTURE_PROMPT_REVISION,
      validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  return profile;
}
function body(req: ReturnType<typeof request>, scores: number[] = req.skills.map(() => 0.9)) {
  return {model: "fixture-model", answers: Object.fromEntries(req.skills.map((item, i) => [item.skillId, {type: "noul", noul: scores[i]}])),
    usage: {input_tokens: 1, output_tokens: 1}};
}

describe("J30 current v1 contract supplement", () => {
  it("J30-P01 preserves candidates and semantic fields and rejects decoder and validator omissions", () => {
    for (const count of [1, 2, 17]) {
      const ids = Array.from({length: count}, (_, i) => `fixture-skill-${i}`);
      const inputs = ids.map(id => ({...skill(id), dependencies: ["fixture-review-prerequisite"]}));
      const req = request(inputs), profile = qualified(req);
      const wire = jevNoulWireAdapter.encode(req, profile) as {questions: Record<string, {instructions: {skill: SkillMetadata}}>};
      expect(Object.keys(wire.questions).sort()).toEqual([...ids].sort());
      for (const input of inputs) {
        const {applicability, exclusions, constraints, dependencies} = input;
        expect(wire.questions[input.skillId]?.instructions.skill).toMatchObject({applicability, exclusions, constraints, dependencies});
      }
      const complete = body(req);
      const decoded = jevNoulWireAdapter.decode(complete, req, profile).response;
      expect(validateClassificationResponse(req, decoded)).toEqual([]);
      const missingJudgment = {...decoded, judgments: decoded.judgments.slice(0, -1)};
      expect(validateClassificationResponse(req, missingJudgment)).toEqual(["MISSING_CANDIDATE_JUDGMENT"]);
      delete complete.answers[ids.at(-1)!];
      expect(() => jevNoulWireAdapter.decode(complete, req, profile)).toThrow("INVALID_JEV_IDS");
    }
  });

  it("J30-P04 loads real file maps and invalidates old qualification after additions removals and ID renaming", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/jev-current-workload-p04.r01.json", import.meta.url), "utf8")) as {
      baseFiles: Record<string, string>;
      variants: Array<{name: string; patch: Record<string, string | null>; expectedInventoryIds: string[];
        expectedSkillEvidence: Record<string, {sourceDigests: Record<string, string>; applicability: string[]; exclusions: string[];
          spans: Array<{field: string; path: string; startLine: number; endLine: number; digest: string}>}>}>;
      expected: {baseIssues: unknown[]};
      trustedInput: {actions: string[]};
    };
    const roots: string[] = [];
    const requests: Array<ReturnType<typeof request>> = [];
    try {
      for (const variant of fixture.variants) {
        const root = await mkdtemp(path.join(tmpdir(), "jev-p04-loader-"));
        roots.push(root);
        for (const [relative, text] of Object.entries({...fixture.baseFiles, ...variant.patch})) {
          if (!/^skills\/[a-z0-9/-]+\.(?:md|json)$/iu.test(relative) || relative.split("/").includes("..")) throw new Error("INVALID_SYNTHETIC_FILE_MAP");
          if (text === null) continue;
          const target = path.join(root, relative);
          await mkdir(path.dirname(target), {recursive: true});
          await writeFile(target, text, {encoding: "utf8", flag: "wx"});
        }
        const inventory = await loadSkillInventory({root});
        expect(inventory.issues, variant.name).toEqual(fixture.expected.baseIssues);
        expect(inventory.skills.map(item => item.skillId).sort(), variant.name).toEqual([...variant.expectedInventoryIds].sort());
        for (const item of inventory.skills) {
          const expected = variant.expectedSkillEvidence[item.skillId]!;
          expect(item.sourceRefs, variant.name + ":" + item.skillId).toHaveLength(2);
          expect(Object.fromEntries(item.sourceRefs.map(ref => [ref.path, ref.digest]))).toEqual(expected.sourceDigests);
          expect(item.applicability).toEqual(expected.applicability);
          expect(item.exclusions).toEqual(expected.exclusions);
          expect(item.sourceMap?.filter(ref => ref.field === "applicability" || ref.field === "exclusions")).toEqual(expected.spans);
        }
        requests.push(createClassificationRequest({requestId: "fixture-j30-request", operationId: "fixture-j30-operation",
          originalPrompt: "고정 diff를 읽고 결함을 검토해. 수정하지 마.",
          confirmedContext: {actions: fixture.trustedInput.actions},
          contextSources: [{field: "actions", reference: "fixture:confirmed-actions"}], inventory,
          classificationCriteriaRef: "fixture:closed-review-rule"}));
      }
      expect(fixture.variants.map(item => item.name)).toEqual(["base", "add-irrelevant", "remove-required", "rename-id"]);
      const original = requests[0]!, profile = qualified(original);
      expect(validateProviderProfile(profile, original, NOW)).toBeNull();
      expect(new Set(requests.map(req => req.inventoryDigest)).size).toBe(4);
      for (const req of requests.slice(1)) {
        expect(req.inventoryDigest).not.toBe(original.inventoryDigest);
        expect(validateProviderProfile(profile, req, NOW)).toBe("QUALIFICATION_MISMATCH");
      }
    } finally {
      for (const root of roots) await rm(root, {recursive: true, force: true, maxRetries: 5});
    }
  });

  it("J30-P05 preserves equal descriptions under distinct IDs and rejects duplicate IDs", () => {
    const req = request([skill("fixture-left"), {...skill("fixture-right"), enabled: false}]);
    const wire = jevNoulWireAdapter.encode(req, qualified(req)) as {questions: Record<string, {instructions: {skill: SkillMetadata}}>};
    expect(Object.keys(wire.questions).sort()).toEqual(["fixture-left", "fixture-right"]);
    expect(wire.questions["fixture-right"]?.instructions.skill.enabled).toBe(false);
    expect(() => request([skill("fixture-same"), skill("fixture-same")])).toThrow("DUPLICATE_SKILL_ID");
  });

  it("J30-P06 keeps unknown null distinct from confirmed empty actions", () => {
    const unknown = request([skill("fixture-a")], null), empty = request([skill("fixture-a")], []);
    expect(projectClassificationRequest(unknown).payload.confirmedContext.actions).toBeNull();
    expect(projectClassificationRequest(empty).payload.confirmedContext.actions).toEqual([]);
    expect(unknown.requestDigest).not.toBe(empty.requestDigest);
    const wireActions = [unknown, empty].map(req => (jevNoulWireAdapter.encode(req, qualified(req)) as {
      state: {confirmedContext: {actions: string[] | null}};
    }).state.confirmedContext.actions);
    expect(wireActions).toEqual([null, []]);
  });

  it("J30-P07 maps exact calibrated boundaries without replacing the semantic oracle", () => {
    const scores = [0, 0.199999, 0.2, 0.200001, 0.5, 0.799999, 0.8, 0.800001, 1];
    const expected = ["not-needed", "not-needed", "not-needed", "uncertain", "uncertain", "uncertain", "needed", "needed", "needed"];
    const req = request(scores.map((_, i) => skill(`fixture-threshold-${i}`)));
    const result = jevNoulWireAdapter.decode(body(req, scores), req, qualified(req));
    expect(result.response.judgments.map(j => j.judgment)).toEqual(expected);
    expect(result.response.status).toBe("PARTIAL");
    expect(result.response.unresolvedItems.map(j => j.skillId)).toEqual(["fixture-threshold-3", "fixture-threshold-4", "fixture-threshold-5"]);
    expect(result.usage.actualCostUsd).toBeNull();
  });

  it("J30-P08 applies the final UTF-8 wire ceiling including question overhead", async () => {
    const req = request([{...skill("fixture-byte"), description: "한글🙂".repeat(9)}]), profile = qualified(req);
    const wire = JSON.stringify(jevNoulWireAdapter.encode(req, profile));
    const size = Buffer.byteLength(wire, "utf8");
    expect(size).toBeGreaterThan(wire.length);
    const localFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body(req))));
    const route: ApprovedClassificationRoute = {routeRef: "fixture-route", approvalRef: "fixture-only-not-authorization",
      approved: true, providerKind: "jev", vendorId: "typesafe", adapterRevision: FIXTURE_ADAPTER_REVISION,
      modelIds: ["fixture-model"], reasoningEfforts: [null], structuredOutput: true, kind: "remote",
      endpoint: "https://fixture.invalid/j30", getCredential: async () => "SYNTHETIC-ONLY-KEY", adapter: jevNoulWireAdapter};
    const provider = new ApprovedRouteClassificationProvider([route], localFetch);
    profile.maximumInputBytes = size;
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    expect((await provider.classify(req, profile, new AbortController().signal)).response.status).toBe("SUCCESS");
    expect(localFetch).toHaveBeenCalledTimes(1);
    localFetch.mockClear();
    profile.maximumInputBytes = size - 1;
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    await expect(provider.classify(req, profile, new AbortController().signal)).rejects.toMatchObject({code: "INPUT_TOO_LONG", dispatchState: "not-started"});
    expect(localFetch).not.toHaveBeenCalled();
  });
});
