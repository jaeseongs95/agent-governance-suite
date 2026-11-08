import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { CONTENT_LANGUAGE_META, render, type SupportedLocale } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import {
  SESSION_MESSAGE_SERVER_INSTRUCTIONS, SKILL_INTAKE_SERVER_INSTRUCTIONS, createMcpServer, schemaDescriptionKey, serverInstructions,
  type ToolSchemaProfile,
} from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import type { CallerIngress } from "../../mcp-server/src/caller-identity.js";
import { fixedIngress } from "../helpers/caller.js";

const root = new URL("../../", import.meta.url);
const registryPath = fileURLToPath(new URL("skills/registry.json", root));
const catalog = (locale: SupportedLocale, domain: string) =>
  JSON.parse(readFileSync(new URL(`locales/${locale}/${domain}.json`, root), "utf8")) as Record<string, string>;
const KEY = /^[a-z][A-Za-z0-9]*([.][A-Za-z0-9_-]+)+$/u;
const PROFILES: ToolSchemaProfile[] = ["default", "inline-references", "anthropic"];
const HANGUL = /[가-힣]/u;

// The SEP-2792 request key the server used to honor. 4.0.0 renders everything in MODEL_LOCALE (en) and ignores it; the
// tests still send it to show that a requested language changes nothing.
const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";

type ListedTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown };

async function connect(profile: ToolSchemaProfile = "default", ingress: CallerIngress | null = null) {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, profile, null, null, undefined, null, null, ingress);
  const client = new Client({ name: "i18n-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async list(language?: string) {
      const listed = await client.listTools(language ? { _meta: { [ACCEPT_LANGUAGE_META]: language } } : undefined);
      return { tools: listed.tools as ListedTool[], meta: listed._meta };
    },
    async call(name: string, args: Record<string, unknown>, language?: string) {
      const response = await client.callTool({ name, arguments: args, ...(language ? { _meta: { [ACCEPT_LANGUAGE_META]: language } } : {}) });
      const text = (response.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      return JSON.parse(text) as { error: { code: string; message: string; messageKey?: string; params?: Record<string, unknown> } | null };
    },
    async close() { await client.close(); await server.close(); },
  };
}

/** Every string `description` in a JSON value, with its location. */
function descriptions(value: unknown, at = ""): Array<[string, string]> {
  if (Array.isArray(value)) return value.flatMap((item, index) => descriptions(item, `${at}/${index}`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, item]): Array<[string, string]> =>
    name === "description" && typeof item === "string" ? [[at, item]] : descriptions(item, `${at}/${name}`));
}

/** The rendered texts of the catalog domains that describe tools, so ICU quoting does not matter. */
function rendered(locale: SupportedLocale): Set<string> {
  return new Set(["tools", "schema"].flatMap((domain) => Object.keys(catalog("en", domain)).map((key) => render({ key, params: {} }, locale))));
}

describe("tool descriptions in the model locale (MODEL_LOCALE, 4.0.0)", () => {
  it.each(PROFILES)("renders every advertised description from the English catalog whatever language the request names (%s)", async (profile) => {
    const fixture = await connect(profile);
    try {
      const unnamed = await fixture.list();
      const english = await fixture.list("en-US,ko;q=0.5");
      const korean = await fixture.list("ko-KR");
      for (const listed of [unnamed, english, korean]) {
        expect(listed.meta).toEqual({ [CONTENT_LANGUAGE_META]: "en" });
        // A requested language changes nothing: names, annotations, schema shapes and description texts are the same.
        expect(listed.tools).toEqual(unnamed.tools);
      }
      const enTexts = rendered("en");
      const enDescriptions = descriptions(unnamed.tools);
      // Tool descriptions plus input-field descriptions (server.ts and contract files): each comes from the catalog.
      expect(enDescriptions.length).toBeGreaterThan(unnamed.tools.length);
      for (const [at, text] of enDescriptions) {
        expect(enTexts.has(text), at).toBe(true);
        expect(text, at).not.toMatch(HANGUL);
      }
      // A repeated list is the kept copy, not a rebuild.
      expect((await fixture.list("en")).tools).toEqual(unnamed.tools);
    } finally { await fixture.close(); }
  });

  it("keeps the English source text of tool descriptions unchanged", async () => {
    const fixture = await connect();
    try {
      const tools = new Map((await fixture.list()).tools.map((tool) => [tool.name, tool]));
      expect(tools.get("start_workflow")?.description).toContain("Start a guarded workflow in one call");
      expect(tools.get("abort_workflow")?.description).toBe("Abort a non-terminal workflow; use responseMode=compact to avoid returning the full terminal receipt.");
      expect(tools.get("acknowledge_session_messages")?.description).toBe(catalog("en", "tools")["tools.acknowledge_session_messages.description"]);
      const stages = (tools.get("start_workflow")?.inputSchema.properties as Record<string, { description?: string }>).stages;
      expect(stages?.description).toBe("Capabilities from the skill registry, chosen by the AGENT, e.g. minimal-implementation. Stages that produce required artifacts are refused here; use plan_workflow for them.");
      const requestedKorean = new Map((await fixture.list("ko")).tools.map((tool) => [tool.name, tool.description]));
      expect(requestedKorean.get("abort_workflow")).toBe(tools.get("abort_workflow")?.description);
      // The ko catalog stays as translation material with the original wording, unchanged.
      expect(catalog("ko", "tools")["tools.abort_workflow.description"]).toBe("종료되지 않은 workflow를 중단한다. 전체 종료 영수증을 돌려받지 않으려면 responseMode=compact를 쓴다.");
      expect(catalog("ko", "tools")["tools.acknowledge_session_messages.description"]).toMatch(/^실제로 처리한 서로 다른 피어 메시지를 한 번에 수신 확인한다\./u);
    } finally { await fixture.close(); }
  });

  it("renders ICU-quoted braces as the literal text", async () => {
    const fixture = await connect("anthropic");
    try {
      const plan = (await fixture.list()).tools.find((tool) => tool.name === "plan_workflow");
      expect(plan?.inputSchema.description).toBe("Send either a TaskEnvelope.v1 object at the top level, or { schemaVersion, taskEnvelope, evaluationAuditPurpose?, requiredAuditPhase? }. The server validates the exact PlanWorkflowRequest.v1 contract.");
    } finally { await fixture.close(); }
  });
});

describe("schema description catalog (docs/contributing/i18n.md 5.2)", () => {
  // Contract files are not edited (CONTENT_LOCK); the English catalog must follow them, so a changed schema text fails here.
  it("has the English text of the contract file at each key's position", () => {
    const fromFiles = new Map<string, string>();
    for (const file of readdirSync(new URL("contracts/", root)).filter((name) => name.endsWith(".schema.json"))) {
      const document: unknown = JSON.parse(readFileSync(new URL(`contracts/${file}`, root), "utf8"));
      const walk = (node: unknown, pointer: string[]): void => {
        if (Array.isArray(node)) { node.forEach((item, index) => walk(item, [...pointer, String(index)])); return; }
        if (!node || typeof node !== "object") return;
        for (const [name, value] of Object.entries(node)) {
          if (name === "description" && typeof value === "string") {
            const key = schemaDescriptionKey(file, [...pointer, name]);
            expect(key, `${file}#/${pointer.join("/")}`).toMatch(KEY);
            expect(fromFiles.has(key), key).toBe(false);
            fromFiles.set(key, value);
          } else walk(value, [...pointer, name]);
        }
      };
      walk(document, []);
    }
    const keys = Object.keys(catalog("en", "schema"));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(fromFiles.has(key), `${key}: no such description in contracts/`).toBe(true);
      expect(render({ key, params: {} }, "en"), key).toBe(fromFiles.get(key));
    }
  });

  it("derives keys from the file name and JSON Pointer", () => {
    expect(schemaDescriptionKey("stage-result.v1.schema.json", ["$defs", "evidence", "properties", "digest", "description"]))
      .toBe("schema.stageResultV1.defs.evidence.properties.digest.description");
  });
});

describe("server instructions (docs/contributing/i18n.md 4.2, 6)", () => {
  // 4.0.0: the instructions are model-only text, rendered in MODEL_LOCALE (en); the server has no default locale left.
  // The English frame has no label, so the installed intake block comes first. The ko catalog stays as translation material.
  it("renders the session guidance in the model locale after the installed intake block", async () => {
    const shared = readFileSync(new URL("skills/orchestrator/references/intake.md", root), "utf8");
    const intake = shared.split("<!-- skill-intake:start -->\n")[1]?.split("\n<!-- skill-intake:end -->")[0] ?? "";
    expect(intake).not.toBe("");
    expect(serverInstructions("ko")).toBe(`${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}`);
    expect(serverInstructions("ko").startsWith("AGS 공통 접수 기준:\n\n")).toBe(true);
    const english = serverInstructions("en");
    expect(serverInstructions()).toBe(english);
    expect(english).not.toBe(serverInstructions("ko"));
    expect(english.startsWith(`${intake}\n`)).toBe(true);
    expect(english.split(intake)).toHaveLength(2);
    // 3.9.0 (AGS3-D-0032): the guide keeps what the message tool descriptions lack (after-send wake handling and the
    // reporting rule); prepare/send/ACK meanings are in each tool description. Written from locales/en/instructions.json.
    expect(english).toContain("After send: autoWake available → no extra wake;");
    expect(english).toContain("Report only confirmed queueing/delivery, not autoWake.");
    expect(english.replace(intake, "")).not.toMatch(HANGUL);
    for (const profile of PROFILES) {
      const fixture = await connect(profile);
      try {
        const received = fixture.client.getInstructions();
        expect(received).toBe(english);
        // T-0020 PA03: the initialize response delivered to the client, not just the local source string.
        expect(received?.split("하위 결과·기록·잘못은 생성한 부모가")).toHaveLength(2);
        expect(received).toContain("부모가 근거를 직접 확인·정정하며 자식에게 책임을 넘기거나");
        expect(received).toContain("자식에게 책임을 넘기거나 불필요한 자식 전용 차단·권한·식별 계층을 더하지 않는다");
      } finally { await fixture.close(); }
    }
  });
});

// 3.9.0 (AGS3-D-0032): the 3.8.2 instructions reached a Claude Code session cut off with "[truncated]" after about
// 4,060 characters, so the session-message guide never arrived. Both locales keep the whole MCP instructions within one
// budget below that point. Codex and Antigravity limits are not measured; the same budget applies to every host.
const INSTRUCTIONS_BUDGET = 4000;
describe("server instructions size (AGS3-D-0032)", () => {
  it.each(["ko", "en"] as const)("keeps the whole %s MCP instructions within the shared budget", locale => {
    expect([...serverInstructions(locale)].length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
  });
});

describe("server.ts error messages (MODEL_LOCALE, 4.0.0)", () => {
  it("renders a server error from its key in English whatever language the request names", async () => {
    const fixture = await connect();
    try {
      for (const language of [undefined, "ko", "en"]) {
        expect((await fixture.call("get_trust_capabilities", {}, language)).error).toMatchObject({ code: "BINDING_REQUIRED",
          messageKey: "server.call.callerIngressMissing", params: {}, message: "No host caller ingress is configured for this server." });
      }
      // The ko catalog keeps the translation.
      expect(render({ key: "server.call.callerIngressMissing", params: {} }, "ko")).toBe("이 서버에는 호스트 호출자 ingress가 설정되지 않았다.");
    } finally { await fixture.close(); }
  });

  it("fills params into the sentence", async () => {
    const fixture = await connect("default", fixedIngress());
    try {
      for (const language of [undefined, "ko", "en"]) {
        expect((await fixture.call("get_workflow_status", { runId: "run", detail: "bogus" }, language)).error).toMatchObject({ code: "INVALID_INPUT",
          messageKey: "server.call.responseModeInvalid", params: { field: "detail" }, message: "detail must be compact or full." });
      }
      expect(render({ key: "server.call.responseModeInvalid", params: { field: "detail" } }, "ko")).toBe("detail 값은 compact 또는 full이어야 한다.");
    } finally { await fixture.close(); }
  });

  it("keeps send_session_message retry guidance one sentence after the cause", async () => {
    const fixture = await connect("default", fixedIngress());
    try {
      const english = await fixture.call("send_session_message", { schemaVersion: "1.0.0" });
      expect(english.error).toMatchObject({ code: "INVALID_INPUT", messageKey: "server.sessionMessage.sendInvalid" });
      // The cause is itself a catalog message, rendered in the same locale.
      const cause = english.error?.params?.cause as { key: string; params: Record<string, unknown> };
      expect(cause).toMatchObject({ key: expect.any(String), params: expect.any(Object) });
      expect(english.error?.message).toBe(`${render(cause, "en")} Use prepare_session_message for a new intent, then send only its returned messageId. For an uncertain prior send, retry that known ID or compare saved receipts/status.`);
      expect((await fixture.call("send_session_message", { schemaVersion: "1.0.0" }, "ko")).error?.message).toBe(english.error?.message);
      expect(render({ key: "server.sessionMessage.sendInvalid", params: { cause } }, "ko"))
        .toBe(`${render(cause, "ko")} 새 전송 의도에는 prepare_session_message를 쓰고, 그 결과로 받은 messageId만 보낸다. 이전 전송 결과가 불확실하면 이미 아는 그 ID로 재시도하거나 저장한 영수증·status를 대조한다.`);
    } finally { await fixture.close(); }
  });
});
