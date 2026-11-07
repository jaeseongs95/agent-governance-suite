// Owned synthetic source/API fixture. This is not native capture or a default native producer.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect } from "vitest";
import type { ApiResultV1, AttemptLeaseV1, ConvergenceRootV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";
import { stdioServerTests, type StdioServer, type StdioStart } from "../helpers/stdio-server.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const host = "claude-code", sessionId = "owned-f1-session";
function envelope<T>(response: Awaited<ReturnType<Client["callTool"]>>): ApiResultV1<T> {
  const content = response.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as ApiResultV1<T>;
}
function task(taskId: string) {
  return { schemaVersion: "1.0.0", taskId, objective: "Complete an owned F1 fixture", scope: { included: ["fixture"], excluded: ["deployment"] },
    acceptanceCriteria: ["Opaque observation reaches guarded finalization"], riskLevel: "low",
    workUnits: [{ id: "unit", objective: "Inspect fixture", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"], constraints: ["No external services"],
    artifactContracts: [{ capability: "task-decomposition", produced: ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map(artifactId => ({
      artifactId, schemaId: "fixture/v1", targetDigest: `sha256:${"b".repeat(64)}` as const,
    })) }], authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
}

async function fixture(connect: StdioStart["connect"], modelClass: "deep" | "lightweight" = "deep", resolvable = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-f1-composition-")), state = path.join(directory, "state");
  const database = path.join(state, "workflow.sqlite3");
  let server: StdioServer | undefined;
  try {
    await mkdir(path.join(directory, "mcp-server", "dist"), { recursive: true }); await mkdir(state, { recursive: true });
    await Promise.all([
      ...["contracts", "runtime", "skills"].map(name => cp(path.join(repository, name), path.join(directory, name), { recursive: true })),
      ...["server.mjs", "governance-hook.mjs"].map(name => cp(path.join(repository, "mcp-server", "dist", name), path.join(directory, "mcp-server", "dist", name))),
    ]);
    const environment = { ...getDefaultEnvironment(), AGENT_GOVERNANCE_DB_PATH: database, AGENT_GOVERNANCE_HOST_ATTESTATION: host,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messages") };
    const seed = new SqliteWorkflowStore(database);
    try { seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION,
      latestTag: `v${STABLE_VERSION}`, latestCommit: "c".repeat(40), etag: "owned-f1", comparison: "up-to-date",
      lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(), nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null }); } finally { seed.close(); }
    // The public server entry wrapper imports this one fixed installation fixture. No model-name branch or catalog row.
    const authority = path.join(directory, "authority.mjs");
    await writeFile(authority, `
export const descriptor = Object.freeze(${JSON.stringify({ host, provider: "owned-f1-authority", resolvedModel: "owned-f1-capability", modelClass,
      minimumReasoningEffort: null, supportedEfforts: ["medium", "high", "xhigh"], aliasUsed: false, policyRevision: "owned-f1-r1" })});
export const adapter = Object.freeze({host: descriptor.host, provider: descriptor.provider, policyRevision: descriptor.policyRevision,
  modelClassForModel() { return descriptor.modelClass; },
  resolveModel(rawModel, provenance) { return ${JSON.stringify(resolvable)} ? {...descriptor, rawModel, provenance} : null; }});
export const executionAdapters = new Map([[adapter.host, adapter]]);
`, "utf8");
    const serverWrapper = path.join(directory, "installation-server.mjs");
    await writeFile(serverWrapper, 'import {startMcpServer} from "./mcp-server/dist/server.mjs";\nimport {executionAdapters} from "./authority.mjs";\nawait startMcpServer(new Map(), executionAdapters);\n', "utf8");
    const catalogPath = path.join(directory, "runtime/model-routing-presets.json");
    const protectedFiles = [authority, serverWrapper, catalogPath, path.join(repository, "runtime/model-routing-presets.json")];
    const unchanged = await Promise.all(protectedFiles.map(file => readFile(file)));
    server = await connect("owned-f1-public-entry", { command: process.execPath, args: [serverWrapper], cwd: directory, env: environment });
    const { client } = server;
    let sequence = 0;
    // The built Claude governance hook records the call under its tool-use ID and prints nothing; the server claims it.
    const hook = async (tool: string, input: Record<string, unknown>, model: string, effort = "high", extra: Record<string, unknown> = {}) => {
      const callId = `owned-f1-call-${++sequence}`, transcript = path.join(state, "transcript.jsonl");
      await writeFile(transcript, JSON.stringify({ type: "assistant", sessionId, isSidechain: false, effort,
        message: { model, content: [{ type: "tool_use", id: callId, name: tool, input }] } }) + "\n", "utf8");
      const issued = spawnSync(process.execPath, [path.join(directory, "mcp-server/dist/governance-hook.mjs"), `--host=${host}`], { cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, turn_id: "owned-f1-turn", tool_use_id: callId,
          transcript_path: transcript, model, effort: { level: effort }, tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: input, ...extra }) });
      expect(issued.error).toBeUndefined();
      expect(issued.status, issued.stderr).toBe(0);
      expect(issued.stdout).toBe("");
      return { "claudecode/toolUseId": callId };
    };
    const rawCall = async <T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => envelope<T>(await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }));
    const call = async <T>(name: string, args: Record<string, unknown>, model: string, effort = "high", extra: Record<string, unknown> = {}) =>
      rawCall<T>(name, args, await hook(name, args, model, effort, extra));
    return { directory, hook, call, rawCall,
      async unchanged() { expect(await Promise.all(protectedFiles.map(file => readFile(file)))).toEqual(unchanged); },
      async close() { try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

// Each installed server starts before its test's time limit starts (stdioServerTests); the limit measures only the calls.
const serverTest = stdioServerTests();
serverTest("uses one explicit trusted producer for two opaque IDs through public hook/startup and guarded finalization", ({ connect }) => fixture(connect), async f => {
  try {
    for (const model of [randomUUID(), randomUUID()]) {
      expect(await readFile(path.join(f.directory, "runtime/model-routing-presets.json"), "utf8")).not.toContain(model);
      const request = task(`owned-f1-${model}`), args = { schemaVersion: "1.0.0", taskEnvelope: request };
      const planned = await f.call<WorkflowPlanV1>("plan_workflow", args, model); expect(planned.error).toBeNull();
      const plan = planned.data!; expect(plan.bootstrapExecution?.context).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
      const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: request.taskId, locator: `fixture:${model}` },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: `fixture:${model}`, digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
      const root = await f.call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: request, frame, userApprovalRefs: [] }, model); expect(root.error).toBeNull();
      const lease = await f.call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: root.data!.rootId, expectedRevision: root.data!.revision,
        taskEnvelope: request, frame, plan, outputTargets: ["fixture.md"], priorFailure: null }, model); expect(lease.error).toBeNull();
      const started = await f.call<WorkflowReceiptV1>("start_guarded_workflow", { schemaVersion: "1.0.0", leaseId: lease.data!.leaseId, expectedRootRevision: lease.data!.rootRevision, plan }, model); expect(started.error).toBeNull();
      const receipt = started.data!, stage = receipt.plan.stages[0]!;
      const recorded = await f.call<WorkflowReceiptV1>("record_stage_result", { schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed", responseMode: "full",
        output: { schemaVersion: "1.0.0", kind: "output", output: { completed: true }, artifacts: request.artifactContracts[0]!.produced.map(item => ({ ...item, locator: `fixture:${item.artifactId}`, digest: "d".repeat(64), verified: true })), error: null },
        evidence: [{ artifactId: "fixture", kind: "test", locator: "f1-composition-stdio.test.ts", verified: true, note: "Owned synthetic source/API evidence, not native capture" }], findings: [], blockers: [], error: null }, model);
      expect(recorded.error).toBeNull(); expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
      const final = await f.call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision }, model); expect(final.error).toBeNull(); expect(final.data?.state).toBe("passed");
      await f.unchanged();
    }
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-f1-negatives") };
    const admitted = await f.call<WorkflowPlanV1>("plan_workflow", args, model, "medium");
    expect(admitted.ok).toBe(true);
    expect(admitted.data?.bootstrapExecution?.context.reasoningEffort).toBe("medium");
    // Capability claims in hook input are ignored: only the server's installed authority qualifies the observed model.
    const callerClaim = await f.call<WorkflowPlanV1>("plan_workflow", args, model, "high", { adapter: { modelClass: "frontier" }, executionAdapters: { [host]: { modelClass: "frontier" } } });
    expect(callerClaim.ok).toBe(true);
    expect(callerClaim.data?.bootstrapExecution?.context.modelClass).toBe("deep");
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);

serverTest("admits valid same-authority lightweight bootstrap without granting stage assurance", ({ connect }) => fixture(connect, "lightweight"), async f => {
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-f1-class-floor") };
    const admitted = await f.call<WorkflowPlanV1>("plan_workflow", args, model);
    expect(admitted.ok).toBe(true);
    expect(admitted.data?.bootstrapExecution?.context).toMatchObject({ model, modelClass: "lightweight" });
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);

serverTest("runs an observed model that the installed authority cannot resolve with its class unknown", ({ connect }) => fixture(connect, "deep", false), async f => {
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-f1-unresolved") };
    // AGS 3.1.1: the catalog is not a permission to run; the unresolved model is observed and noted.
    const unresolved = await f.call<WorkflowPlanV1>("plan_workflow", args, model);
    expect(unresolved.error).toBeNull();
    expect(unresolved.data?.bootstrapExecution?.context).toMatchObject({ model, modelClass: null, policyNotes: ["MODEL_NOT_IN_CATALOG"] });
    // Without the hook admission the server does not presume a root caller.
    expect((await f.rawCall("plan_workflow", args)).error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } });
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);
