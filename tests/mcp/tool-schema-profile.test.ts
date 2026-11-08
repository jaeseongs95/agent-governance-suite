import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { stdioServerTests } from "../helpers/stdio-server.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveToolSchemaProfile } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator, contractSchemas } from "../../mcp-server/src/schema-validator.js";
import { SESSION_MESSAGE_SERVER_INSTRUCTIONS, SKILL_INTAKE_SERVER_INSTRUCTIONS, createMcpServer, planWorkflowToolInputSchema, serverInstructions, type ToolSchemaProfile } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";
import { RESERVED_CALLER_KEYS, type CallerIngress } from "../../mcp-server/src/caller-identity.js";
import { codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { fixedIngress, rootCaller } from "../helpers/caller.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));
const combinators = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"];

type ListedTool = { name: string; inputSchema: Record<string, unknown> };
type ProtocolTrace = Array<{direction: "client" | "server"; wire: string}>;

function updateService(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: CURRENT_VERSION,
    latestVersion: STABLE_VERSION,
    latestTag: `v${STABLE_VERSION}`,
    latestCommit: "d".repeat(40),
    etag: "tool-schema-profile",
    comparison: "up-to-date",
    lastAttemptAt: "2026-09-17T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-09-17T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z",
    lastNotifiedVersion: null,
    lastNotifiedAt: null,
    lastErrorCode: null,
  });
  return new PluginUpdateService(store);
}

// 4.0.0: tool texts and instructions are rendered in MODEL_LOCALE (en); the server has no default locale to set.
// The SEP-2792 request key it used to honor is still sent below to show a requested language changes nothing.
const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";

async function connect(profile?: ToolSchemaProfile, trace?: ProtocolTrace, ingress: CallerIngress | null = fixedIngress(rootCaller())): Promise<Client> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, updateService(), undefined, undefined, undefined, validator, profile, null, null, undefined, null, null, ingress);
  const client = new Client({ name: "tool-schema-profile", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (trace) {
    for (const [direction, transport] of [["client", clientTransport], ["server", serverTransport]] as const) {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        // Use the production stdio codec; this observes MCP bytes, not the host's model-input projection.
        const wire = serializeMessage(message);
        trace.push({direction, wire});
        await send(deserializeMessage(wire), options);
      };
    }
  }
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function errorCode(response: unknown): string | null {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === "text")?.text ?? "{}";
  return (JSON.parse(text) as { error?: { code?: string } | null }).error?.code ?? null;
}

function errorReason(response: unknown): [string | null, string | null] {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const error = (JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}") as {
    error?: { code?: string; details?: { reasonCode?: string } } | null;
  }).error;
  return [error?.code ?? null, error?.details?.reasonCode ?? null];
}

// Every host-owned caller key, including _hostAttestation; none is a tool argument.
const CALLER_FIELDS = RESERVED_CALLER_KEYS;

describe("MCP tool schema profiles", () => {
  it("업무 필수 인자를 보존하고 호출자 신원 필드는 도구 입력으로 광고하지 않는다", async () => {
    const implicit = await connect();
    const explicit = await connect("default");
    try {
      const implicitTools = (await implicit.listTools()).tools;
      expect((await explicit.listTools()).tools).toEqual(implicitTools);
      const planning = implicitTools.find((tool) => tool.name === "plan_workflow")?.inputSchema;
      const domain = planWorkflowToolInputSchema("default") as Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };
      expect(planning).toEqual(domain);
      for (const tool of implicitTools) {
        expect(tool.description?.length ?? 0, tool.name).toBeLessThanOrEqual(1024);
        for (const field of CALLER_FIELDS) {
          expect(tool.inputSchema.properties ?? {}, `${tool.name}.${field}`).not.toHaveProperty(field);
          expect(tool.inputSchema.required ?? [], `${tool.name}.${field}`).not.toContain(field);
          expect(JSON.stringify(tool.inputSchema), `${tool.name}.${field}`).not.toContain(field);
        }
      }
      // Hosts cap tool descriptions at 1024 characters. Whatever language a request names, the same English list is
      // returned, so it fits too.
      for (const language of ["en", "ko"]) {
        const listed = (await implicit.listTools({ _meta: { [ACCEPT_LANGUAGE_META]: language } })).tools;
        expect(listed, language).toEqual(implicitTools);
        for (const tool of listed) expect(tool.description?.length ?? 0, `${language} ${tool.name}`).toBeLessThanOrEqual(1024);
      }
      expect(planning).toMatchObject({ type: "object", oneOf: expect.any(Array) });
    } finally {
      await implicit.close();
      await explicit.close();
    }
  });

  it("removes top-level combinators from every advertised schema for Anthropic hosts", async () => {
    const client = await connect("anthropic");
    const fallback = await connect();
    try {
      const tools = (await client.listTools()).tools as ListedTool[];
      const defaults = (await fallback.listTools()).tools as ListedTool[];
      expect(tools.map((tool) => tool.name)).toEqual(defaults.map((tool) => tool.name));
      for (const tool of tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        for (const field of CALLER_FIELDS) expect(JSON.stringify(tool.inputSchema), `${tool.name}.${field}`).not.toContain(field);
        for (const keyword of combinators) expect(tool.inputSchema, `${tool.name}.${keyword}`).not.toHaveProperty(keyword);
      }
      const planning = tools.find((tool) => tool.name === "plan_workflow")!.inputSchema;
      expect(Object.keys(planning.properties as object)).toEqual(expect.arrayContaining(["taskEnvelope", "evaluationAuditPurpose", "taskId"]));
      expect(JSON.stringify(planning)).not.toContain("executionContext");
      expect(JSON.stringify(planning)).not.toContain("$ref");
      // Flat plan_workflow/load_context and schemas that use $ref differ; Claude Code cannot resolve references.
      const referencing = defaults.filter((tool) => JSON.stringify(tool.inputSchema).includes("$ref")).map((tool) => tool.name);
      expect(referencing).toEqual(expect.arrayContaining(["open_convergence_root", "claim_workflow_attempt", "start_guarded_workflow", "record_stage_result"]));
      for (const tool of tools) {
        expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$ref");
        expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$defs");
      }
      const changed = tools.filter((tool) => JSON.stringify(tool) !== JSON.stringify(defaults.find((entry) => entry.name === tool.name)));
      expect(changed.map((tool) => tool.name).sort()).toEqual([...new Set(["plan_workflow", "load_context", ...referencing])].sort());
    } finally {
      await client.close();
      await fallback.close();
    }
  });

  it("accepts and rejects the same inputs with inlined Anthropic schemas as with the referenced contracts", async () => {
    const anthropic = await connect("anthropic");
    const fallback = await connect();
    try {
      const inlined = (await anthropic.listTools()).tools as ListedTool[];
      const referenced = (await fallback.listTools()).tools as ListedTool[];
      const options = { strict: false, allErrors: true, validateFormats: false };
      const inlineAjv = new Ajv2020(options);
      const contractAjv = new Ajv2020(options);
      for (const document of Object.values(contractSchemas)) contractAjv.addSchema(document as object);
      const compileReferenced = (schema: Record<string, unknown>) => {
        const copy = structuredClone(schema);
        delete copy.$id;
        return contractAjv.compile(copy);
      };
      const task = {
        schemaVersion: "1.0.0", taskId: "inline", objective: "Check inlined schemas.",
        scope: { included: ["x"], excluded: [] }, acceptanceCriteria: ["x"], riskLevel: "low",
        workUnits: [{ id: "u", objective: "x", dependencies: [], writeTargets: ["x.md"] }],
        requiredCapabilities: ["task-decomposition"], constraints: [],
        authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
        decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
      };
      const frame = {
        schemaVersion: "1.0.0", workspace: { workspaceId: "w", locator: "fixture:w" },
        controlArtifacts: [{ artifactId: "a", role: "pass-condition", locator: "fixture:a", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "c", role: "candidate", locator: "fixture:c", digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
      };
      const open = { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [], responseMode: "compact" };
      const cases: Array<[string, Record<string, unknown>]> = [
        ["open_convergence_root", open],
        ["open_convergence_root", { ...open, taskEnvelope: JSON.stringify(task) }],
        ["open_convergence_root", { ...open, frame: JSON.stringify(frame) }],
        ["open_convergence_root", { ...open, frame: { ...frame, operationalSettings: { ...frame.operationalSettings, maxEpochs: 9 } } }],
        ["record_stage_result", { schemaVersion: "1.0.0", runId: "r", stageId: "s", expectedRevision: 0, state: "passed", output: { schemaVersion: "1.0.0", kind: "output", output: {}, artifacts: [], error: null }, evidence: [], findings: [], blockers: [], error: null }],
        ["record_stage_result", { schemaVersion: "1.0.0", runId: "r", stageId: "s", expectedRevision: 0, state: "passed", output: "{}", evidence: [], findings: [], blockers: [], error: null }],
      ];
      for (const [name, input] of cases) {
        const inline = inlineAjv.compile(inlined.find((tool) => tool.name === name)!.inputSchema);
        const reference = compileReferenced(referenced.find((tool) => tool.name === name)!.inputSchema);
        expect(inline(input), `${name} ${JSON.stringify(input).slice(0, 80)}`).toBe(reference(input));
      }
      // D53's current load and signed-candidate selection keep the exact input boundary in both profiles.
      const loadInputs: Array<[Record<string, unknown>, boolean]> = [
        [{ schemaVersion: "1.0.0" }, true],
        [{ schemaVersion: "1.0.0", candidateToken: "a".repeat(16) }, true],
        [{}, false],
        [{ schemaVersion: "2.0.0" }, false],
        [{ schemaVersion: "1.0.0", candidateToken: "a".repeat(15) }, false],
        [{ schemaVersion: "1.0.0", candidateToken: null }, false],
        [{ schemaVersion: "1.0.0", candidateToken: 16 }, false],
        [{ schemaVersion: "1.0.0", epoch: 1 }, false],
        [{ schemaVersion: "1.0.0", sessionId: "other-session" }, false],
      ];
      const inlineLoad = inlineAjv.compile(inlined.find((tool) => tool.name === "load_context")!.inputSchema);
      const referenceLoad = compileReferenced(referenced.find((tool) => tool.name === "load_context")!.inputSchema);
      for (const [input, expected] of loadInputs) {
        expect(inlineLoad(input), JSON.stringify(input)).toBe(expected);
        expect(referenceLoad(input), JSON.stringify(input)).toBe(expected);
      }
      expect(inlineAjv.compile(inlined.find((tool) => tool.name === "open_convergence_root")!.inputSchema)(open)).toBe(true);
    } finally {
      await anthropic.close();
      await fallback.close();
    }
  });

  it("validates plan_workflow input identically in both profiles", async () => {
    const anthropic = await connect("anthropic");
    const fallback = await connect();
    const inputs: Array<Record<string, unknown>> = [
      {},
      { schemaVersion: "1.0.0" },
      { schemaVersion: "1.0.0", taskEnvelope: { schemaVersion: "1.0.0" } },
      { schemaVersion: "1.0.0", taskEnvelope: {}, unexpected: true },
      { taskId: "mixed", taskEnvelope: {} },
    ];
    try {
      for (const input of inputs) {
        const fromAnthropic = errorCode(await anthropic.callTool({ name: "plan_workflow", arguments: input }));
        const fromDefault = errorCode(await fallback.callTool({ name: "plan_workflow", arguments: input }));
        expect(fromAnthropic, JSON.stringify(input)).toBe(fromDefault);
        expect(fromAnthropic, JSON.stringify(input)).toBe("INVALID_INPUT");
      }
    } finally {
      await anthropic.close();
      await fallback.close();
    }
  });

  it("enables the Anthropic profile only for the exact environment value", () => {
    expect(resolveToolSchemaProfile({})).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "" })).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "Anthropic" })).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "anthropic" })).toBe("anthropic");
  });

  it.each(["default", "anthropic"] as const)("keeps unobserved callers and caller fields in arguments negative in %s", async profile => {
    const unconfigured = await connect(profile, undefined, null);
    const client = await connect(profile, undefined, codexMetaIngress());
    try {
      expect(errorReason(await unconfigured.callTool({ name: "plan_workflow", arguments: {} }))).toEqual(["BINDING_REQUIRED", "HOST_INGRESS_UNAVAILABLE"]);
      expect(errorReason(await client.callTool({ name: "plan_workflow", arguments: {} }))).toEqual(["BINDING_REQUIRED", "CALLER_PROVENANCE_UNAVAILABLE"]);
      for (const field of RESERVED_CALLER_KEYS) {
        expect(errorReason(await client.callTool({ name: "plan_workflow", arguments: { [field]: "synthetic-forged-caller" } })), field)
          .toEqual(["INVALID_INPUT", "RESERVED_CALLER_FIELD"]);
      }
      expect(errorReason(await client.callTool({ name: "plan_workflow", arguments: {
        _sessionBinding: { host: "forged-host", sessionId: "forged-session" },
      } }))).toEqual(["INVALID_INPUT", "RESERVED_CALLER_FIELD"]);
    } finally { await client.close(); await unconfigured.close(); }
  });

  it("advertises the same host-neutral intake instructions to every schema profile", async () => {
    // The ko rendering stays as translation material; every profile receives the MODEL_LOCALE (en) rendering.
    expect(serverInstructions("ko")).toBe(`${SKILL_INTAKE_SERVER_INSTRUCTIONS}\n${SESSION_MESSAGE_SERVER_INSTRUCTIONS}`);
    const expected = serverInstructions("en");
    expect(serverInstructions()).toBe(expected);
    // Initialization projects the actual shared criteria, not merely their location.
    const shared = await readFile(new URL("../../skills/orchestrator/references/intake.md", import.meta.url), "utf8");
    const intake = shared.split("<!-- skill-intake:start -->\n")[1]?.split("\n<!-- skill-intake:end -->")[0];
    expect(intake).toBeTruthy();
    expect(SKILL_INTAKE_SERVER_INSTRUCTIONS.split(intake!)).toHaveLength(2);
    expect(expected.split(intake!)).toHaveLength(2);
    // Outside the projected block, no common sentence may be repeated or pre-stated.
    const outside = expected.split(intake!).join("\n");
    const sentences = intake!.split("\n").filter((line) => !line.startsWith("#")).flatMap((line) => line.replace(/^- /u, "").split(/(?<=다\.) /u)).filter((sentence) => sentence.length > 20);
    expect(sentences.length).toBeGreaterThan(10);
    for (const sentence of sentences) expect(outside.includes(sentence), sentence).toBe(false);
    expect(SKILL_INTAKE_SERVER_INSTRUCTIONS).not.toMatch(/실패 영향이 낮으면|BINDING_/u);
    expect(expected).not.toMatch(/실패 영향이 낮으면|BINDING_/u);
    // Skill IDs are common; native invocation syntax remains in adapters.
    for (const hostSpecific of [/Skill 도구/u, /\/agent-governance-suite:/u, /(?<![\w$])\$[a-z][a-z0-9-]*/u, /Claude/u, /Codex/u, /Anthropic/iu, /UserPromptSubmit/u]) {
      expect(expected).not.toMatch(hostSpecific);
    }
    const traces: ProtocolTrace[] = [[], [], []];
    const implicit = await connect(undefined, traces[0]);
    const codex = await connect("default", traces[1]);
    const claude = await connect("anthropic", traces[2]);
    try {
      for (const trace of traces) {
        const requests = trace.filter(row => row.direction === "client").map(row => JSON.parse(row.wire));
        const initialize = requests.find(row => row.method === "initialize");
        expect(initialize).toBeDefined();
        // Intake must arrive before discovery or selection of any AGS tool.
        expect(requests.some(row => row.method === "tools/list" || row.method === "tools/call")).toBe(false);
        const response = trace.filter(row => row.direction === "server").map(row => JSON.parse(row.wire))
          .find(row => row.id === initialize.id && row.result);
        expect(response?.result.instructions).toBe(expected);
        // 4.0.0 (token optimization): "classification support only where configured" left the instructions; every
        // profile reads it in the classify_skills description from tools/list (checked below).
        expect(response.result.instructions).toContain("독립 작업을 계속하며 턴·전체 작업을 끝내지 않는다.");
        expect(Object.keys(response.result)).toEqual(expect.arrayContaining(["protocolVersion", "capabilities", "serverInfo", "instructions"]));
      }
      expect(implicit.getInstructions()).toBe(expected);
      expect(codex.getInstructions()).toBe(expected);
      expect(claude.getInstructions()).toBe(expected);
      // Profiles differ only in the advertised schema conversion.
      const [codexTools, claudeTools] = [(await codex.listTools()).tools, (await claude.listTools()).tools];
      expect(claudeTools.map((tool) => tool.name)).toEqual(codexTools.map((tool) => tool.name));
      const withoutSchema = (tools: typeof codexTools) => tools.map((tool) => ({ ...tool, inputSchema: null }));
      expect(withoutSchema(claudeTools)).toEqual(withoutSchema(codexTools));
      // 3.9.0 (AGS3-D-0032): the classification details left the instructions for the classify_skills description,
      // which every profile receives in tools/list before the call.
      for (const tools of [(await implicit.listTools()).tools, codexTools, claudeTools]) {
        const classify = tools.find((tool) => tool.name === "classify_skills")?.description ?? "";
        // tools/list is rendered in MODEL_LOCALE (en); written from locales/en/tools.json.
        expect(classify).toContain("Do not assume classification support is configured only because this tool is exposed.");
        expect(classify).toContain("undecided, refused, unavailable or unverified is not success");
        expect(classify).toContain("follow the shared classification contract failure handling and continue the independent work with skills you choose");
      }
    } finally {
      await implicit.close();
      await codex.close();
      await claude.close();
    }
  });

  // The bundled server starts before the test's time limit starts (stdioServerTests); the limit measures the calls.
  const serverTest = stdioServerTests();
  serverTest("applies the environment profile in the bundled server", async (scope) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "tool-schema-profile-"));
    scope.defer(() => rm(stateDirectory, { recursive: true, force: true }));
    const environment = getDefaultEnvironment();
    environment.AGENT_GOVERNANCE_SHARED_STATE_DIR = stateDirectory;
    environment.AGENT_GOVERNANCE_DB_PATH = join(stateDirectory, "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    environment.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE = "anthropic";
    // A host locale no longer changes anything: the bundled server still sends the MODEL_LOCALE (en) instructions.
    environment.AGENT_GOVERNANCE_LOCALE = "ko";
    return scope.connect("tool-schema-profile-stdio", { command: process.execPath, args: [bundledServer], cwd: rootDirectory, env: environment });
  }, async ({ client }) => {
    const planning = (await client.listTools()).tools.find((tool) => tool.name === "plan_workflow")?.inputSchema;
    expect(planning).toBeDefined();
    expect(planning).not.toHaveProperty("oneOf");
    expect(client.getInstructions()).toBe(serverInstructions("en"));
  }, 30_000);
});
