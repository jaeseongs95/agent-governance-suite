import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { contractErrorBody, type ApiResultV1, type WorkflowPlanV1, type WorkflowReceiptV1 } from "../../contracts/types.js";
import { msg, render, type SupportedLocale } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer, workflowChangeNotice } from "../../mcp-server/src/server.js";
import type { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import type { SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { callerMeta, metaIngress } from "../helpers/caller.js";

// A workflow changes because the purpose of the work changed. A stage's skillId names the provider contract its result
// is recorded under, yet responses showed only the next stage ID, so the agent kept the skills it had and read the
// provider as the one skill of the stage. Every workflow change now asks to match the next judgment against every
// installed skill, names the provider as a contract only, and limits an earlier skill to the judgment it was for.
const stage = { stageId: "stage-02", requiredCapability: "minimal-implementation", skillId: "ponytail" };
const receipt = {
  runId: "run-synthetic", revision: 3, state: "running",
  plan: { currentStageId: "stage-02", nextStageId: null, stages: [{ ...stage, stageId: "stage-01" }, stage] },
} as unknown as WorkflowReceiptV1;

const apiOk = <T>(data: T): ApiResultV1<T> => ({ schemaVersion: "1.0.0", ok: true, data, error: null });

function updateService(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite", currentVersion: "3.6.0", latestVersion: "3.6.0", latestTag: "v3.6.0",
    latestCommit: "a".repeat(40), etag: "workflow-skill-reselection", comparison: "up-to-date",
    lastAttemptAt: "2026-11-04T00:00:00.000Z", lastSuccessfulCheckAt: "2026-11-04T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
  });
  return new PluginUpdateService(store);
}

async function call(tool: string, outcome: ApiResultV1<unknown>, options: { classification?: boolean; locale?: SupportedLocale } = {}) {
  const service = {
    abortWorkflow: () => outcome,
    getWorkflowStatus: () => apiOk(receipt),
  } as unknown as WorkflowService;
  const classification = options.classification ? {} as SkillClassificationGateway : null;
  const server = createMcpServer(service, updateService(), undefined, undefined, undefined, new ContractValidator(), "default",
    null, null, {} as SessionMessageService, null, classification, metaIngress(), options.locale ?? "ko");
  const client = new Client({ name: "workflow-skill-reselection", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: tool, arguments: { runId: "run-synthetic", expectedRevision: 3 }, _meta: callerMeta() });
    // Other notices (such as the plugin update notice) may follow; the reselection notice is found by its skill list.
    return (response.content as Array<{ type: string; text: string }>).map(item => item.text).filter(text => text.includes("- ponytail: "));
  } finally {
    await client.close();
    await server.close();
  }
}

describe("skill reselection at a workflow change", () => {
  it("asks to match the next judgment against every installed skill and names the stage provider as a contract only", async () => {
    const [notice] = await call("abort_workflow", apiOk(receipt));
    expect(notice).toContain("다음 단계: stage-02(capability minimal-implementation). 그 결과는 ponytail provider 계약으로 기록한다.");
    expect(notice).toContain("설치된 스킬 전체의 대상과 대조하고, 맞는 스킬은 모두 지금 호출한다(없으면 0개, 여럿이면 여럿)");
    expect(notice).toContain("단계의 provider는 그 단계 결과를 기록하는 계약일 뿐이다. 그 단계에서 쓸 스킬을 제한하지 않으며, 다른 스킬을 쓰는 데 계획 수정이 필요하지 않다.");
    expect(notice).toContain("앞 단계에서 호출한 스킬의 지침은 그때의 판단·행동에만 적용한다.");
    // Expected lines written from skills/*/classification.json by hand, not by the function under test.
    expect(notice).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(notice).toContain("- test-engineering: tests, regression-tests");
    expect(notice).toContain("- blocker-diagnostician: failure-episodes, evidence");
    expect(notice).not.toContain("classify_skills");
  });

  it("offers classification advice only when the server has classification support configured", async () => {
    const [notice] = await call("abort_workflow", apiOk(receipt), { classification: true });
    expect(notice).toContain("스킬 분류 지원이 설정돼 있다. 다음 단계의 실제 작업과 전체 inventory를 classify_skills에 넘겨 조언을 받을 수 있다. 조언은 채택·교정·기각하고 최종 선택은 직접 한다.");
  });

  it("speaks the request locale", async () => {
    const [notice] = await call("abort_workflow", apiOk(receipt), { locale: "en" });
    expect(notice).toContain("call every matching skill now (none, one or several)");
    expect(notice).toContain("it does not limit the skills used in that stage, and using another skill needs no plan change");
    expect(notice).toContain("Next stage: stage-02 (capability minimal-implementation). Its result is recorded under the ponytail provider contract.");
  });

  it("adds nothing to a refused change or to a tool that changes no workflow", async () => {
    const refused: ApiResultV1<never> = { schemaVersion: "1.0.0", ok: false, data: null,
      error: contractErrorBody("STALE_REVISION", msg("workflow.service.unkeyedFailure", { message: "stale" }), null) };
    expect(await call("abort_workflow", refused)).toEqual([]);
    expect(await call("get_workflow_status", apiOk(receipt))).toEqual([]);
  });

  it("takes the stage now due from a plan, and names no stage once none is due", () => {
    const plan = { stages: [{ ...stage, stageId: "stage-01", skillId: "change-scope-guardian", requiredCapability: "change-baseline" }],
      currentStageId: null, nextStageId: "stage-01" } as unknown as WorkflowPlanV1;
    const fromPlan = workflowChangeNotice(plan, () => null, false).map(line => render(line, "en"));
    expect(fromPlan[0]).toBe("[AGS workflow change] Next stage: stage-01 (capability change-baseline). Its result is recorded under the change-scope-guardian provider contract.");
    const finished = { ...receipt, plan: { ...receipt.plan, currentStageId: null, nextStageId: null } } as WorkflowReceiptV1;
    const done = workflowChangeNotice({ runId: "run-synthetic" }, () => finished, false).map(line => render(line, "en"));
    expect(done).toHaveLength(1);
    expect(done[0]).toContain("match it against the targets of every installed skill below");
  });
});
