import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { render, type SupportedLocale } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer, serverInstructions } from "../../mcp-server/src/server.js";
import { skillIntakeText } from "../../mcp-server/src/skill-intake.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// These cases inspect the actual published instruction boundaries. Model behaviour remains NOT_RUN;
// the native pilot's late plan and read-only checkpoint failures are not replaced by these assertions.
const root = new URL("../../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");

// 4.0.0: tools/list is rendered in MODEL_LOCALE (en) whatever the SEP-2792 request language, which it now ignores; the
// ko text stays in the catalog as translation material and is checked there.
const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";

async function listedCheckpointDescription(language?: string): Promise<string> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(fileURLToPath(new URL("skills/registry.json", root)), validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, "default", null, null, undefined, null, null, null);
  const client = new Client({ name: "ags38-native-procedure-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools(language ? { _meta: { [ACCEPT_LANGUAGE_META]: language } } : undefined);
    const tool = listed.tools.find(candidate => candidate.name === "checkpoint_context");
    if (!tool?.description) throw new Error("checkpoint_context description is missing");
    return tool.description;
  } finally {
    await client.close();
    await server.close();
  }
}

/** The published description (en) for each requested language, or the ko catalog translation. */
async function checkpointDescriptions(locale: SupportedLocale): Promise<string[]> {
  if (locale === "ko") return [render({ key: "tools.checkpoint_context.description", params: {} }, "ko")];
  const listed = await Promise.all([undefined, "ko", "en"].map(listedCheckpointDescription));
  for (const description of listed) expect(description).toBe(listed[0]);
  expect(listed[0]).not.toMatch(/[가-힣]/u);
  return listed;
}

describe("native pilot procedure contracts (D31/D32/D36/D38)", () => {
  it.each(["ko", "en"] as const)("NP01 keeps read-only restrictions ahead of shared checkpoint instructions in %s", locale => {
    const intake = skillIntakeText(locale);
    expect(intake).toContain("새 사용자 메시지의 교정·결정·승인·금지·추가 작업·범위 변경");
    expect(intake).toContain("읽기 전용·상태 쓰기 금지가 아니면 그 턴에");
    // 3.9.0 (AGS3-D-0032): what to save (user quotes, changed remaining work) is stated once; 4.0.0 keeps it in the
    // checkpoint_context tool description (NP04 below) and the per-message cue only names the trigger.
    expect(intake).toContain("그 턴에 `checkpoint_context`로 반영한다");
    expect(serverInstructions(locale)).toContain(intake);
    expect(read("skills/blocker-diagnostician/references/entry-details.md")).toContain("외부 workflow 상태 쓰기에도 적용한다");
  });

  it.each([
    ["ko", "workflow 중에도 쓰며 읽기 전용·상태 쓰기 금지에서는 호출하지 않는다."],
    ["en", "Also use in workflows; never if read-only/state writes banned."],
  ] as const)("NP02 preserves the same restriction in the %s checkpoint_context description (en: tools/list for any requested language)", async (locale, restriction) => {
    for (const description of await checkpointDescriptions(locale)) expect(description).toContain(restriction);
  });

  // D53: tools/list delivery only; these clauses do not prove reconstruction quality or model behaviour.
  // 3.9.0 (AGS3-D-0053): each save rebuilds the stored state instead of appending to it.
  it.each([
    ["ko", [
      "매 저장은 덧붙이기가 아니라 재구성이다.",
      "저장된 현재 상태와 최신 요청을 대조해 중복은 합치고, 폐기된 전제와 끝난 일은 지우고, 완료 이력은 근거 참조로 바꾼다.",
      "유효한 목표, 최신 결정·권한·제약, 미완료·다음 행동, 필요한 실패·불확실성·근거와 실행 위치·병렬 수·중단·재개 조건은 보존한다.",
      "현재 행동을 바꾸는 필요한 사용자 원문은 보존하고 상세 근거는 참조하되, 대화 요약·원시 로그·workflow 원장 사본을 넣지 않는다.",
      "보고 전에도 바뀐 상태를 반영하고 무변화 저장을 하지 않는다.",
      "현재 본문·토큰이 없으면 load_context로 읽고 stateToken을 expectedStateToken에 그대로 넣는다.",
      "STALE_REVISION이면 최신 현재 상태를 읽어 재구성한다.",
    ]],
    ["en", [
      "Each save rebuilds, not appends: compare stored state with the latest request, merge duplicates, drop obsolete premises/finished work, reduce completed history to evidence refs.",
      "Keep valid goals, latest decisions/authority/constraints, unfinished work/next actions, needed failures/uncertainty/evidence and run location/parallelism/stop/resume conditions.",
      "Keep needed user quotes; reference details.",
      "No chat summaries/logs/workflow-ledger copies or secrets.",
      "Reflect changes before reports; no unchanged saves.",
      "If body/token absent, load_context; echo stateToken as expectedStateToken.",
      "STALE_REVISION: reload/rebuild.",
    ]],
  ] as const)("NP04 exposes the D53 reconstruction delivery contract in %s without claiming semantic quality", async (locale, clauses) => {
    for (const description of await checkpointDescriptions(locale))
      for (const clause of clauses) expect(description).toContain(clause);
  });

  it("NP03 makes the test plan precede test implementation and execution, with root-relative CLI references", () => {
    const skill = read("skills/test-engineering/SKILL.md");
    const planning = skill.split("\n").find(line => line.startsWith("2. ")) ?? "";
    expect(planning).toContain("계획을 작성·저장하고 `check-plan`을 확인한 뒤 테스트를 구현·실행한다");
    expect(skill).toContain("사후에 만든 계획을 선작성 근거로 보고하지 않는다");
    const guide = read("skills/orchestrator/references/engineering-practices/cli.md");
    expect(guide.indexOf("cli.mjs check-plan")).toBeLessThan(guide.indexOf("cli.mjs run --root"));
    expect(guide).toContain("`--root`는 절대경로이고 파일 참조는 그 root 아래 상대경로다");
    expect(guide).toContain("--root /absolute/work --plan .ev/plan.json");
  });
});
