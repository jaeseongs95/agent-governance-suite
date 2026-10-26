import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

import type {ApiResultV1, TaskEnvelopeV1, WorkflowPlanV1} from "../../contracts/types.js";
import {HOST_ATTESTATION_FIELD, hostActorId, issueHostAttestation} from "../../mcp-server/src/host-attestation.js";
import {codexExecutionAdapter, createCatalogExecutionAdapters, type ModelRoutingPresetsV1} from "../../mcp-server/src/host-execution-adapters.js";
import {SqliteWorkflowStore} from "../../mcp-server/src/sqlite-workflow-store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const host = "synthetic-fourth-host", model = "opaque-fourth-model", session = "al09-entrypoint-session";
// Reuses the fourth-host authority contract in host-attestation.test.ts; no live host is qualified.
const presets: ModelRoutingPresetsV1 = {schema_version: 1, policy_revision: "synthetic-fourth-r1",
  model_class_order: ["lightweight", "general", "deep", "frontier"], effort_order: ["low", "high"],
  providers: {"synthetic-fourth-provider": {host, catalog: {matching: "exact-only", models: {
    [model]: {model_class: "deep", minimum_effort: "high", supported_efforts: ["high"]},
    "opaque-fourth-light": {model_class: "lightweight", minimum_effort: "high", supported_efforts: ["high"]},
  }}}}};

function argumentsFor(taskId: string): {schemaVersion: string; taskEnvelope: TaskEnvelopeV1} {
  return {schemaVersion: "1.0.0", taskEnvelope: {schemaVersion: "1.0.0", taskId,
    objective: "Exercise the installed host adapter through the actual stdio entrypoint.",
    scope: {included: ["integration test"], excluded: ["deployment"]},
    acceptanceCriteria: ["Consume the same trusted observation through the MCP boundary."], riskLevel: "low",
    workUnits: [{id: "unit-1", objective: "Run the fixture.", dependencies: [], writeTargets: ["fixture.md"]}],
    requiredCapabilities: ["task-decomposition"], constraints: ["Use only fixture data."],
    authorization: {allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: []},
    decision: {complexity: "simple", hasConflicts: false}, orchestration: {requested: true, mcpAvailable: true}}};
}

it.each(["installed", "name-only", "mismatched", "builtin-default"] as const)(
  "actual startMcpServer preserves trusted host authority for %s", async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-al09-entrypoint-"));
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    const databasePath = path.join(directory, "workflow.sqlite3");
    const store = new SqliteWorkflowStore(databasePath);
    const selectedHost = mode === "builtin-default" ? "codex" : host;
    const adapter = mode === "builtin-default" ? codexExecutionAdapter : createCatalogExecutionAdapters(presets).adapters.get(host)!;
    const selectedModel = mode === "builtin-default" ? "gpt-6-astra" : model;
    const wrapperPath = path.join(directory, "installation.mts");
    const entry = new URL("../../mcp-server/src/index.ts", import.meta.url).href;
    const adapterEntry = new URL("../../mcp-server/src/host-execution-adapters.ts", import.meta.url).href;
    await writeFile(wrapperPath, `
import {startMcpServer} from ${JSON.stringify(entry)};
import {createCatalogExecutionAdapters, codexExecutionAdapter} from ${JSON.stringify(adapterEntry)};
globalThis.fetch = async () => { process.stderr.write("AL09_UNEXPECTED_FETCH\\n"); throw new Error("AL09_UNEXPECTED_FETCH"); };
const suite = createCatalogExecutionAdapters(${JSON.stringify(presets)});
${mode === "installed" ? "await startMcpServer(new Map(), suite.adapters);"
      : mode === "mismatched" ? `await startMcpServer(new Map(), new Map([[${JSON.stringify(host)}, codexExecutionAdapter]]));`
      : mode === "builtin-default" ? "await startMcpServer();" : "await startMcpServer(new Map());"}
`, "utf8");
    const environment = Object.fromEntries(Object.entries({...process.env,
      AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: "", AGENT_GOVERNANCE_HOST_ATTESTATION: selectedHost,
      SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"), AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
      AGENT_GOVERNANCE_DB_PATH: databasePath, AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({command: process.execPath, args: ["--import", "tsx", wrapperPath], cwd: root, env: environment, stderr: "pipe"});
    const client = new Client({name: "al09-entrypoint-fixture", version: "1.0.0"});
    let diagnostics = "";
    transport.stderr?.on("data", chunk => {diagnostics += String(chunk);});
    async function call(input: Record<string, unknown>): Promise<ApiResultV1<WorkflowPlanV1>> {
      const reply = await client.callTool({name: "plan_workflow", arguments: input});
      const text = (reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!;
      return JSON.parse(text) as ApiResultV1<WorkflowPlanV1>;
    }
    try {
      await client.connect(transport);
      const args = argumentsFor(`entrypoint-${mode}`);
      const observation = {tool: "plan_workflow", input: args, model: selectedModel, reasoningEffort: "high",
        actorId: hostActorId(selectedHost, session), sessionId: session, turnId: "fixture-turn", toolUseId: "fixture-call"};
      const token = issueHostAttestation(store, adapter, observation);
      expect(token).toEqual(expect.any(String));
      if (mode === "name-only" || mode === "mismatched") {
        expect(await call({...args, [HOST_ATTESTATION_FIELD]: token})).toMatchObject({ok: false, error: {code: "BINDING_REQUIRED"}});
        expect(await call(args)).toMatchObject({ok: false, error: {code: "BINDING_REQUIRED"}});
      } else {
        expect(await call({...args, taskEnvelope: {...args.taskEnvelope, objective: "tampered signed input"}, [HOST_ATTESTATION_FIELD]: token}))
          .toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        expect(await call({...args, [HOST_ATTESTATION_FIELD]: "synthetic-forged-token"}))
          .toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        const planned = await call({...args, [HOST_ATTESTATION_FIELD]: token});
        expect(planned.ok).toBe(true);
        expect(planned.data!.bootstrapExecution!.context).toMatchObject({model: selectedModel, modelClass: mode === "builtin-default" ? "frontier" : "deep",
          reasoningEffort: "high", actorId: hostActorId(selectedHost, session)});
        expect(await call({...args, [HOST_ATTESTATION_FIELD]: token})).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        expect(issueHostAttestation(store, adapter, {...observation, model: "unobserved-model"})).toBeNull();
        expect(issueHostAttestation(store, adapter, {...observation, actorId: hostActorId("forged-host", session)})).toBeNull();
        if (mode === "installed") {
          expect(issueHostAttestation(store, adapter, {...observation, reasoningEffort: "low"})).toBeNull();
          const weakArgs = argumentsFor("entrypoint-insufficient-capability");
          const weak = issueHostAttestation(store, adapter, {...observation, input: weakArgs, model: "opaque-fourth-light", toolUseId: "weak-call"});
          expect(weak).toEqual(expect.any(String));
          expect(await call({...weakArgs, [HOST_ATTESTATION_FIELD]: weak})).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        }
      }
    } finally {
      try {await client.close();} finally {await transport.close(); store.close(); await rm(directory, {recursive: true, force: true});}
    }
    expect(diagnostics).not.toContain("AL09_UNEXPECTED_FETCH");
  }, 30_000,
);
