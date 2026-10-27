// Owned synthetic installation fixture; no native capture, native host support or default producer is claimed.
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
import { hostIdentityDigest, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { adaptHostInput, hookAttestationKind, hostDeliveryProfile, isGovernanceHookTool, nativePeerWait, resolveHookProcessPid, withHookHostAdapter, type HookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { SessionActorProofs, withoutSessionProof } from "../../mcp-server/src/session-actor-proof.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";

const repository = fileURLToPath(new URL("../../", import.meta.url)), sessionId = "owned-host-session";
function envelope<T>(response: Awaited<ReturnType<Client["callTool"]>>): ApiResultV1<T> {
  const content = response.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as ApiResultV1<T>;
}
function decoded(token: unknown): Record<string, unknown> {
  expect(token).toEqual(expect.any(String));
  return JSON.parse(Buffer.from((token as string).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}
function task(taskId: string) {
  return { schemaVersion: "1.0.0", taskId, objective: "Complete an owned host composition fixture", scope: { included: ["fixture"], excluded: ["deployment"] },
    acceptanceCriteria: ["Opaque host reaches guarded finalization"], riskLevel: "low",
    workUnits: [{ id: "unit", objective: "Inspect fixture", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"], constraints: ["No external services"],
    artifactContracts: [{ capability: "task-decomposition", produced: ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map(artifactId => ({
      artifactId, schemaId: "fixture/v1", targetDigest: `sha256:${"b".repeat(64)}` as const,
    })) }], authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
}

async function fixture(host: string, modelClass: "deep" | "lightweight" = "deep") {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-host-composition-")), state = path.join(directory, "state"), database = path.join(state, "workflow.sqlite3");
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await mkdir(path.join(directory, "mcp-server/dist"), { recursive: true }); await mkdir(state, { recursive: true });
    await Promise.all([
      ...["contracts", "skills"].map(name => cp(path.join(repository, name), path.join(directory, name), { recursive: true })),
      ...["server.mjs", "governance-hook.mjs", "host-attestation-api.mjs"].map(name => cp(path.join(repository, "mcp-server/dist", name), path.join(directory, "mcp-server/dist", name))),
    ]);
    const environment = { ...getDefaultEnvironment(), AGENT_GOVERNANCE_DB_PATH: database, AGENT_GOVERNANCE_HOST_ATTESTATION: host,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messages") };
    const seed = new SqliteWorkflowStore(database);
    try { seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION,
      latestTag: `v${STABLE_VERSION}`, latestCommit: "c".repeat(40), etag: "owned-host", comparison: "up-to-date",
      lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(), nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null }); } finally { seed.close(); }
    const authority = path.join(directory, "authority.mjs"), serverWrapper = path.join(directory, "installation-server.mjs"), hookWrapper = path.join(directory, "installation-hook.mjs");
    // Stateful prototype methods and inherited getters must survive each public composition snapshot.
    await writeFile(authority, `
import {openHostAttestation, hostActorId} from "./mcp-server/dist/host-attestation-api.mjs";
const descriptor = Object.freeze(${JSON.stringify({ provider: "owned-host-authority", resolvedModel: "owned-fixed-capability", modelClass,
      minimumReasoningEffort: null, supportedEfforts: ["medium", "high"], aliasUsed: false, policyRevision: "owned-host-r1" })});
class Execution {
  #descriptor;
  constructor(host) { this.#descriptor = Object.freeze({...descriptor, host}); }
  get host() { return this.#descriptor.host; }
  get provider() { return this.#descriptor.provider; }
  get policyRevision() { return this.#descriptor.policyRevision; }
  modelClassForModel() { return this.#descriptor.modelClass; }
  resolveModel(rawModel, provenance) { return {...this.#descriptor, rawModel, provenance}; }
}
export function installation(host) {
  const adapter = new Execution(host), executionAdapters = new Map([[adapter.host, adapter]]);
  return {adapter, executionAdapters, composition};
}
class InputAdapter {
  #mode; #prefix = "mcp__owned_installation__"; #translations = 0;
  constructor(mode) { this.#mode = mode; }
  get attestationKind() { return "owned-observation"; }
  adaptInput(input, host) {
    if (++this.#translations !== 1) throw new Error("owned raw schema must translate exactly once per governance call");
    return {lifecycle: "none", outputEventName: "PreToolUse", observation: {
    host: this.#mode === "observation-host" ? "other-owned-host" : host, sessionId: input.event.session, callId: input.event.call,
    kind: "tool-boundary", boundaryPhase: "before", toolName: input.event.tool, toolInput: input.event.args,
    actor: this.#mode === "actor-accessor" ? {get role() {return "root";}, basis: "observed", reasonCode: "OWNED_ACCESSOR"}
      : this.#mode === "actor-proxy" ? new Proxy({role: "root", basis: "observed", reasonCode: "OWNED_PROXY"}, {})
      : this.#mode === "child" ? {role: "child", basis: "observed", reasonCode: "OWNED_CHILD"}
      : this.#mode === "actor-unavailable" ? {role: "indeterminate", basis: "unavailable", reasonCode: "OWNED_ACTOR_UNAVAILABLE"}
      : {role: "root", basis: "observed", reasonCode: "OWNED_SYNTHETIC_ROOT"}}}; }
  ownsTool(tool) { return this.#mode !== "unowned" && tool.startsWith(this.#prefix) && tool.length > this.#prefix.length; }
  deliveryProfile() { return {transport: this.#prefix, capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}; }
  processPid() { return undefined; }
}
class Strategy {
  #mode;
  constructor(mode) { this.#mode = mode; }
  observe(input, context) {
    const malformed = {"return-false": false, "return-zero": 0, "return-empty": "", "return-null": null, "return-undefined": undefined, "return-array": [],
      "updated-array": {hookSpecificOutput: {updatedInput: []}}};
    if (Object.hasOwn(malformed, this.#mode)) return malformed[this.#mode];
    if (this.#mode === "domain-deny") return {hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "OWNED_DOMAIN_DENY"}};
    if (JSON.stringify(context.toolInput) !== JSON.stringify(input.tool_input)
      || JSON.stringify(context.observation.toolInput) !== JSON.stringify(context.toolInput)) throw new Error("canonical argument mismatch");
    if (this.#mode === "echo") return {hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: {...context.toolInput}}};
    if (this.#mode === "throws") throw new Error("owned producer failure");
    const issuer = this.#mode === "null-eligibility" ? {host: context.adapter.host, provider: context.adapter.provider, policyRevision: context.adapter.policyRevision,
      modelClassForModel: () => "deep", resolveModel: () => null} : context.adapter;
    const ingress = openHostAttestation(context.databasePath, issuer);
    try { return ingress.runObserved(context.observation.toolName.split("__").at(-1), context.toolInput, () => ({
      model: input.observed.model, reasoningEffort: input.observed.effort, sessionId: context.observation.sessionId, turnId: null, toolUseId: context.observation.callId,
      actorId: hostActorId(context.host, context.observation.sessionId), provenance: "owned-installation-fixture"}),
      updatedInput => ({hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput}})); }
    finally { ingress.close(); }
  }
}
export function composition(mode) {
  const inputAdapter = new InputAdapter(mode), strategy = mode === "missing-strategy" ? {} : new Strategy(mode);
  if (mode === "missing-input") Object.defineProperty(inputAdapter, "adaptInput", {value: undefined});
  if (mode === "missing-ownership") Object.defineProperty(inputAdapter, "ownsTool", {value: undefined});
  if (mode === "missing-kind") Object.defineProperty(inputAdapter, "attestationKind", {value: undefined});
  return {inputAdapter, attestation: {kind: mode === "kind-mismatch" ? "other-owned-kind" : "owned-observation", strategy}};
}
`, "utf8");
    await writeFile(serverWrapper, 'import {startMcpServer} from "./mcp-server/dist/server.mjs";\nimport {installation} from "./authority.mjs";\nconst {executionAdapters} = installation(process.env.AGENT_GOVERNANCE_HOST_ATTESTATION);\nawait startMcpServer(new Map(), executionAdapters);\n', "utf8");
    await writeFile(hookWrapper, `
import {readFileSync} from "node:fs";
import {runGovernanceHook} from "./mcp-server/dist/governance-hook.mjs";
import {installation} from "./authority.mjs";
const {adapter, composition, executionAdapters} = installation(process.env.AGENT_GOVERNANCE_HOST_ATTESTATION);
const mode = process.argv[2];
const selected = mode === "missing-execution" ? new Map() : mode === "execution-host" ? new Map([[adapter.host, {...adapter, host: "other-owned-host", modelClassForModel() {return "deep";}}]]) : executionAdapters;
const result = await runGovernanceHook(adapter.host, readFileSync(0, "utf8"), process.env, selected, composition(mode));
process.stdout.write(result.output); if (!result.ok) process.exitCode = 2;
`, "utf8");
    const protectedFiles = [authority, serverWrapper, hookWrapper, ...[directory, repository].map(base => path.join(base, "skills/coordinate-subagents/references/model-routing-presets.json"))];
    const unchanged = await Promise.all(protectedFiles.map(file => readFile(file)));
    const api = await import(pathToFileURL(path.join(directory, "mcp-server/dist/host-attestation-api.mjs")).href) as typeof import("../../mcp-server/src/host-attestation-api.js");
    const { installation } = await import(pathToFileURL(authority).href) as { installation(host: string): { adapter: HostExecutionAdapter } };
    const { adapter } = installation(host);
    transport = new StdioClientTransport({ command: process.execPath, args: [serverWrapper], cwd: directory, env: environment, stderr: "pipe" });
    client = new Client({ name: "owned-host-public-entry", version: "1.0.0" }); await client.connect(transport);
    const issue = (tool: string, input: Record<string, unknown>, model: string, mode = "installed", effort = "high", extra: Record<string, unknown> = {}) => {
      const issued = spawnSync(process.execPath, mode === "default" ? [path.join(directory, "mcp-server/dist/governance-hook.mjs"), `--host=${host}`] : [hookWrapper, mode], {
        cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
        input: JSON.stringify({ event: { phase: "before", session: sessionId, call: randomUUID(), tool: `mcp__owned_installation__${tool}`, args: input },
          observed: { model, effort }, tool_input: { _sessionBinding: "caller-decoy-must-not-override-first-translation" }, ...extra }) });
      expect(issued.error).toBeUndefined();
      return { status: issued.status, stderr: issued.stderr, output: issued.stdout ? JSON.parse(issued.stdout) as Record<string, unknown> : {} };
    };
    const hook = (tool: string, input: Record<string, unknown>, model: string, effort = "high", extra: Record<string, unknown> = {}) => {
      const issued = issue(tool, input, model, "installed", effort, extra); expect(issued.status, issued.stderr).toBe(0);
      const specific = issued.output.hookSpecificOutput as { permissionDecision?: string; updatedInput: Record<string, unknown> };
      expect(specific.permissionDecision).toBeUndefined(); expect(decoded(specific.updatedInput._sessionProof)).toMatchObject({ host, sessionId, tool });
      return specific.updatedInput;
    };
    const rawCall = async <T>(name: string, args: Record<string, unknown>) => envelope<T>(await client!.callTool({ name, arguments: args }));
    const call = async <T>(name: string, args: Record<string, unknown>, model: string) => rawCall<T>(name, hook(name, args, model));
    const rooted = (args: Record<string, unknown>): Record<string, unknown> => {
      const store = new SqliteWorkflowStore(database), clean = withoutSessionProof(args);
      try { return { ...clean, _sessionProof: new SessionActorProofs(store).issue({ host, sessionId, callId: randomUUID(), kind: "tool-boundary", boundaryPhase: "before",
        actor: { role: "root", basis: "observed", reasonCode: "OWNED_SYNTHETIC_ROOT" } }, "plan_workflow", clean) }; } finally { store.close(); }
    };
    const observedBy = (issuer: HostExecutionAdapter, args: Record<string, unknown>, model: string, effort: ReasoningEffortV1 = "high") => {
      const ingress = api.openHostAttestation(database, issuer);
      try { return rooted(ingress.runObserved("plan_workflow", args, () => ({ model, reasoningEffort: effort,
        actorId: api.hostActorId(host, sessionId), sessionId, turnId: null, toolUseId: randomUUID() }), input => input)); } finally { ingress.close(); }
    };
    return { host, api, adapter, directory, issue, hook, call, rawCall, rooted, observedBy, installationBytes: unchanged,
      async unchanged() { expect(await Promise.all(protectedFiles.map(file => readFile(file)))).toEqual(unchanged); },
      async close() { try { await client?.close(); } finally { try { await transport?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } } };
  } catch (error) {
    try { await client?.close(); } finally { try { await transport?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
    throw error;
  }
}

it("preserves two fresh opaque hosts with identical installation bytes through public built hook and guarded finalization", async () => {
  let originalInstallationBytes: Buffer[] | undefined;
  for (const host of [`owned-${randomUUID()}`, `owned-${randomUUID()}`]) {
    const f = await fixture(host);
    try {
      if (originalInstallationBytes === undefined) originalInstallationBytes = f.installationBytes;
      else expect(f.installationBytes).toEqual(originalInstallationBytes);
      const model = randomUUID(), request = task(`owned-host-${randomUUID()}`), args = { schemaVersion: "1.0.0", taskEnvelope: request };
      const catalog = await readFile(path.join(f.directory, "skills/coordinate-subagents/references/model-routing-presets.json"), "utf8");
      expect(catalog).not.toContain(host); expect(catalog).not.toContain(model);
      // This installed positive isolates caller JSON from trusted composition; the actual MCP still succeeds.
      const signed = f.hook("plan_workflow", { ...args, _hostAttestation: "caller-model-token", _sessionProof: "caller-root-token" }, model, "high", {
        inputAdapter: { host: "caller-host", actor: "child", ownsTool: false },
        attestation: { kind: "caller-strategy", strategy: { provider: "caller-provider", policyRevision: "caller-policy" } },
        executionAdapters: { [host]: { host: "caller-host", provider: "caller-provider", policyRevision: "caller-policy", modelClass: "frontier" } },
      });
      expect(signed._hostAttestation).not.toBe("caller-model-token"); expect(signed._sessionProof).not.toBe("caller-root-token");
      expect(decoded(signed._hostAttestation)).toMatchObject({ host, model, session: hostIdentityDigest(sessionId), eligibility: { provider: "owned-host-authority", resolvedModel: "owned-fixed-capability", modelClass: "deep", policyRevision: "owned-host-r1" } });
      const planned = await f.rawCall<WorkflowPlanV1>("plan_workflow", signed); expect(planned.error).toBeNull();
      const plan = planned.data!; expect(plan.bootstrapExecution?.context).toMatchObject({ model, modelClass: "deep", actorId: f.api.hostActorId(host, sessionId) });
      const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: request.taskId, locator: "fixture:workspace" },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
      const root = await f.call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: request, frame, userApprovalRefs: [] }, model); expect(root.error).toBeNull();
      const lease = await f.call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: root.data!.rootId, expectedRevision: root.data!.revision,
        taskEnvelope: request, frame, plan, actorId: f.api.hostActorId(host, sessionId), outputTargets: ["fixture.md"], priorFailure: null }, model); expect(lease.error).toBeNull();
      const started = await f.call<WorkflowReceiptV1>("start_guarded_workflow", { schemaVersion: "1.0.0", leaseId: lease.data!.leaseId, expectedRootRevision: lease.data!.rootRevision, plan }, model); expect(started.error).toBeNull();
      const receipt = started.data!, stage = receipt.plan.stages[0]!;
      const recorded = await f.call<WorkflowReceiptV1>("record_stage_result", { schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed", responseMode: "full",
        output: { schemaVersion: "1.0.0", kind: "output", output: { completed: true }, artifacts: request.artifactContracts[0]!.produced.map(item => ({ ...item, locator: `fixture:${item.artifactId}`, digest: "d".repeat(64), verified: true })), error: null },
        evidence: [{ artifactId: "fixture", kind: "test", locator: "host-composition-stdio.test.ts", verified: true, note: "Owned synthetic source fixture, not native capture" }], findings: [], blockers: [], error: null }, model);
      expect(recorded.error).toBeNull(); expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model, actorId: f.api.hostActorId(host, sessionId) });
      const final = await f.call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision }, model); expect(final.error).toBeNull(); expect(final.data?.state).toBe("passed");
      const board = await f.call<{ host: string; sessionId: string }>("update_session_status", { schemaVersion: "1.0.0", summary: "Owned synthetic host fixture" }, model);
      expect(board.error).toBeNull(); expect(board.data).toMatchObject({ host, sessionId });
      const message = f.hook("validate_collaboration_decision", { decision: {} }, model);
      expect(decoded(message._sessionProof)).toMatchObject({ host, sessionId, tool: "validate_collaboration_decision" }); expect(message).not.toHaveProperty("_sessionBinding");
      expect((await f.rawCall("plan_workflow", signed)).error).toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "ROOT_PROOF_ALREADY_CONSUMED" } });
      await f.unchanged();
    } finally { await f.close(); }
  }
}, 30_000);

it("rejects incomplete host composition and unavailable actors while retaining default unknown-host denial", async () => {
  const f = await fixture(`owned-${randomUUID()}`);
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-negatives") };
    for (const [mode, reason] of [["kind-mismatch", "HOST_HOOK_COMPOSITION_UNAVAILABLE"], ["missing-input", "HOST_HOOK_COMPOSITION_UNAVAILABLE"],
      ["missing-ownership", "HOST_HOOK_COMPOSITION_UNAVAILABLE"], ["missing-kind", "HOST_HOOK_COMPOSITION_UNAVAILABLE"], ["missing-strategy", "HOST_ATTESTATION_STRATEGY_UNAVAILABLE"],
      ["missing-execution", "HOST_EXECUTION_ADAPTER_UNAVAILABLE"], ["execution-host", "HOST_EXECUTION_ADAPTER_UNAVAILABLE"], ["observation-host", "HOST_HOOK_OBSERVATION_MISMATCH"],
      ["echo", "HOST_ATTESTATION_STRATEGY_UNAVAILABLE"], ["throws", "GOVERNANCE_HOOK_FAILED"]]) {
      const result = f.issue("plan_workflow", { ...args, _hostAttestation: "caller-token-must-be-stripped" }, model, mode);
      expect(result.status, result.stderr).toBe(2); expect(result.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } });
      expect(JSON.stringify(result.output)).not.toContain("_sessionProof");
    }
    for (const mode of ["return-false", "return-zero", "return-empty", "return-null", "return-undefined", "return-array", "updated-array"]) {
      const result = f.issue("plan_workflow", args, model, mode); expect(result.status).toBe(2);
      expect(result.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "HOST_ATTESTATION_STRATEGY_UNAVAILABLE" } });
      expect(JSON.stringify(result.output)).not.toContain("_sessionProof");
    }
    for (const [mode, reason] of [["child", "OWNED_CHILD"], ["actor-unavailable", "OWNED_ACTOR_UNAVAILABLE"], ["actor-accessor", "ACTOR_OBSERVATION_INVALID"], ["actor-proxy", "ACTOR_OBSERVATION_INVALID"]]) {
      const result = f.issue("plan_workflow", args, model, mode); expect(result.status).toBe(0);
      expect(result.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } }); expect(JSON.stringify(result.output)).not.toContain("_sessionProof");
    }
    const unowned = f.issue("plan_workflow", args, model, "unowned"); expect(unowned.status).toBe(0); expect(unowned.output).toEqual({});
    const denied = f.issue("plan_workflow", args, model, "domain-deny"); expect(denied.status).toBe(0);
    expect(denied.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "OWNED_DOMAIN_DENY" } }); expect(JSON.stringify(denied.output)).not.toContain("_sessionProof");
    // Compatibility only: default opaque-host adapter absence precedes interpretation of caller JSON fields.
    const caller = f.issue("plan_workflow", args, model, "default", "high", { inputAdapter: { actor: "root" }, attestation: { kind: "owned-observation" }, executionAdapters: { [f.host]: { modelClass: "frontier" } } });
    expect(caller.status).toBe(2); expect(JSON.stringify(caller.output)).not.toContain("_sessionProof");
    const binding = f.issue("plan_workflow", { ...args, _sessionBinding: { host: f.host, sessionId } }, model);
    expect(binding.output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "CALLER_SESSION_BINDING_REJECTED" } });
    expect(JSON.stringify(binding.output)).not.toContain("_sessionProof");
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);

it("reaches actual capability and authority rejection with a genuine fresh root proof", async () => {
  const f = await fixture(`owned-${randomUUID()}`);
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-authority") };
    for (const field of ["provider", "policyRevision"] as const) {
      const replacement = `other-owned-${field}`;
      const issuer: HostExecutionAdapter = { host: f.host, provider: f.adapter.provider!, policyRevision: f.adapter.policyRevision!, modelClassForModel: () => "deep",
        [field]: replacement, resolveModel: (rawModel, provenance) => ({ ...f.adapter.resolveModel!(rawModel, provenance)!, [field]: replacement }) };
      expect((await f.rawCall("plan_workflow", f.observedBy(issuer, args, model))).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    }
    const absent: HostExecutionAdapter = { host: f.host, provider: f.adapter.provider!, policyRevision: f.adapter.policyRevision!, modelClassForModel: () => "deep", resolveModel: () => null };
    const noEligibility = f.observedBy(absent, args, model); expect(decoded(noEligibility._hostAttestation).eligibility).toBeNull();
    expect((await f.rawCall("plan_workflow", noEligibility)).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    const nullIssued = f.issue("plan_workflow", args, model, "null-eligibility"); expect(nullIssued.status).toBe(0);
    const nullArgs = (nullIssued.output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    expect(decoded(nullArgs._hostAttestation).eligibility).toBeNull(); expect(decoded(nullArgs._sessionProof)).toMatchObject({ host: f.host, sessionId });
    expect((await f.rawCall("plan_workflow", nullArgs)).error).toMatchObject({ code: "BINDING_INVALID", message: "Host observation has no matching trusted execution capability and policy revision." });
    const effort = f.hook("plan_workflow", args, model, "medium"); expect(decoded(effort._hostAttestation).eligibility).not.toBeNull();
    expect((await f.rawCall("plan_workflow", effort)).error).toMatchObject({ code: "BINDING_INVALID", details: { reasoningEffort: "medium", minimumReasoningEffort: "high" } });
    const forged = withoutSessionProof(f.hook("plan_workflow", args, model)), [prefix, body, signature] = (forged._hostAttestation as string).split(".");
    const changed = decoded(forged._hostAttestation); changed.eligibility = { ...(changed.eligibility as Record<string, unknown>), modelClass: "frontier" };
    forged._hostAttestation = `${prefix}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    expect(body).not.toBe((forged._hostAttestation as string).split(".")[1]);
    expect((await f.rawCall("plan_workflow", f.rooted(forged))).error).toMatchObject({ code: "BINDING_INVALID", message: "Host attestation token signature is invalid." });
    await f.unchanged();
  } finally { await f.close(); }
  const low = await fixture(`owned-${randomUUID()}`, "lightweight");
  try { expect((await low.call("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-low-capability") }, randomUUID())).error)
    .toMatchObject({ code: "BINDING_INVALID", details: { modelClass: "lightweight", minimumModelClass: "general" } }); await low.unchanged(); }
  finally { await low.close(); }
}, 30_000);

it("isolates overlapping same-host snapshots, all nested lookup ports and late async descendants", async () => {
  const host = `owned-${randomUUID()}`;
  const make = (label: string): HookHostAdapter => ({ attestationKind: label, ownsTool: tool => tool === label, processPid: () => 42,
    deliveryProfile: () => ({ transport: label, capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
    peerWait: () => ({ targets: [{ host, sessionId: label }], timeoutMs: 1, queryRevision: label }),
    adaptInput: (_input, selected) => ({ lifecycle: "none", outputEventName: label, observation: { host: selected, sessionId: label, kind: "unknown",
      actor: { role: "indeterminate", basis: "unavailable", reasonCode: "OWNED_UNAVAILABLE" } } }) });
  let release!: () => void, started!: () => void, startedCount = 0, late!: Promise<unknown>;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  let releaseLate!: () => void; const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
  const a = make("A"), b = make("B");
  const run = (adapter: HookHostAdapter, label: string) => withHookHostAdapter(host, adapter, async () => {
    if (++startedCount === 2) started();
    if (label === "A") late = lateGate.then(() => { try { return hookAttestationKind(host); } catch (error) { return error; } });
    await gate;
    expect(adaptHostInput({}, host).observation.sessionId).toBe(label); expect(isGovernanceHookTool(host, label)).toBe(true);
    expect(() => adaptHostInput({}, host)).toThrow("Canonical hook arguments unavailable");
    expect(adaptHostInput({ tool_input: { cleaned: label } }, host).observation.toolInput).toEqual({ cleaned: label });
    expect(hookAttestationKind(host)).toBe(label); expect(hostDeliveryProfile(host).transport).toBe(label);
    expect(resolveHookProcessPid(host)).toBe(42); expect(nativePeerWait({ host, sessionId: label, kind: "unknown", actor: { role: "indeterminate", basis: "unavailable", reasonCode: "OWNED_UNAVAILABLE" } })?.queryRevision).toBe(label);
    expect(() => hookAttestationKind("claude-code")).toThrow("different host");
  });
  const first = run(a, "A"), second = run(b, "B"); await ready;
  a.ownsTool = () => false; a.attestationKind = "mutated"; b.deliveryProfile = a.deliveryProfile;
  release(); await Promise.all([first, second]); releaseLate(); expect(await late).toMatchObject({ details: { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" } });
  expect(hookAttestationKind(host)).toBeUndefined();
});
