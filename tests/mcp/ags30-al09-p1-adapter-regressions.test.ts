import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it.each(["registered", "different-reference"] as const)("actual installation startup consumes only the %s wire registry entry", async mode => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-al09-wire-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  const profilesPath = path.join(directory, "profiles.json"), runtimePath = path.join(directory, "runtime.json"), configPath = path.join(directory, "config.json");
  await writeFile(profilesPath, JSON.stringify({schemaVersion: "1.0.0", profileRevision: "al09-fixture", profiles: []}), "utf8");
  await writeFile(runtimePath, JSON.stringify({schemaVersion: "1.0.0", routes: [{kind: "remote", routeRef: "al09-fixture-route", approvalRef: "synthetic-only",
    approved: true, providerKind: "vendor", vendorId: "al09-fixture-provider", adapterRevision: "al09-fixture-v1", modelIds: ["opaque-al09-model"],
    reasoningEfforts: ["high"], structuredOutput: true, endpoint: "https://fixture.invalid/unused", credentialEnvName: "AL09_UNUSED_CREDENTIAL", wireAdapterRef: "al09-installed-protocol"}],
    budget: {jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {}}}), "utf8");
  await writeFile(configPath, JSON.stringify({config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: profilesPath,
    externalClassificationAllowed: false, configRevision: "al09-fixture", timeoutMs: 1000}, allowRemotePrivateContent: false, providerRuntimeRef: runtimePath}), "utf8");
  const wrapperPath = path.join(directory, "installation.mts");
  const entry = new URL("../../mcp-server/src/index.ts", import.meta.url).href;
  await writeFile(wrapperPath, `
import {startMcpServer} from ${JSON.stringify(entry)};
globalThis.fetch = async () => { process.stderr.write("AL09_UNEXPECTED_FETCH\\n"); throw new Error("AL09_UNEXPECTED_FETCH"); };
const transport = Object.freeze({headers: Object.freeze({}), matches: () => true});
const wire = {
  get transport() { process.stderr.write("AL09_INSTALLED_WIRE_BOUND\\n"); return transport; },
  encode() { throw new Error("AL09_UNEXPECTED_DISPATCH"); },
  decode() { throw new Error("AL09_UNEXPECTED_DISPATCH"); },
};
await startMcpServer(new Map([[${JSON.stringify(mode === "registered" ? "al09-installed-protocol" : "al09-unrelated-protocol")}, wire]]));
`, "utf8");
  const environment = Object.fromEntries(Object.entries({...process.env,
    AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: configPath, AGENT_GOVERNANCE_HOST_ATTESTATION: "", SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"), AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"), AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({command: process.execPath, args: ["--import", "tsx", wrapperPath], cwd: root, env: environment, stderr: "pipe"});
  const client = new Client({name: "al09-installation-fixture", version: "1.0.0"});
  let diagnostics = "";
  let received!: () => void;
  const wireBound = new Promise<void>(resolve => {received = resolve;});
  transport.stderr?.on("data", chunk => { diagnostics += String(chunk); if (diagnostics.includes("AL09_INSTALLED_WIRE_BOUND")) received(); });
  try {
    await client.connect(transport);
    const reply = await client.callTool({name: "get_skill_inventory", arguments: {}});
    const text = (reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!;
    const result = JSON.parse(text) as {ok: boolean; data: {issues: Array<{code: string}>}};
    expect(result.ok).toBe(true);
    expect(result.data.issues.some(issue => issue.code === "CONFIGURED_DISCOVERY_UNAVAILABLE")).toBe(false);
    if (mode === "registered") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([wireBound, new Promise<never>((_resolve, reject) => {timer = setTimeout(() => reject(new Error("AL09_WIRE_BIND_TIMEOUT")), 2000);})]);
      } finally {if (timer !== undefined) clearTimeout(timer);}
    }
  } finally {
    try {await client.close();} finally {await transport.close(); await rm(directory, {recursive: true, force: true});}
  }
  expect(diagnostics.match(/AL09_INSTALLED_WIRE_BOUND/gu) ?? []).toHaveLength(mode === "registered" ? 1 : 0);
  expect(diagnostics).not.toContain("classification-initialization-failed");
  expect(diagnostics).not.toContain("AL09_UNEXPECTED_FETCH"); expect(diagnostics).not.toContain("AL09_UNEXPECTED_DISPATCH");
  // Synthetic trusted installation only; route binding does not qualify a live provider or dispatch a prompt.
}, 30_000);
