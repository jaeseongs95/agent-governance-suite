import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect} from "vitest";

import type {ApiResultV1, TaskEnvelopeV1, WorkflowPlanV1} from "../../contracts/types.js";
import {hostActorId} from "../../mcp-server/src/host-attestation.js";
import type {ModelRoutingPresetsV1} from "../../mcp-server/src/host-execution-adapters.js";
import {codexCallMeta} from "../helpers/caller.js";
import {stdioServerTests} from "../helpers/stdio-server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
// The installation supplies its own execution catalog for the Codex host, whose caller ingress is built in.
// Synthetic catalog authority only; no live host is qualified.
const host = "codex", model = "opaque-fourth-model", session = "al09-entrypoint-session";
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

// Each case's server starts before the case's time limit starts (stdioServerTests); the limit measures the calls.
const serverTest = stdioServerTests();
for (const mode of ["installed", "snapshot", "name-only", "mismatched", "builtin-default"] as const) serverTest(
  `actual startMcpServer preserves trusted host authority for ${mode}`, async ({defer, connect}) => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-al09-entrypoint-"));
    defer(() => rm(directory, {recursive: true, force: true}));
    const databasePath = path.join(directory, "workflow.sqlite3");
    const wrapperPath = path.join(directory, "installation.mts");
    const entry = new URL("../../mcp-server/src/index.ts", import.meta.url).href;
    const adapterEntry = new URL("../../mcp-server/src/host-execution-adapters.ts", import.meta.url).href;
    await writeFile(wrapperPath, `
import {startMcpServer} from ${JSON.stringify(entry)};
import {createCatalogExecutionAdapters, claudeCodeExecutionAdapter} from ${JSON.stringify(adapterEntry)};
globalThis.fetch = async () => { process.stderr.write("AL09_UNEXPECTED_FETCH\\n"); throw new Error("AL09_UNEXPECTED_FETCH"); };
const suite = createCatalogExecutionAdapters(${JSON.stringify(presets)});
${mode === "installed" ? "await startMcpServer(new Map(), suite.adapters);"
      : mode === "snapshot" ? "const installed = new Map(suite.adapters); const started = startMcpServer(new Map(), installed); installed.clear(); await started;"
      : mode === "mismatched" ? `await startMcpServer(new Map(), new Map([[${JSON.stringify(host)}, claudeCodeExecutionAdapter]]));`
      : mode === "builtin-default" ? "await startMcpServer();" : "await startMcpServer(new Map());"}
`, "utf8");
    const environment = Object.fromEntries(Object.entries({...process.env,
      AGENT_GOVERNANCE_CLASSIFICATION_CONFIG: "", AGENT_GOVERNANCE_HOST_ATTESTATION: host,
      AGENT_GOVERNANCE_LOG_CONFIG: "",
      SKILL_REGISTRY_PATH: path.join(root, "skills", "registry.json"), AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
      AGENT_GOVERNANCE_DB_PATH: databasePath, AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return {directory, server: await connect("al09-entrypoint-fixture", {command: process.execPath, args: ["--import", "tsx", wrapperPath], cwd: root, env: environment})};
  }, async ({directory, server}) => {
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    const selectedModel = mode === "builtin-default" ? "gpt-6-astra" : model;
    const {client} = server;
    async function call(input: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ApiResultV1<WorkflowPlanV1>> {
      const reply = await client.callTool({name: "plan_workflow", arguments: input, ...(meta ? {_meta: meta} : {})});
      const text = (reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!;
      return JSON.parse(text) as ApiResultV1<WorkflowPlanV1>;
    }
    const observed = (options: {model?: string; effort?: string; callId?: string} = {}) =>
      codexCallMeta(session, {model: options.model ?? selectedModel, effort: options.effort ?? "high", ...(options.callId ? {callId: options.callId} : {})});
    try {
      const args = argumentsFor(`entrypoint-${mode}`);
      // Caller ingress negatives stay raw, before the separate execution qualification checks.
      expect(await call(args)).toMatchObject({ok: false, error: {code: "BINDING_REQUIRED", details: {reasonCode: "CALLER_PROVENANCE_UNAVAILABLE"}}});
      expect(await call({...args, _sessionProof: "synthetic-forged-root-proof"}, observed()))
        .toMatchObject({ok: false, error: {code: "INVALID_INPUT", details: {reasonCode: "RESERVED_CALLER_FIELD"}}});
      if (mode === "mismatched") {
        // The caller is observed, but the installed adapter belongs to another host, so none is trusted.
        expect(await call(args, observed())).toMatchObject({ok: false, error: {code: "BINDING_REQUIRED",
          details: {observation: {status: "provider-not-configured"}}}});
      } else if (mode === "name-only") {
        // No execution adapters were passed: the built-in Codex catalog applies and does not know the installation's
        // model. The model still runs (3.1.1); the observation keeps it with no class and the catalog finding.
        const unknownPlan = await call(args, observed());
        expect(unknownPlan.ok, JSON.stringify(unknownPlan)).toBe(true);
        expect(unknownPlan.data!.bootstrapExecution!.context).toMatchObject({model: selectedModel, modelClass: null,
          reasoningEffort: "high", policyNotes: ["MODEL_NOT_IN_CATALOG"], actorId: hostActorId(host, session)});
      } else {
        const once = observed({callId: `fixture-call-${mode}`});
        const planned = await call(args, once);
        expect(planned.ok, JSON.stringify(planned)).toBe(true);
        expect(planned.data!.bootstrapExecution!.context).toMatchObject({model: selectedModel, modelClass: mode === "builtin-default" ? "frontier" : "deep",
          reasoningEffort: "high", actorId: hostActorId(host, session)});
        expect(await call(args, once)).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        const unknownResult = await call(args, observed({model: "unobserved-model"}));
        expect(unknownResult.ok, JSON.stringify(unknownResult)).toBe(true);
        expect(unknownResult.data!.bootstrapExecution!.context).toMatchObject({model: "unobserved-model", modelClass: null,
          policyNotes: ["MODEL_NOT_IN_CATALOG"]});
        if (mode === "builtin-default") {
          const lowArgs = argumentsFor("entrypoint-valid-low");
          const lowCall = observed({effort: "low"});
          const acceptedLow = await call(lowArgs, lowCall);
          expect(acceptedLow.ok, JSON.stringify(acceptedLow)).toBe(true);
          expect(acceptedLow.data!.bootstrapExecution!).toMatchObject({
            requirement: {minimumModelClass: null, minimumReasoningEffort: null, observationRequired: true},
            context: {model: selectedModel, modelClass: "frontier", reasoningEffort: "low", actorId: hostActorId(host, session)},
          });
          expect(await call(lowArgs, lowCall)).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        }
        if (mode === "installed") {
          const lowResult = await call(args, observed({effort: "low"}));
          expect(lowResult, JSON.stringify(lowResult)).toMatchObject({ok: false, error: {code: "BINDING_INVALID",
            details: {reasonCode: "CURRENT_POLICY_EFFORT_UNSUPPORTED"}}});
          // 기존 capability의 경량 관측과 앞의 거부를 별도로 검증한다.
          const reasoningEffort = "high";
          const weakArgs = argumentsFor(`entrypoint-valid-light-${reasoningEffort}`);
          const weak = observed({model: "opaque-fourth-light", effort: reasoningEffort});
          const accepted = await call(weakArgs, weak);
          expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
          expect(accepted.data!.bootstrapExecution!).toMatchObject({
            requirement: {minimumModelClass: null, minimumReasoningEffort: null, observationRequired: true},
            context: {model: "opaque-fourth-light", modelClass: "lightweight", reasoningEffort, actorId: hostActorId(host, session)},
          });
          expect(await call(weakArgs, weak)).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
        }
      }
    } finally {
      await server.close();
    }
    expect(server.stderr()).not.toContain("AL09_UNEXPECTED_FETCH");
  }, 30_000,
);
