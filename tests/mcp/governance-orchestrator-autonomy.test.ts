import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import type {RoutedSkillProviderV2, TaskEnvelopeV1} from "../../contracts/types.js";
import {FileSkillRegistry} from "../../mcp-server/src/registry.js";
import {ContractValidator} from "../../mcp-server/src/schema-validator.js";
import {WorkflowService} from "../../mcp-server/src/workflow-service.js";

const prose = ["korean-prose-selection", "korean-prose-editing", "korean-prose-verification", "korean-prose-finalization"];
// Only the synthetic test registry enables the existing prose providers; production qualification/defaults stay untouched.
class ProseFixtureRegistry extends FileSkillRegistry {
  override read(): RoutedSkillProviderV2[] {return super.read().map(provider => provider.skillId === "korean-prose-editor" ? {...provider, enabled: true} : provider);}
}
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const instructions = (file: string) => readFileSync(new URL("../../skills/orchestrator/" + file, import.meta.url), "utf8");
function service() {const validator = new ContractValidator(); return new WorkflowService(new ProseFixtureRegistry(registryPath, validator), validator);}
function task(capabilities: string[], riskLevel: TaskEnvelopeV1["riskLevel"] = "low"): TaskEnvelopeV1 {
  return {schemaVersion: "1.0.0", taskId: "governance-autonomy", objective: "요청한 단계만 수행하고 한국어로 결과를 설명한다.",
    scope: {included: ["requested synthetic work"], excluded: ["publication"]}, acceptanceCriteria: ["요청 밖 단계나 사용자 승인 관문을 추가하지 않는다."],
    riskLevel, workUnits: [], requiredCapabilities: capabilities, constraints: ["원문은 영수증에 저장하지 않는다."],
    authorization: {allowedActions: ["local-test"], prohibitedActions: ["publish"], approvalRequired: []}, decision: {complexity: "simple", hasConflicts: false},
    orchestration: {requested: true, mcpAvailable: true}};
}

describe("GOV01/06 actual orchestrator capability and instruction consumption", () => {
  it.each(prose)("does not expand a request for only %s into unrequested language stages", capability => {
    const result = service().planWorkflow(task([capability]));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages.map(stage => stage.requiredCapability)).toEqual([capability]);
    expect(result.data!.stages[0]!.requiredArtifacts).not.toContain("gate-verdict");
  });
  it("keeps an ordinary Korean result report free of implicit editor, diagnosis, coordination and audit stages", () => {
    const input = task([]); input.objective = "첫 수정 실패의 원 오류를 읽고 필요한 최소 수리 뒤 시험 결과를 한국어로 보고한다.";
    const result = service().planWorkflow(input);
    expect(result.ok, result.error?.message).toBe(true); expect(result.data!.stages).toEqual([]);
    expect(input.requiredCapabilities).toEqual([]);
  });
  it("retains a requested full prose workflow and its exact metadata order/dependency/privacy contracts", () => {
    const result = service().planWorkflow(task([...prose].reverse()));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages.map(stage => stage.requiredCapability)).toEqual(prose);
    expect(result.data!.stages.map(stage => stage.phaseOrder)).toEqual([50, 55, 60, 65]);
    expect(result.data!.stages.every(stage => stage.receiptPolicy?.mode === "reference-only")).toBe(true);
    expect(result.data!.stages[1]!.requiredInputArtifacts).toContain("edit-decision-set");
    expect(result.data!.stages[2]!.requiredInputArtifacts).toContain("edit-candidate");
    expect(result.data!.stages[3]!.requiredInputArtifacts).toContain("edit-verification-report");
    expect(result.data!.stages[3]!.receiptPolicy).toMatchObject({actorIdsMatch: "prior-policy-actors"});
  });
  it.each(["high", "critical"] as const)("retains the mandatory independent audit for %s work without expanding the prose request", risk => {
    const result = service().planWorkflow(task([prose[0]!], risk));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages.map(stage => stage.requiredCapability)).toEqual([prose[0], "independent-audit"]);
    expect(result.data!.stages[1]).toMatchObject({riskGate: "mandatory"});
    expect(result.data!.stages[1]!.requiredArtifacts).toContain("gate-verdict");
  });
  it("retains an explicit independent audit", () => {
    const result = service().planWorkflow(task([prose[0]!, "independent-audit"]));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages.map(stage => stage.requiredCapability)).toEqual([prose[0], "independent-audit"]);
  });
  it("keeps the public contract rejection of duplicate requested capabilities", () => {
    expect(service().planWorkflow(task([prose[0]!, prose[0]!])).error?.code).toBe("INVALID_INPUT");
  });
  it("does not invent artifacts from unrequested producer stages", () => {
    const result = service().planWorkflow(task([prose[1]!]));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages).toHaveLength(1);
    expect(result.data!.stages[0]!.requiredInputArtifacts).toContain("edit-decision-set");
    expect(result.data!.stages[0]!.producedArtifacts).not.toContain("edit-decision-set");
  });
  it("removes the first-failure diagnosis mandate from the actual loaded entry while preserving repeated-failure discrimination", () => {
    const text = instructions("references/entry-details.md");
    expect(text).not.toMatch(/첫 수정 실패[^\n]*일반 재시도 대신[^\n]*blocker-diagnosis/u);
    expect(text).toContain("한 번 실패했다는 이유로 새 계약, recovery workflow나 `blocker-diagnosis`를 먼저 요구하지 않는다");
    expect(text).toContain("같은 안정된 실패가 반복되거나");
    expect(text).toContain("새 관측이나 입력 변화가 없는 같은 검사를 반복하지 않는다");
  });
  it("keeps ordinary Korean reporting separate from an explicitly selected specialist workflow in the host-loaded skill", () => {
    const text = instructions("SKILL.md");
    expect(text).not.toContain("한국어 산문을 작성·편집하거나 자연스러움을 검증하는 요청은 일부 단계만 선택하지 않는다");
    expect(text).toContain("일반 한국어 답변·진행 보고·결과 설명은 요청 목적에 맞게 직접 작성한다");
    expect(text).toContain("일부 단계만 요청하면 필요한 기존 artifact를 제공");
    expect(text).toContain("reference-only policy는 유지한다");
    expect(text).toContain("분류는 오류 가능한 조언");
    expect(text).toContain("채택·교정·기각하고 최종 선택");
    expect(text).toContain("점수는 정답이나 실행 승인이 아니다");
    const classification = instructions("references/skill-classification.md");
    expect(classification).toContain("오류 가능한 분류 조언");
    expect(classification).toContain("점수나 분류 결과를 정답·실행 승인으로 취급하지 않는다");
  });
  it("AGS-D-0352: 분류 지원 미확정과 거부 뒤 독립 작업의 지침을 전달한다", () => {
    // 지침 전달만 검사하며 실제 호스트 행동·거부·재시도 검증을 대신하지 않는다.
    const intake = instructions("SKILL.md");
    const classification = instructions("references/skill-classification.md");
    expect(intake).toContain("도구 노출만으로 지원 설정을 추정하지 않는다");
    expect(intake).toContain("독립적으로 가능한 작업과 막힌 의존 단계를 구분한다");
    for (const criterion of [
      "기존 승인된 설치 설정과 호스트 호출 경로에서 지원이 확인된 경우",
      "새 탐지 도구·호출 경로·설정 경로를 만들거나 분류를 원 작업의 필수 선행단계로 추가하지 않는다",
      "호스트 훅·인증·판정불가 거부는 입력 스키마 오류나 분류 제공자 실패로 바꿔 해석하지 않는다",
      "원인·입력·설정이 달라지지 않은 같은 호출이나 실패와 무관한 도구·입력 형식 탐색을 반복하지 않는다",
      "구체적인 입력 오류는 확인된 필드만 수정한다",
      "분류·선택 기록이 수락되지 않았으면 미수락 상태를 유지한다",
      "설치된 전문 스킬로 독립 처리 가능한 허용 부분은 직접 수행",
      "필수 관측·승인·통합·감사에 의존하는 단계는 보류한다",
      "직접 수행 결과를 선택 수락이나 보호된 통합·감사 완료로 기록하지 않는다",
      "기존 분류 제공자 전환과 서버가 허용한 실패 후 선택 기록은 유지하되, 훅 거부를 그 실패 근거로 사용하지 않는다",
    ]) expect(classification).toContain(criterion);
    expect(classification).toContain("[MCP 실행·실패 처리](mcp-execution.md)");
  });
  it("does not require another PRE for ordinary branch commits, pushes or CI", () => {
    const text = instructions("references/entry-details.md");
    expect(text).not.toContain("배포·push·태그처럼 사전 점검 대상");
    expect(text).toContain("시험 실행, 작업 브랜치의 커밋·push와 CI 실행에는 추가 PRE나 승인을 요구하지 않는다");
    expect(text).toContain("배포·태그처럼 별도 승인 경계");
  });
  it("continues authorized work after a specialist result without expanding analysis-only requests or bypassing gates", () => {
    const text = instructions("references/entry-details.md");
    const integration = text.split("## 결과 통합\n")[1]!.split("## MCP 도구 사용 계약")[0]!;
    const intake = instructions("SKILL.md").split("<!-- skill-intake:start -->")[1]!.split("<!-- skill-intake:end -->")[0]!;
    const userOnlyBoundary = intake.match(/사용자만 할 수 있는[^.]+\./u)?.[0];
    expect(integration).toContain("해당 단계의 결과이며 사용자 요청 전체의 완료와 구분한다");
    expect(integration).toContain("분석·계획만 요청받았다면 후속 변경을 실행하지 않는다");
    expect(integration).toContain("사용자 요청에 구현·실행·검증이 포함되어 있고 이미 허용됐다면");
    expect(integration).toContain("기존 담당 실행자·도구의 후속 작업 입력으로 연결");
    expect(integration).toContain("그 작업과 필요한 검증까지 계속 수행");
    expect(integration).toContain("실행 가능한 후속 확인을 사용자에게 넘기지 않는다");
    expect(userOnlyBoundary).toBeDefined();
    expect(userOnlyBoundary).toContain("승인·비밀값 입력·사용자 화면 조작");
    expect(userOnlyBoundary).toContain("독립적인 작업은 계속한다");
    expect(integration).toContain("[공통 접수·선택 기준](../SKILL.md#공통-접수선택-기준)");
    expect(integration).not.toContain(userOnlyBoundary!);
    expect(integration).toContain("필수 입력이나 gate 실패로 막힌 의존 단계는 실행하지 않으며");
    expect(integration).toContain("실제 실행·검증 근거와 남은 제약");
    expect(integration).toContain("단독 전문 작업에 workflow나 새 보고서를 추가하지 않는다");
    expect(text).toContain("`BINDING_REQUIRED` 또는 `BINDING_INVALID`를 반환하면 값을 임의로 보정·추정하지 않고 해당 workflow를 시작하지 않는다");
  });
  it("makes the dedicated evaluation recorder request its declared full artifact workflow explicitly", () => {
    const text = readFileSync(new URL("../../scripts/record-korean-prose-run.ts", import.meta.url), "utf8");
    expect(text).toContain("requiredCapabilities: artifactContracts.map(({capability}) => capability)");
    expect(text).not.toContain('requiredCapabilities: ["korean-prose-editing"]');
  });
});
