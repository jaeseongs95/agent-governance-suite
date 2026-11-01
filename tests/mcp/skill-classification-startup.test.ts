import {execFileSync} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect} from "vitest";
import {stdioServerTests} from "../helpers/stdio-server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Each case's server starts before the case's time limit starts (stdioServerTests); the limit measures the calls.
const serverTest = stdioServerTests();
for (const mode of ["unsupported-sibling", "invalid-isolation"] as const) serverTest(`actual index startup preserves ${mode} classification state and safe diagnostics`, async ({defer, connect}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-native-startup-"));
  defer(() => rm(directory, {recursive: true, force: true}));
  const profilesPath = path.join(directory, "profiles.json"), definitionsPath = path.join(directory, "native.json"), configPath = path.join(directory, "config.json");
  const normal = {adapterId: "synthetic-native", host: "codex", executable: process.execPath, workingDirectory: directory,
    approvalRef: "fixture-only", capabilityEvidenceRef: "fixture-only", retryPolicyVerified: true, retryPolicyEvidenceRef: "fixture-only",
    isolationEvidenceRef: "fixture-only", isolationArgs: [] as string[], timeoutMs: 100, maximumOutputBytes: 64000};
  const unsupported: Record<string, unknown> = {...normal, adapterId: "unsupported", executable: "relative-unavailable-cli"}; delete unsupported.approvalRef;
  const definitions = mode === "invalid-isolation" ? [{...normal, isolationArgs: ["--model", "PRIVATE_NATIVE_ARGUMENT"]}] : [unsupported, normal];
  await writeFile(profilesPath, JSON.stringify({schemaVersion: "1.0.0", profileRevision: "startup-fixture", profiles: []}), "utf8");
  await writeFile(definitionsPath, JSON.stringify(definitions), "utf8");
  await writeFile(configPath, JSON.stringify({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: profilesPath,
    externalClassificationAllowed: false, configRevision: "startup-fixture", timeoutMs: 1000}, allowRemotePrivateContent: false,
    nativeAdapterDefinitionsRef: definitionsPath}), "utf8");
  const environment = Object.fromEntries(Object.entries({...process.env,
    AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: configPath, AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code", SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"), AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"), AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  // Existing source-stdio test runner: actual index, producer, factory, catch and MCP gateway. No native CLI invocation.
  let diagnostic = "";
  const diagnosticPrefix = "[agent-governance-suite] classification-initialization-failed ";
  let received!: () => void;
  const diagnosticReceived = new Promise<void>(resolve => {received = resolve;});
  const server = await connect("native-startup-source-fixture", {command: process.execPath, args: ["--import", "tsx", path.join(root, "mcp-server", "src", "index.ts")], cwd: root, env: environment},
    stream => stream?.on("data", chunk => {
      diagnostic += String(chunk);
      if (diagnostic.split(/\r?\n/u).slice(0, -1).some(line => line.startsWith(diagnosticPrefix))) received();
    }));
  return {directory, definitionsPath, environment, diagnosticPrefix, diagnosticReceived, diagnostic: () => diagnostic, server};
}, async ({directory, definitionsPath, environment, diagnosticPrefix, diagnosticReceived, diagnostic, server}) => {
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  const {client} = server;
  try {
    // 모델 입력에는 호출자 신원을 요구하지 않지만, 호스트가 관측하지 않은 실서버 호출은 거부한다.
    const advertised = (await client.listTools()).tools;
    for (const name of ["get_skill_inventory", "classify_skills"]) {
      const schema = advertised.find(tool => tool.name === name)?.inputSchema;
      expect(schema, name).toBeDefined();
      expect(JSON.stringify(schema), name).not.toContain("_sessionProof");
    }
    const unadmitted = await client.callTool({name: "get_skill_inventory", arguments: {}});
    expect(JSON.parse((unadmitted.content as Array<{text?: string}>).find(item => item.text)!.text!).error).toMatchObject({
      code: "BINDING_REQUIRED", details: {reasonCode: "CALLER_PROVENANCE_UNAVAILABLE"},
    });
    // Built CLI on owned synthetic Claude input; no native identity collection. It records the admission and prints nothing.
    const admit = (toolUseId: string, tool: string, toolInput: Record<string, unknown>) => {
      const output = execFileSync(process.execPath, [path.join(root, "mcp-server", "dist", "governance-hook.mjs"), "--host=claude-code"], {
        cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "synthetic-startup-root", tool_use_id: toolUseId,
          tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: toolInput, cwd: directory }),
      });
      expect(output).toBe("");
      return {"claudecode/toolUseId": toolUseId};
    };
    const reply = await client.callTool({name: "get_skill_inventory", arguments: {}, _meta: admit("inventory-call", "get_skill_inventory", {})});
    const text = (reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!;
    const result = JSON.parse(text) as {ok: boolean; data: {issues: Array<{code: string}>}};
    expect(result.ok).toBe(true);
    const disabled = result.data.issues.some(issue => issue.code === "CONFIGURED_DISCOVERY_UNAVAILABLE");
    expect(disabled).toBe(mode === "invalid-isolation");
    if (mode === "invalid-isolation") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([diagnosticReceived, new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new Error("STARTUP_DIAGNOSTIC_TIMEOUT")), 2000);})]);
      } finally {if (timer !== undefined) clearTimeout(timer);}
    }
    const records = diagnostic().split(/\r?\n/u).filter(line => line.startsWith(diagnosticPrefix));
    if (mode === "invalid-isolation") {
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!.slice(records[0]!.indexOf("{")))).toEqual({phase: "classification-initialization", reason: "INVALID_NATIVE_ISOLATION_ARGUMENT"});
    } else expect(records).toHaveLength(0);
    if (mode === "invalid-isolation") {
      // D0068: a valid follow-up classify call reports the typed initialization reason, and the server keeps serving.
      const classifyInput = {schemaVersion: "1.0.0", requestId: "startup-fixture", operationId: "startup-fixture", originalPrompt: "fixture",
        confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
        contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "fixture", reference: "fixture"}, publicSynthetic: true};
      // The synthetic hook input has no transcript, so the admission carries no execution observation and the
      // server has none to qualify; the initialization failure is what the call reports.
      const classified = await client.callTool({name: "classify_skills", arguments: classifyInput, _meta: admit("classify-call", "classify_skills", classifyInput)});
      const classifiedText = (classified.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!;
      const classifiedResult = JSON.parse(classifiedText) as {ok: boolean; error: {code: string; details: unknown} | null};
      expect(classifiedResult.ok).toBe(false);
      expect(classifiedResult.error?.code).toBe("MCP_UNAVAILABLE");
      expect(classifiedResult.error?.details).toEqual({category: "configuration", phase: "classification-initialization", reasonCode: "INVALID_NATIVE_ISOLATION_ARGUMENT"});
      expect(classifiedText).not.toContain("PRIVATE_NATIVE_ARGUMENT"); expect(classifiedText).not.toContain(definitionsPath); expect(classifiedText).not.toContain(directory);
      expect((await client.listTools()).tools.some(tool => tool.name === "classify_skills")).toBe(true);
    }
    expect(diagnostic()).not.toContain("PRIVATE_NATIVE_ARGUMENT"); expect(diagnostic()).not.toContain(definitionsPath);
  } finally {
    await server.close();
  }
}, 30_000);
