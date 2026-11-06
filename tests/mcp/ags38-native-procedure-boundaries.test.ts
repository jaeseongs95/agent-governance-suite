import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { ACCEPT_LANGUAGE_META, type SupportedLocale } from "../../mcp-server/src/i18n.js";
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

async function checkpointDescription(locale: SupportedLocale): Promise<string> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(fileURLToPath(new URL("skills/registry.json", root)), validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, "default", null, null, undefined, null, null, null, locale);
  const client = new Client({ name: "ags38-native-procedure-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools({ _meta: { [ACCEPT_LANGUAGE_META]: locale } });
    const tool = listed.tools.find(candidate => candidate.name === "checkpoint_context");
    if (!tool?.description) throw new Error("checkpoint_context description is missing");
    return tool.description;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("native pilot procedure contracts (D31/D32/D36/D38)", () => {
  it.each(["ko", "en"] as const)("NP01 keeps read-only restrictions ahead of shared checkpoint instructions in %s", locale => {
    const intake = skillIntakeText(locale);
    expect(intake).toContain("새 사용자 메시지의 교정·결정·승인·금지·추가 작업·범위 변경");
    expect(intake).toContain("읽기 전용·상태 쓰기 금지가 아니면 그 턴에");
    expect(intake).toContain("`checkpoint_context`로 원문과 바뀐 남은 일을 저장한다");
    expect(serverInstructions(locale)).toContain(intake);
    expect(read("skills/blocker-diagnostician/references/entry-details.md")).toContain("외부 workflow 상태 쓰기에도 적용한다");
  });

  it.each([
    ["ko", "읽기 전용이거나 상태 쓰기가 금지된 요청에서는 호출하지 않는다"],
    ["en", "Do not call it for a read-only request or when state writes are prohibited"],
  ] as const)("NP02 preserves the same restriction in the %s tools/list description", async (locale, restriction) => {
    expect(await checkpointDescription(locale)).toContain(restriction);
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
