// Owned synthetic source/API fixture. This is not native capture or a default native producer.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import type { ApiResultV1, AttemptLeaseV1, ConvergenceRootV1, ReasoningEffortV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import type { HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { SessionActorProofs, withoutSessionProof } from "../../mcp-server/src/session-actor-proof.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const host = "claude-code", sessionId = "owned-f1-session";
function envelope<T>(response: Awaited<ReturnType<Client["callTool"]>>): ApiResultV1<T> {
  const content = response.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as ApiResultV1<T>;
}
function payload(args: Record<string, unknown>): Record<string, unknown> {
  expect(args._hostAttestation).toMatch(/^aghs2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
  return JSON.parse(Buffer.from((args._hostAttestation as string).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
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

async function fixture(modelClass: "deep" | "lightweight" = "deep") {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-f1-composition-")), state = path.join(directory, "state");
  const database = path.join(state, "workflow.sqlite3");
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await mkdir(path.join(directory, "mcp-server", "dist"), { recursive: true }); await mkdir(state, { recursive: true });
    await Promise.all([
      ...["contracts", "skills"].map(name => cp(path.join(repository, name), path.join(directory, name), { recursive: true })),
      ...["server.mjs", "governance-hook.mjs", "host-attestation-api.mjs"].map(name => cp(path.join(repository, "mcp-server", "dist", name), path.join(directory, "mcp-server", "dist", name))),
    ]);
    const environment = { ...getDefaultEnvironment(), AGENT_GOVERNANCE_DB_PATH: database, AGENT_GOVERNANCE_HOST_ATTESTATION: host,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messages") };
    const seed = new SqliteWorkflowStore(database);
    try { seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION,
      latestTag: `v${CURRENT_VERSION}`, latestCommit: "c".repeat(40), etag: "owned-f1", comparison: "up-to-date",
      lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(), nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null }); } finally { seed.close(); }
    // Both public entry wrappers import this one fixed installation fixture. No model-name branch or catalog row.
    const authority = path.join(directory, "authority.mjs");
    await writeFile(authority, `
export const descriptor = Object.freeze(${JSON.stringify({ host, provider: "owned-f1-authority", resolvedModel: "owned-f1-capability", modelClass,
      minimumReasoningEffort: null, supportedEfforts: ["medium", "high", "xhigh"], aliasUsed: false, policyRevision: "owned-f1-r1" })});
export const adapter = Object.freeze({host: descriptor.host, provider: descriptor.provider, policyRevision: descriptor.policyRevision,
  modelClassForModel() { return descriptor.modelClass; },
  resolveModel(rawModel, provenance) { return {...descriptor, rawModel, provenance}; }});
export const executionAdapters = new Map([[adapter.host, adapter]]);
`, "utf8");
    const serverWrapper = path.join(directory, "installation-server.mjs"), hookWrapper = path.join(directory, "installation-hook.mjs");
    await writeFile(serverWrapper, 'import {startMcpServer} from "./mcp-server/dist/server.mjs";\nimport {executionAdapters} from "./authority.mjs";\nawait startMcpServer(new Map(), executionAdapters);\n', "utf8");
    await writeFile(hookWrapper, `
import {readFileSync} from "node:fs";
import {runGovernanceHook} from "./mcp-server/dist/governance-hook.mjs";
import {adapter, executionAdapters} from "./authority.mjs";
const mode = process.argv[2];
const selected = mode === "empty" ? new Map() : mode === "mismatch" ? new Map([[adapter.host, {...adapter, host: "mismatched-fixture-host"}]]) : executionAdapters;
const result = await runGovernanceHook(adapter.host, readFileSync(0, "utf8"), process.env, selected);
process.stdout.write(result.output); if (!result.ok) process.exitCode = 2;
`, "utf8");
    const catalogPath = path.join(directory, "skills/coordinate-subagents/references/model-routing-presets.json");
    const protectedFiles = [authority, serverWrapper, hookWrapper, catalogPath, path.join(repository, "skills/coordinate-subagents/references/model-routing-presets.json")];
    const unchanged = await Promise.all(protectedFiles.map(file => readFile(file)));
    const api = await import(pathToFileURL(path.join(directory, "mcp-server/dist/host-attestation-api.mjs")).href) as typeof import("../../mcp-server/src/host-attestation-api.js");
    const { adapter } = await import(pathToFileURL(authority).href) as { adapter: HostExecutionAdapter };
    transport = new StdioClientTransport({ command: process.execPath, args: [serverWrapper], cwd: directory, env: environment, stderr: "pipe" });
    client = new Client({ name: "owned-f1-public-entry", version: "1.0.0" }); await client.connect(transport);
    let sequence = 0;
    const hook = async (tool: string, input: Record<string, unknown>, model: string, effort = "high", mode = "installed", extra: Record<string, unknown> = {}) => {
      const callId = `owned-f1-call-${++sequence}`, transcript = path.join(state, "transcript.jsonl");
      await writeFile(transcript, JSON.stringify({ type: "assistant", sessionId, isSidechain: false, effort,
        message: { model, content: [{ type: "tool_use", id: callId, name: tool, input }] } }) + "\n", "utf8");
      const command = mode === "default" ? [path.join(directory, "mcp-server/dist/governance-hook.mjs"), `--host=${host}`] : [hookWrapper, mode];
      const issued = spawnSync(process.execPath, command, { cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, turn_id: "owned-f1-turn", tool_use_id: callId,
          transcript_path: transcript, model, effort: { level: effort }, tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: input, ...extra }) });
      expect(issued.error).toBeUndefined();
      const specific = JSON.parse(issued.stdout).hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
      if (mode === "empty" || mode === "mismatch") {
        expect(issued.status, issued.stderr).toBe(2);
        expect(specific).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "HOST_EXECUTION_ADAPTER_UNAVAILABLE" });
        expect(specific).not.toHaveProperty("updatedInput");
      } else { expect(issued.status, issued.stderr).toBe(0); expect(specific.permissionDecision).toBeUndefined(); expect(specific.updatedInput?._sessionProof).toEqual(expect.any(String)); }
      return specific.updatedInput!;
    };
    const rawCall = async <T>(name: string, args: Record<string, unknown>) => envelope<T>(await client!.callTool({ name, arguments: args }));
    const call = async <T>(name: string, args: Record<string, unknown>, model: string, effort = "high") => rawCall<T>(name, await hook(name, args, model, effort));
    const rooted = (args: Record<string, unknown>) => {
      const store = new SqliteWorkflowStore(database);
      try { const clean = withoutSessionProof(args); return { ...clean, _sessionProof: new SessionActorProofs(store).issue({ host, sessionId,
        callId: randomUUID(), kind: "tool-boundary", boundaryPhase: "before", actor: { role: "root", basis: "observed", reasonCode: "OWNED_SYNTHETIC_ROOT" } }, "plan_workflow", clean) }; }
      finally { store.close(); }
    };
    const observedBy = (issuer: HostExecutionAdapter, args: Record<string, unknown>, model: string, effort: ReasoningEffortV1 = "high") => {
      const ingress = api.openHostAttestation(database, issuer);
      try { return rooted(ingress.runObserved("plan_workflow", args, () => ({ model, reasoningEffort: effort,
        actorId: api.hostActorId(host, sessionId), sessionId, turnId: "owned-f1-turn", toolUseId: randomUUID() }), input => input)); }
      finally { ingress.close(); }
    };
    return { adapter, api, directory, hook, call, rawCall, rooted, observedBy,
      async unchanged() { expect(await Promise.all(protectedFiles.map(file => readFile(file)))).toEqual(unchanged); },
      async close() { try { await client?.close(); } finally { try { await transport?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } } };
  } catch (error) {
    try { await client?.close(); } finally { try { await transport?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    throw error;
  }
}

it("uses one explicit trusted producer for two opaque IDs through public hook/startup and guarded finalization", async () => {
  const f = await fixture();
  try {
    let originalEligibility: unknown;
    for (const model of [randomUUID(), randomUUID()]) {
      expect(await readFile(path.join(f.directory, "skills/coordinate-subagents/references/model-routing-presets.json"), "utf8")).not.toContain(model);
      const request = task(`owned-f1-${model}`), args = { schemaVersion: "1.0.0", taskEnvelope: request };
      const signed = await f.hook("plan_workflow", args, model), observation = payload(signed);
      expect(observation).toMatchObject({ model, eligibility: { provider: "owned-f1-authority", resolvedModel: "owned-f1-capability", modelClass: "deep", policyRevision: "owned-f1-r1" } });
      if (originalEligibility === undefined) originalEligibility = observation.eligibility;
      else expect(observation.eligibility).toEqual(originalEligibility);
      const planned = await f.rawCall<WorkflowPlanV1>("plan_workflow", signed); expect(planned.error).toBeNull();
      const plan = planned.data!; expect(plan.bootstrapExecution?.context).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
      const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: request.taskId, locator: `fixture:${model}` },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: `fixture:${model}`, digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
      const root = await f.call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: request, frame, userApprovalRefs: [] }, model); expect(root.error).toBeNull();
      const lease = await f.call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: root.data!.rootId, expectedRevision: root.data!.revision,
        taskEnvelope: request, frame, plan, actorId: f.api.hostActorId(host, sessionId), outputTargets: ["fixture.md"], priorFailure: null }, model); expect(lease.error).toBeNull();
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
    const tampered = withoutSessionProof(await f.hook("plan_workflow", args, model));
    const token = tampered._hostAttestation as string; tampered._hostAttestation = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect((await f.rawCall("plan_workflow", f.rooted(tampered))).error).toMatchObject({ code: "BINDING_INVALID", message: "Host attestation token signature is invalid." });
    for (const field of ["provider", "policyRevision"] as const) {
      const replacement = field === "provider" ? "other-owned-authority" : "other-owned-policy";
      const issuer: HostExecutionAdapter = { ...f.adapter, [field]: replacement,
        resolveModel: (rawModel, provenance) => ({ ...f.adapter.resolveModel!(rawModel, provenance)!, [field]: replacement }) };
      const issued = f.observedBy(issuer, args, model); expect(payload(issued).eligibility).not.toBeNull();
      expect((await f.rawCall("plan_workflow", issued)).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    }
    const effort = await f.hook("plan_workflow", args, model, "medium"); expect(payload(effort).eligibility).not.toBeNull();
    expect((await f.rawCall("plan_workflow", effort)).error).toMatchObject({ code: "BINDING_INVALID", details: { reasoningEffort: "medium", minimumReasoningEffort: "high" } });
    const absent = f.observedBy({ ...f.adapter, resolveModel: () => null }, args, model); expect(payload(absent).eligibility).toBeNull();
    expect((await f.rawCall("plan_workflow", absent)).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    await f.hook("plan_workflow", args, model, "high", "empty"); await f.hook("plan_workflow", args, model, "high", "mismatch");
    const callerClaim = await f.hook("plan_workflow", args, model, "high", "default", { adapter: { modelClass: "frontier" }, executionAdapters: { [host]: { modelClass: "frontier" } } });
    expect(callerClaim._sessionProof).toEqual(expect.any(String)); expect(payload(callerClaim).eligibility).toBeNull();
    expect((await f.rawCall("plan_workflow", callerClaim)).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);

it("rejects valid same-authority low capability at the actual workflow floor", async () => {
  const f = await fixture("lightweight");
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-f1-class-floor") };
    const signed = await f.hook("plan_workflow", args, model); expect(payload(signed)).toMatchObject({ model, eligibility: { modelClass: "lightweight", policyRevision: "owned-f1-r1" } });
    expect((await f.rawCall("plan_workflow", signed)).error).toMatchObject({ code: "BINDING_INVALID", details: { modelClass: "lightweight", minimumModelClass: "general" } });
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);
