import {execFileSync} from "node:child_process";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const customHost = "synthetic-installed-native";

it.each(["registered", "snapshot", "omitted-custom", "empty-builtin", "incomplete-evidence", "builtin-default"] as const)(
  "public startup binds only trusted native composition for %s", async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-native-startup-"));
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    const profilesPath = path.join(directory, "profiles.json"), runtimePath = path.join(directory, "runtime.json");
    const definitionsPath = path.join(directory, "native.json"), configPath = path.join(directory, "config.json");
    const definitionHost = ["empty-builtin", "builtin-default"].includes(mode) ? "codex" : customHost;
    await writeFile(profilesPath, JSON.stringify({schemaVersion: "1.0.0", profileRevision: "native-startup-fixture", profiles: []}), "utf8");
    await writeFile(definitionsPath, JSON.stringify([{adapterId: "synthetic-native", host: definitionHost,
      executable: process.execPath, workingDirectory: directory, approvalRef: "synthetic-approval",
      capabilityEvidenceRef: "synthetic-capability", retryPolicyVerified: mode !== "incomplete-evidence",
      retryPolicyEvidenceRef: "synthetic-no-retry", isolationEvidenceRef: "synthetic-isolation", isolationArgs: [],
      timeoutMs: 1000, maximumOutputBytes: 4096}]), "utf8");
    await writeFile(runtimePath, JSON.stringify({schemaVersion: "1.0.0", routes: [{kind: "native", routeRef: "synthetic-route",
      approvalRef: "synthetic-approval", approved: true, providerKind: "vendor", vendorId: "synthetic-provider",
      adapterRevision: "synthetic-v1", modelIds: ["opaque-fixture-model"], reasoningEfforts: ["high"], structuredOutput: true,
      nativeAdapterRef: "synthetic-native", capabilityEvidenceRef: "synthetic-capability", retryPolicyVerified: true}],
      budget: {jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {}}}), "utf8");
    await writeFile(configPath, JSON.stringify({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: profilesPath,
      externalClassificationAllowed: false, configRevision: "native-startup-fixture", timeoutMs: 1000},
      allowRemotePrivateContent: false, providerRuntimeRef: runtimePath, nativeAdapterDefinitionsRef: definitionsPath}), "utf8");
    const wrapper = path.join(directory, "installation.mts");
    const entry = new URL("../../mcp-server/src/index.ts", import.meta.url).href;
    const startup = mode === "omitted-custom" || mode === "builtin-default" ? "await startMcpServer();"
      : mode === "empty-builtin" ? "await startMcpServer(new Map(), undefined, new Map());"
      : mode === "snapshot" ? "const started = startMcpServer(new Map(), undefined, behaviors); behaviors.clear(); await started;"
      : "await startMcpServer(new Map(), undefined, behaviors);";
    await writeFile(wrapper, `
import {startMcpServer} from ${JSON.stringify(entry)};
globalThis.fetch = async () => { process.stderr.write("NATIVE_STARTUP_UNEXPECTED_FETCH\\n"); throw new Error("UNEXPECTED_FETCH"); };
const behavior = {
  validateIsolationArgs(args) { process.stderr.write("NATIVE_STARTUP_TRUSTED_BEHAVIOR_BOUND\\n"); return args.length === 0; },
  canEncodeProfile() { throw new Error("NATIVE_STARTUP_UNEXPECTED_DISPATCH"); },
  prepare() { throw new Error("NATIVE_STARTUP_UNEXPECTED_DISPATCH"); },
  decode() { throw new Error("NATIVE_STARTUP_UNEXPECTED_DISPATCH"); },
};
const behaviors = new Map([[${JSON.stringify(customHost)}, behavior]]);
${startup}
`, "utf8");
    const environment = Object.fromEntries(Object.entries({...process.env,
      AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: configPath, AGENT_GOVERNANCE_HOST_ATTESTATION: "",
      SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"), AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
      AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({command: process.execPath, args: ["--import", "tsx", wrapper], cwd: root, env: environment, stderr: "pipe"});
    const client = new Client({name: "native-startup-composition-fixture", version: "1.0.0"});
    let diagnostics = "";
    transport.stderr?.on("data", chunk => {diagnostics += String(chunk);});
    try {
      await client.connect(transport);
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
      const unavailable = mode === "omitted-custom" || mode === "empty-builtin";
      expect(result.ok).toBe(true);
      expect(result.data.issues.some(issue => issue.code === "CONFIGURED_DISCOVERY_UNAVAILABLE")).toBe(unavailable);
    } finally {
      try {await client.close();} finally {await transport.close(); await rm(directory, {recursive: true, force: true});}
    }
    expect(diagnostics.match(/NATIVE_STARTUP_TRUSTED_BEHAVIOR_BOUND/gu) ?? []).toHaveLength(mode === "registered" || mode === "snapshot" ? 1 : 0);
    if (mode === "omitted-custom" || mode === "empty-builtin") expect(diagnostics).toContain("NATIVE_ADAPTER_BEHAVIOR_UNAVAILABLE");
    else expect(diagnostics).not.toContain("classification-initialization-failed");
    expect(diagnostics).not.toContain("NATIVE_STARTUP_UNEXPECTED_FETCH");
    expect(diagnostics).not.toContain("NATIVE_STARTUP_UNEXPECTED_DISPATCH");
    // This verifies the trusted public startup seam, not native inference or live installation.
  },
);
