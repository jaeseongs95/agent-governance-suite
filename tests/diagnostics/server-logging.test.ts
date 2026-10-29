import {expect, it} from "vitest";
import {mkdtemp, readdir, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {WorkflowContractError} from "../../contracts/types.js";
import {createMcpServer} from "../../mcp-server/src/server.js";
import {createDiagnostics, readDiagnosticConfig} from "../../mcp-server/src/diagnostics.js";
import type {WorkflowService} from "../../mcp-server/src/workflow-service.js";
import type {PluginUpdateService} from "../../mcp-server/src/plugin-update-service.js";
import type {SessionActorProofVerifier} from "../../mcp-server/src/session-actor-proof.js";

it("records actual MCP success, early proof rejection and thrown failure without changing responses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ags-server-logging-"));
  const diagnostics = await createDiagnostics(readDiagnosticConfig(JSON.stringify({
    level: "TRACE", destination: "file", file: path.join(root, "safe"), flushDeadlineMs: 1000,
  })), new Set());
  const started = performance.now();
  const timeline: Array<{event: string; elapsedMs: number}> = [];
  const mark = (event: string) => timeline.push({event, elapsedMs: performance.now() - started});
  mark("ready-start");
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([diagnostics.ready, new Promise<never>((_resolve, reject) => {
      setupTimer = setTimeout(() => reject(new Error("LOGGING_FIXTURE_NOT_READY")), 3000);
    })]);
    mark("ready-complete");
    expect(ready).toBe(true);
  } finally {clearTimeout(setupTimer);}
  // Synthetic proof verifier tests instrumentation only; genuine proof semantics have their own suite.
  const proof: SessionActorProofVerifier = {verify(_tool, args) {
    if (args._sessionProof === "REJECT_SECRET_PROOF") {
      throw new WorkflowContractError("BINDING_INVALID", "SECRET_REASON", {
        reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: ["expired"], token: "SECRET_TOKEN",
      });
    }
    return {host: "fixture", sessionId: "fixture", actor: {role: "root", basis: "observed", reasonCode: "OWNED_TEST"}};
  }};
  const updates = {
    cachedStatus: () => null, takeNotice: () => null,
    check: async () => {throw new Error("SECRET_THROW");},
  } as unknown as PluginUpdateService;
  const classification = {
    inventory: async () => ({fixture: "SECRET_RESPONSE_BODY"}),
    classify: async () => {throw new Error("Unexpected fixture invocation");},
    accept: async () => {throw new Error("Unexpected fixture invocation");},
  } as unknown as NonNullable<Parameters<typeof createMcpServer>[11]>;
  const server = createMcpServer({} as WorkflowService, updates, undefined, undefined, undefined,
    undefined, "default", null, null, undefined, null, classification, proof, diagnostics);
  const client = new Client({name: "logging-integration", version: "1.0.0"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    mark("success-start");
    const response = await client.callTool({name: "get_skill_inventory", arguments: {_sessionProof: "ACCEPT_SECRET_PROOF"}});
    expect(JSON.parse((response.content as Array<{text: string}>)[0]!.text)).toMatchObject({ok: true, data: {fixture: "SECRET_RESPONSE_BODY"}});
    mark("success-end");
    mark("rejected-start");
    const rejected = await client.callTool({name: "get_skill_inventory", arguments: {_sessionProof: "REJECT_SECRET_PROOF"}});
    expect(JSON.parse((rejected.content as Array<{text: string}>)[0]!.text)).toMatchObject({ok: false, error: {code: "BINDING_INVALID", message: "SECRET_REASON"}});
    mark("rejected-end");
    mark("thrown-start");
    await expect(client.callTool({name: "check_for_updates", arguments: {_sessionProof: "ACCEPT_SECRET_PROOF"}})).rejects.toThrow("SECRET_THROW");
    mark("thrown-end");
  } finally {
    mark("close-start");
    await client.close(); await server.close(); await diagnostics.close();
    mark("close-end");
  }
  const entries = await readdir(root);
  const files = entries.filter(file => file.endsWith(".log"));
  const contents = await Promise.all(files.map(file => readFile(path.join(root, file))));
  const observation = {
    fixture: root, timeline, loss: {...diagnostics.loss},
    files: await Promise.all(entries.map(async name => {
      const info = await stat(path.join(root, name));
      const index = files.indexOf(name);
      return {name, bytes: info.size, modifiedMs: info.mtimeMs, type: info.isFile() ? "file" : "other",
        ...(index >= 0 ? {rawBase64: contents[index]!.toString("base64")} : {})};
    })),
  };
  const evidence = JSON.stringify(observation);
  if (process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) {
    await writeFile(path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE, "server-logging-result.json"), evidence, "utf8");
  }
  expect(files.length, evidence).toBeGreaterThan(0);
  const text = contents.map(content => content.toString("utf8")).join("\n");
  expect(text, evidence).not.toContain("SECRET");
  const events = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const end = events.filter(event => event.event === "request_end");
  expect(end.map(event => event.outcome), evidence).toEqual(["success", "rejected", "thrown"]);
  expect(end[1]).toMatchObject({errorCode: "BINDING_INVALID", reasonCode: "ROOT_PROOF_SCOPE_OR_TIME_INVALID", failedChecks: ["expired"]});
  for (const event of end) {
    expect(events.some(start => start.event === "request_start" && start.correlation === event.correlation)).toBe(true);
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  expect(events.filter(event => event.event === "binding_check" && event.proofPresent === true)).toHaveLength(3);
});
