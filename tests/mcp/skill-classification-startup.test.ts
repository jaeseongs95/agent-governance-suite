import {execFileSync} from "node:child_process";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it.each(["unsupported-sibling", "invalid-isolation"] as const)("actual index startup preserves %s classification state and safe diagnostics", async mode => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-native-startup-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
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
    AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: configPath, AGENT_GOVERNANCE_HOST_ATTESTATION: "", SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"), AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"), AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  // Existing source-stdio test runner: actual index, producer, factory, catch and MCP gateway. No native CLI invocation.
  const transport = new StdioClientTransport({command: process.execPath, args: ["--import", "tsx", path.join(root, "mcp-server", "src", "index.ts")], cwd: root, env: environment, stderr: "pipe"});
  const client = new Client({name: "native-startup-source-fixture", version: "1.0.0"});
  let diagnostic = "";
  const diagnosticPrefix = "[agent-governance-suite] classification-initialization-failed ";
  let received!: () => void;
  const diagnosticReceived = new Promise<void>(resolve => {received = resolve;});
  transport.stderr?.on("data", chunk => {
    diagnostic += String(chunk);
    if (diagnostic.split(/\r?\n/u).slice(0, -1).some(line => line.startsWith(diagnosticPrefix))) received();
  });
  try {
    await client.connect(transport);
    // 모델 입력에는 증명을 요구하지 않지만, 훅을 거치지 않은 실서버 호출은 거부한다.
    const advertised = (await client.listTools()).tools;
    for (const name of ["get_skill_inventory", "classify_skills"]) {
      const schema = advertised.find(tool => tool.name === name)?.inputSchema;
      expect(schema, name).toBeDefined();
      expect(schema!.required ?? [], name).not.toContain("_sessionProof");
    }
    const unsigned = await client.callTool({name: "get_skill_inventory", arguments: {}});
    expect(JSON.parse((unsigned.content as Array<{text?: string}>).find(item => item.text)!.text!).error.code).toBe("BINDING_REQUIRED");
    // Built CLI on owned synthetic Claude input; no native identity collection.
    const issued = execFileSync(process.execPath, [path.join(root, "mcp-server", "dist", "governance-hook.mjs"), "--host=claude-code"], {
      cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "synthetic-startup-root", tool_use_id: "inventory-call",
        tool_name: "mcp__agent_governance_suite__get_skill_inventory", tool_input: {}, cwd: directory }),
    });
    const rootOutput = JSON.parse(issued) as { hookSpecificOutput: { permissionDecision?: string; updatedInput: Record<string, unknown> } };
    expect(rootOutput.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(rootOutput.hookSpecificOutput.updatedInput._sessionProof).toEqual(expect.any(String));
    const reply = await client.callTool({name: "get_skill_inventory", arguments: rootOutput.hookSpecificOutput.updatedInput});
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
    const records = diagnostic.split(/\r?\n/u).filter(line => line.startsWith(diagnosticPrefix));
    if (mode === "invalid-isolation") {
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!.slice(records[0]!.indexOf("{")))).toEqual({phase: "classification-initialization", reason: "INVALID_NATIVE_ISOLATION_ARGUMENT"});
    } else expect(records).toHaveLength(0);
    expect(diagnostic).not.toContain("PRIVATE_NATIVE_ARGUMENT"); expect(diagnostic).not.toContain(definitionsPath);
  } finally {
    try {await client.close();} finally {await transport.close(); await rm(directory, {recursive: true, force: true});}
  }
}, 30_000);
