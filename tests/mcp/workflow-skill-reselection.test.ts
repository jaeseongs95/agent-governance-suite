import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { contractErrorBody, type ApiResultV1, type WorkflowPlanV1, type WorkflowReceiptV1 } from "../../contracts/types.js";
import { msg, render } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer, workflowChangeNotice } from "../../mcp-server/src/server.js";
import { skillTargetsContext } from "../../mcp-server/src/skill-intake.js";
import type { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import type { SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { callerMeta, metaIngress } from "../helpers/caller.js";

// A workflow changes because the purpose of the work changed. A stage's skillId names the provider contract its result
// is recorded under, yet responses showed only the next stage ID, so the agent kept the skills it had and read the
// provider as the one skill of the stage. Every workflow change now asks to match the next judgment against every
// installed skill, names the provider as a contract only, and limits an earlier skill to the judgment it was for.
// 4.0.0 (token optimization): the notice points at the installed skill targets every context start carries
// (instructions.intake.skills, checked in d0360-skill-purpose-cue) instead of repeating the list, and the rule limiting
// an earlier skill is read there once.
const stage = { stageId: "stage-02", requiredCapability: "minimal-implementation", skillId: "minimal-implementation" };
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

// The SEP-2792 request key the server used to honor; 4.0.0 renders the notice in MODEL_LOCALE (en) and ignores it.
const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";

async function call(tool: string, outcome: ApiResultV1<unknown>, options: { classification?: boolean; language?: string } = {}) {
  const service = {
    abortWorkflow: () => outcome,
    getWorkflowStatus: () => apiOk(receipt),
  } as unknown as WorkflowService;
  // A gateway that says advice can be asked now (D-0075: the notice follows readiness, not the gateway's presence).
  const classification = options.classification ? { adviceReady: () => true } as unknown as SkillClassificationGateway : null;
  const server = createMcpServer(service, updateService(), undefined, undefined, undefined, new ContractValidator(), "default",
    null, null, {} as SessionMessageService, null, classification, metaIngress());
  const client = new Client({ name: "workflow-skill-reselection", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const meta = { ...callerMeta(), ...(options.language ? { [ACCEPT_LANGUAGE_META]: options.language } : {}) };
    const response = await client.callTool({ name: tool, arguments: { runId: "run-synthetic", expectedRevision: 3 }, _meta: meta });
    // Other notices (such as the plugin update notice) may follow; the reselection notice is found by its skill line.
    return (response.content as Array<{ type: string; text: string }>).map(item => item.text).filter(text => text.includes("The workflow changed: "));
  } finally {
    await client.close();
    await server.close();
  }
}

describe("skill reselection at a workflow change", () => {
  it("asks to match the next judgment against every installed skill and names the stage provider as a contract only", async () => {
    // Tool results are rendered in MODEL_LOCALE (en, 4.0.0); written from locales/en/server.json.
    const [notice] = await call("abort_workflow", apiOk(receipt));
    expect(notice).toContain("[AGS workflow change] Next stage: stage-02 (capability minimal-implementation); record its result under the minimal-implementation provider contract.");
    expect(notice).toContain("before the next judgment or action, re-match it against the skill targets and call every match now.");
    expect(notice).toContain("A stage's provider is only the contract its result is recorded under; it does not limit the skills used, and another skill needs no plan change.");
    // The targets of every installed skill are the list each context start carries, with the earlier-skill limit.
    // Expected lines written from skills/*/classification.json by hand, not by the function under test.
    const targets = skillTargetsContext("en");
    expect(targets).toContain("an earlier skill's guidance covers only what it was called for.");
    expect(targets).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(targets).toContain("- test-engineering: tests, regression-tests");
    expect(targets).toContain("- blocker-diagnostician: failure-episodes, evidence");
    // The notice does not repeat that list.
    expect(notice).not.toContain("- cs-engineering: ");
    expect(notice).not.toContain("classify_skills");
  });

  it("offers classification advice only when the server has classification support configured", async () => {
    const [notice] = await call("abort_workflow", apiOk(receipt), { classification: true });
    expect(notice).toContain("Skill classification support is configured: you may pass the next stage's actual work and the full inventory to classify_skills for advice. Adopt, correct or reject the advice and make the final selection yourself.");
  });

  it("speaks the model locale whatever language the request names", async () => {
    const [unnamed] = await call("abort_workflow", apiOk(receipt));
    for (const language of ["ko", "en"]) {
      const [notice] = await call("abort_workflow", apiOk(receipt), { language });
      expect(notice).toBe(unnamed);
      expect(notice).not.toMatch(/[가-힣]/u);
    }
    // The ko catalog keeps the translation.
    expect(render(msg("server.workflowChange.stage", { stageId: "stage-02", capability: "minimal-implementation", provider: "minimal-implementation" }), "ko"))
      .toBe("[AGS workflow 변경] 다음 단계: stage-02(capability minimal-implementation). 그 결과는 minimal-implementation provider 계약으로 기록한다.");
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
    const fromPlanMessages = workflowChangeNotice(plan, () => null, false);
    expect(fromPlanMessages.map(line => line.key)).toEqual(["server.workflowChange.stage", "server.workflowChange.skills", "hooks.checkpointCue.refresh"]);
    const fromPlan = fromPlanMessages.map(line => render(line, "en"));
    expect(fromPlan[0]).toBe("[AGS workflow change] Next stage: stage-01 (capability change-baseline); record its result under the change-scope-guardian provider contract.");
    const finished = { ...receipt, plan: { ...receipt.plan, currentStageId: null, nextStageId: null } } as WorkflowReceiptV1;
    const doneMessages = workflowChangeNotice({ runId: "run-synthetic" }, () => finished, false);
    expect(doneMessages.map(line => line.key)).toEqual(["server.workflowChange.skills", "hooks.checkpointCue.refresh"]);
    const done = doneMessages.map(line => render(line, "en"));
    expect(done).toHaveLength(2);
    expect(done[0]).toContain("re-match it against the skill targets and call every match now");
    expect(done.join("\n")).not.toContain("Next stage:");
    expect(done[1]).toBe("Update checkpoint_context when a finished step or failure changes goals, remaining work or needed evidence.");
    // 4.0.0: "essential state only" and "skip unchanged saves" are read once, in the checkpoint_context description
    // (d0347-checkpoint-cue).
  });
});
