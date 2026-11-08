import {describe, expect, it, vi} from "vitest";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import path from "node:path";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {ApprovedRouteClassificationProvider, jevNoulWireAdapter, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import type {ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

const addedId = "fixture-c12-label-classifier";
const skillText = "---\nname: fixture-c12-label-classifier\ndescription: 단일 합성 라벨 레코드 분류\nversion: fixture-c12-r01\n---\n확인된 classifySyntheticLabel 요청에서 synthetic-label-record의 fixtureKind를 분류한다.\nrecipe 처리, diff 검토, 병렬작업 선택, 제품 파일 변경 요청에는 적용하지 않는다.\n";
const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const task = {
  requestId: "fixture-c12-request", operationId: "fixture-c12-operation", classificationCriteriaRef: "fixture:C12-closed-contract",
  originalPrompt: "분류기준: 요청 action과 target이 skill descriptor와 정확히 일치할 때만 해당 skill을 선택한다. action=classifySyntheticLabel, target=synthetic-label-record, constraint=synthetic-only; 이 한 건의 합성 record에만 적용해.",
  confirmedContext: {actions: ["classifySyntheticLabel"], targets: ["synthetic-label-record"], constraints: ["synthetic-only"]},
  contextSources: [{field: "actions" as const, reference: "fixture:C12-closed-contract"}, {field: "targets" as const, reference: "fixture:C12-closed-contract"},
    {field: "constraints" as const, reference: "fixture:C12-closed-contract"}],
};

function qualified(request: SkillClassificationRequestV1): ProviderProfile {
  // 기존 P04의 helper는 비공개이므로 같은 최소 합성 profile 계약만 사용한다. 운영 승인 증거가 아니다.
  const profile: ProviderProfile = {profileId: "fixture-c12-profile", providerKind: "jev", vendorId: "typesafe", modelId: "fixture-model", modelRevision: "fixture-model",
    reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "fixture-c12-route", qualificationRevision: "fixture-c12-q1",
    adapterRevision: "jev-noul-v1", promptRevision: "fixture-c12-question", maximumInputBytes: 1_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4,
    judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}, qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision,
      modelRevision: "fixture-model", promptRevision: "fixture-c12-question", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  return profile;
}

describe("ORIGINAL125 C-12 합성 관련 역할 추가", () => {
  it("동일 task에서 새 descriptor를 다시 읽어 보내며 기존 후보를 보존한다", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/jev-current-workload-p04.r01.json", import.meta.url), "utf8")) as {baseFiles: Record<string, string>};
    const root = await mkdtemp(path.join(tmpdir(), "jev-c12-"));
    const put = async (relative: string, text: string) => {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), {recursive: true});
      await writeFile(target, text, {encoding: "utf8", flag: "wx"});
    };
    try {
      for (const [relative, text] of Object.entries(fixture.baseFiles)) await put(relative, text);
      const beforeInventory = await loadSkillInventory({root});
      expect(beforeInventory.issues).toEqual([]);
      expect(beforeInventory.skills.map(skill => skill.skillId).sort()).toEqual(["fixture-g", "fixture-r", "fixture-w"]);
      const before = createClassificationRequest({...task, inventory: beforeInventory}), original = structuredClone(before);
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const wire = JSON.parse(String(init!.body)) as {questions: Record<string, unknown>};
        // 점수는 고정 합성 응답이다. 모델의 적용성 정확도나 Agent 선택을 평가하지 않는다.
        return new Response(JSON.stringify({model: "fixture-model", answers: Object.fromEntries(Object.keys(wire.questions).map(id =>
          [id, {type: "noul", noul: id === addedId ? 0.9 : 0.1}])), usage: {input_tokens: 1, output_tokens: 1}}));
      });
      const route: ApprovedClassificationRoute = {routeRef: "fixture-c12-route", approvalRef: "fixture-only-not-authorization", approved: true,
        providerKind: "jev", vendorId: "typesafe", adapterRevision: "jev-noul-v1", modelIds: ["fixture-model"], reasoningEfforts: [null], structuredOutput: true,
        kind: "remote", endpoint: "https://fixture.invalid/c12", getCredential: async () => "SYNTHETIC-ONLY-KEY", adapter: jevNoulWireAdapter};
      const provider = new ApprovedRouteClassificationProvider([route], fetcher), oldProfile = qualified(before);
      const first = await provider.classify(before, oldProfile, new AbortController().signal);
      expect(first.response.judgments.map(({skillId, judgment}) => [skillId, judgment])).toEqual([
        ["fixture-g", "not-needed"], ["fixture-r", "not-needed"], ["fixture-w", "not-needed"]]);
      const firstWire = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
      fetcher.mockClear();

      await put(`skills/${addedId}/SKILL.md`, skillText);
      await put(`skills/${addedId}/classification.json`, JSON.stringify({schemaVersion: "1.0.0",
        // 역할 추가와 taxonomy 변경을 혼동하지 않도록 기존 P04 taxonomy를 유지한다.
        taxonomyRevision: "fixture-oracle-r01", actions: ["classifySyntheticLabel"], targets: ["synthetic-label-record"], constraints: ["synthetic-only"],
        dependencies: [], capabilities: ["fixture-capability-c12-label-classifier"],
        applicability: [{path: `skills/${addedId}/SKILL.md`, startLine: 6, endLine: 6, digest: digest(skillText)}],
        exclusions: [{path: `skills/${addedId}/SKILL.md`, startLine: 7, endLine: 7, digest: digest(skillText)}]}, null, 2) + "\n");
      const afterInventory = await loadSkillInventory({root});
      expect(afterInventory.issues).toEqual([]);
      expect(afterInventory.skills.filter(skill => skill.skillId !== addedId)).toEqual(beforeInventory.skills);
      expect(afterInventory.skills.find(skill => skill.skillId === addedId)).toMatchObject({actions: ["classifySyntheticLabel"], targets: ["synthetic-label-record"],
        constraints: ["synthetic-only"], applicability: ["확인된 classifySyntheticLabel 요청에서 synthetic-label-record의 fixtureKind를 분류한다."],
        exclusions: ["recipe 처리, diff 검토, 병렬작업 선택, 제품 파일 변경 요청에는 적용하지 않는다."]});
      const after = createClassificationRequest({...task, inventory: afterInventory});
      expect(before).toEqual(original);
      expect(after.originalPrompt).toBe(before.originalPrompt);
      expect(after.confirmedContext).toEqual(before.confirmedContext);
      expect(after.contextSources).toEqual(before.contextSources);
      expect(after.promptDigest).toBe(before.promptDigest);
      expect(after.requestDigest).not.toBe(before.requestDigest);
      expect(after.inventoryDigest).not.toBe(before.inventoryDigest);
      // 4.0.0: JEV 조언은 qualification에 묶이지 않는다(조언 계층). 같은 프로필로 새 descriptor를 다시 읽어 보낸다.
      const second = await provider.classify(after, oldProfile, new AbortController().signal);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const secondWire = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
      expect(secondWire.state).toEqual(firstWire.state);
      for (const id of ["fixture-g", "fixture-r", "fixture-w"]) expect(secondWire.questions[id]).toEqual(firstWire.questions[id]);
      expect(Object.keys(secondWire.questions).sort()).toEqual([addedId, "fixture-g", "fixture-r", "fixture-w"]);
      expect(second.response.requestDigest).toBe(after.requestDigest);
      expect(second.response.inventoryDigest).toBe(after.inventoryDigest);
      expect(second.response.judgments.filter(item => item.skillId !== addedId)).toEqual(first.response.judgments);
      expect(second.response.judgments.find(item => item.skillId === addedId)).toMatchObject({judgment: "needed"});
    } finally { await rm(root, {recursive: true, force: true, maxRetries: 5}); }
  });
});
