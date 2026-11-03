// Owned synthetic installation fixture; no native capture, native host support or default producer is claimed.
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stream } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect } from "vitest";
import type { ApiResultV1, AttemptLeaseV1, ConvergenceRootV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { RESERVED_CALLER_KEYS } from "../../mcp-server/src/caller-identity.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { codexCallMeta } from "../helpers/caller.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";
import { stdioServerTests, type StdioServer, type StdioStart } from "../helpers/stdio-server.js";

const repository = fileURLToPath(new URL("../../", import.meta.url)), sessionId = "owned-host-session";
function envelope<T>(response: Awaited<ReturnType<Client["callTool"]>>): ApiResultV1<T> {
  const content = response.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as ApiResultV1<T>;
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

const startupTrace = new URL("../session-messaging/fixtures/presence-startup-trace.mjs", import.meta.url).href;
const STARTUP_EVENTS = new Set(["preload", "powershell-start", "powershell-end", "keygen-start", "keygen-end", "tls-create", "tls-created", "tls-listening"]);
/** Drains the server's stderr (an unread pipe could block its writes) and forwards at most 20 shaped startup records. */
function traceServerStartup(stderr: Stream | null | undefined, trace: (stage: string, details?: Record<string, unknown>) => void) {
  if (!stderr) return;
  let tail = "", forwarded = 0, discarded = 0, firstByte = true;
  stderr.on("data", (chunk: Buffer) => {
    if (firstByte) { firstByte = false; trace("server.stderr-first"); }
    const lines = (tail + chunk.toString("utf8")).split("\n");
    tail = lines.pop()!;
    if (tail.length > 1024) { tail = ""; discarded++; }
    for (const line of lines) {
      if (forwarded >= 20 || line.length > 512 || !line.startsWith("AGS_PRESENCE_STARTUP ")) { discarded++; continue; }
      try {
        const value = JSON.parse(line.slice("AGS_PRESENCE_STARTUP ".length)) as Record<string, unknown>;
        if (!STARTUP_EVENTS.has(value.event as string) || typeof value.atMs !== "number" || !Number.isFinite(value.atMs)) { discarded++; continue; }
        const details: Record<string, unknown> = { childMs: value.atMs };
        for (const key of ["call", "durationMs", "outcome"] as const) if (typeof value[key] === "number" || typeof value[key] === "string") details[key] = value[key];
        for (const key of ["caller", "kind"] as const) if (typeof value[key] === "string" && /^[a-z-]{1,24}$/u.test(value[key] as string)) details[key] = value[key];
        forwarded++;
        trace(`server.${value.event as string}`, details);
      } catch { discarded++; }
    }
  });
  stderr.once("end", () => trace("server.stderr-end", { forwarded, discarded }));
}

async function fixture(scope: StdioStart, host: string, modelClass: "deep" | "lightweight" = "deep", resolvable = true) {
  // 고유 fixture와 누적 시간을 남겨 전체 30초 중 마지막으로 진입한 단계를 구분한다.
  // 호출 인자·출력과 자식 표준 오류 본문은 기록하지 않는다.
  const started = performance.now(), test = expect.getState().currentTestName;
  let sequence = 0;
  const trace = (stage: string, details: Record<string, unknown> = {}) => process.stderr.write(
    `[시험단계] ${JSON.stringify({ fixture: host, test, modelClass, sequence: ++sequence, stage, elapsedMs: performance.now() - started, ...details })}\n`);
  trace("fixture.begin");
  const directory = await mkdtemp(path.join(tmpdir(), "ags-host-composition-")), state = path.join(directory, "state"), database = path.join(state, "workflow.sqlite3");
  let server: StdioServer | undefined;
  try {
    await mkdir(path.join(directory, "mcp-server/dist"), { recursive: true }); await mkdir(state, { recursive: true });
    trace("copy.begin");
    await Promise.all([
      ...["contracts", "skills"].map(name => cp(path.join(repository, name), path.join(directory, name), { recursive: true })),
      ...["server.mjs"].map(name => cp(path.join(repository, "mcp-server/dist", name), path.join(directory, "mcp-server/dist", name))),
    ]);
    trace("copy.end");
    const environment = { ...getDefaultEnvironment(), AGENT_GOVERNANCE_DB_PATH: database, AGENT_GOVERNANCE_HOST_ATTESTATION: host,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"), AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messages") };
    trace("installation.begin");
    const seed = new SqliteWorkflowStore(database);
    try { seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION,
      latestTag: `v${STABLE_VERSION}`, latestCommit: "c".repeat(40), etag: "owned-host", comparison: "up-to-date",
      lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(), nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null }); } finally { seed.close(); }
    const authority = path.join(directory, "authority.mjs"), serverWrapper = path.join(directory, "installation-server.mjs");
    // Stateful prototype methods and inherited getters must survive the public startup composition snapshot.
    await writeFile(authority, `
const descriptor = Object.freeze(${JSON.stringify({ provider: "owned-host-authority", resolvedModel: "owned-fixed-capability", modelClass,
      minimumReasoningEffort: null, supportedEfforts: ["medium", "high"], aliasUsed: false, policyRevision: "owned-host-r1" })});
const resolvable = ${JSON.stringify(resolvable)};
class Execution {
  #descriptor;
  constructor(host) { this.#descriptor = Object.freeze({...descriptor, host}); }
  get host() { return this.#descriptor.host; }
  get provider() { return this.#descriptor.provider; }
  get policyRevision() { return this.#descriptor.policyRevision; }
  modelClassForModel() { return this.#descriptor.modelClass; }
  resolveModel(rawModel, provenance) { return resolvable ? {...this.#descriptor, rawModel, provenance} : null; }
}
export function installation(host) {
  const adapter = new Execution(host), executionAdapters = new Map([[adapter.host, adapter]]);
  return {adapter, executionAdapters};
}
`, "utf8");
    await writeFile(serverWrapper, 'import {startMcpServer} from "./mcp-server/dist/server.mjs";\nimport {installation} from "./authority.mjs";\nconst {executionAdapters} = installation(process.env.AGENT_GOVERNANCE_HOST_ATTESTATION);\nawait startMcpServer(new Map(), executionAdapters);\n', "utf8");
    const protectedFiles = [authority, serverWrapper, ...[directory, repository].map(base => path.join(base, "skills/coordinate-subagents/references/model-routing-presets.json"))];
    const unchanged = await Promise.all(protectedFiles.map(file => readFile(file)));
    // D0363: connect spans the server's whole start. The disposable preload reports only shaped, path-free startup
    // stages (Windows keygen/TLS/PowerShell calls) as they arrive, so a stalled connect still shows its last stage.
    trace("connect.begin");
    server = await scope.connect("owned-host-public-entry", { command: process.execPath, args: ["--import", startupTrace, serverWrapper], cwd: directory, env: environment },
      stream => traceServerStartup(stream, trace));
    trace("connect.end");
    const { client } = server;
    // The installed host writes the caller into tools/call _meta; no hook rewrites arguments.
    const rawCall = async <T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      trace("call.begin", { tool: name });
      let returned = false;
      try {
        const response = envelope<T>(await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }));
        returned = true;
        return response;
      } finally { trace("call.end", { tool: name, outcome: returned ? "returned" : "threw" }); }
    };
    const meta = (model: string, effort = "high", options: { thread?: string; parent?: string; callId?: string } = {}) => codexCallMeta(sessionId, { model, effort, ...options });
    const call = async <T>(name: string, args: Record<string, unknown>, model: string, effort = "high") => rawCall<T>(name, args, meta(model, effort));
    return { host, directory, meta, call, rawCall, installationBytes: unchanged,
      async unchanged() { expect(await Promise.all(protectedFiles.map(file => readFile(file)))).toEqual(unchanged); },
      async close() {
        trace("close.begin");
        // Closing the client also closes its transport.
        try { await server?.close(); trace("client-close.returned"); } finally {
          trace("remove.begin");
          await rm(directory, { recursive: true, force: true });
          trace("remove.returned");
        }
      } };
  } catch (error) {
    trace("fixture.error");
    try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

// Every installed server of a test starts before the test's time limit starts (stdioServerTests); the limit measures only
// the calls and shutdowns. Installations of one test are independent directories, so starting them first changes nothing.
const serverTest = stdioServerTests();
async function fixtures<K extends string>(scope: StdioStart, specs: Record<K, Parameters<typeof fixture> extends [unknown, ...infer R] ? R : never>) {
  const started = {} as Record<K, Awaited<ReturnType<typeof fixture>>>;
  for (const [name, spec] of Object.entries(specs) as Array<[K, Parameters<typeof fixture> extends [unknown, ...infer R] ? R : never]>) {
    const f = await fixture(scope, ...spec);
    scope.defer(() => f.close());
    started[name] = f;
  }
  return started;
}

serverTest("preserves identical installation bytes through public startup and guarded finalization, and gives an unknown host no ingress",
  scope => fixtures(scope, { codex: ["codex"], unknown: [`owned-${randomUUID()}`] }), async ({ codex, unknown }) => {
  let originalInstallationBytes: Buffer[] | undefined;
  for (const f of [codex, unknown]) {
    const host = f.host;
    try {
      if (originalInstallationBytes === undefined) originalInstallationBytes = f.installationBytes;
      else expect(f.installationBytes).toEqual(originalInstallationBytes);
      const model = randomUUID(), request = task(`owned-host-${randomUUID()}`), args = { schemaVersion: "1.0.0", taskEnvelope: request };
      const catalog = await readFile(path.join(f.directory, "skills/coordinate-subagents/references/model-routing-presets.json"), "utf8");
      expect(catalog).not.toContain(model);
      if (host !== "codex") {
        // Only the built-in hosts have a caller ingress; an unknown host is never presumed to be a root.
        expect((await f.call("plan_workflow", args, model)).error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "HOST_INGRESS_UNAVAILABLE" } });
        expect((await f.call("update_session_status", { schemaVersion: "1.0.0", summary: "Owned synthetic host fixture" }, model)).error)
          .toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "HOST_INGRESS_UNAVAILABLE" } });
        await f.unchanged();
        continue;
      }
      // Caller identity in arguments is rejected before any domain work; the host-written _meta is the only source.
      for (const field of RESERVED_CALLER_KEYS) {
        expect((await f.call("plan_workflow", { ...args, [field]: "caller-token" }, model)).error, field)
          .toMatchObject({ code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field } });
      }
      const planMeta = f.meta(model);
      const planned = await f.rawCall<WorkflowPlanV1>("plan_workflow", args, planMeta); expect(planned.error).toBeNull();
      const plan = planned.data!; expect(plan.bootstrapExecution?.context).toMatchObject({ model, modelClass: "deep", actorId: hostActorId(host, sessionId) });
      const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: request.taskId, locator: "fixture:workspace" },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
      const root = await f.call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: request, frame, userApprovalRefs: [] }, model); expect(root.error).toBeNull();
      const lease = await f.call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: root.data!.rootId, expectedRevision: root.data!.revision,
        taskEnvelope: request, frame, plan, outputTargets: ["fixture.md"], priorFailure: null }, model); expect(lease.error).toBeNull();
      const started = await f.call<WorkflowReceiptV1>("start_guarded_workflow", { schemaVersion: "1.0.0", leaseId: lease.data!.leaseId, expectedRootRevision: lease.data!.rootRevision, plan }, model); expect(started.error).toBeNull();
      const receipt = started.data!, stage = receipt.plan.stages[0]!;
      const recorded = await f.call<WorkflowReceiptV1>("record_stage_result", { schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed", responseMode: "full",
        output: { schemaVersion: "1.0.0", kind: "output", output: { completed: true }, artifacts: request.artifactContracts[0]!.produced.map(item => ({ ...item, locator: `fixture:${item.artifactId}`, digest: "d".repeat(64), verified: true })), error: null },
        evidence: [{ artifactId: "fixture", kind: "test", locator: "host-composition-stdio.test.ts", verified: true, note: "Owned synthetic source fixture, not native capture" }], findings: [], blockers: [], error: null }, model);
      expect(recorded.error).toBeNull(); expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model, actorId: hostActorId(host, sessionId) });
      const final = await f.call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision }, model); expect(final.error).toBeNull(); expect(final.data?.state).toBe("passed");
      // The server writes the summary under the verified caller and creates the board file (board design D3).
      const board = await f.call<{ summary: string; summaryAt: string }>("update_session_status", { schemaVersion: "1.0.0", summary: "Owned synthetic host fixture" }, model);
      expect(board.error).toBeNull(); expect(board.data).toMatchObject({ summary: "Owned synthetic host fixture" });
      // One host call yields one consumable observation: the same call ID again is a replay.
      expect((await f.rawCall("plan_workflow", args, planMeta)).error).toMatchObject({ code: "BINDING_INVALID" });
      await f.unchanged();
    } finally { await f.close(); }
  }
}, 30_000);

serverTest("rejects unobserved callers and admits an observed child caller", scope => fixture(scope, "codex"), async f => {
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-negatives") };
    expect((await f.rawCall("plan_workflow", args)).error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling drops this field
    const { sessionId: _missing, ...withoutSession } = f.meta(model);
    expect((await f.rawCall("plan_workflow", args, withoutSession)).error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } });
    // A non-root thread without a parent contradicts itself; it is rejected, not admitted as a root.
    expect((await f.rawCall("plan_workflow", args, f.meta(model, "high", { thread: "owned-child-thread" }))).error)
      .toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "CODEX_ROOT_THREAD_MISMATCH" } });
    // Observed child callers are allowed (docs/ags30-session-binding-design.md 2.0); the child acts as itself.
    const child = await f.rawCall<WorkflowPlanV1>("plan_workflow", args, f.meta(model, "high", { thread: "owned-child-thread", parent: sessionId }));
    expect(child.error).toBeNull();
    expect(child.data?.bootstrapExecution?.context.actorId).toBe(hostActorId("codex", sessionId, "owned-child-thread"));
    await f.unchanged();
  } finally { await f.close(); }
}, 30_000);

serverTest("reaches actual capability and authority rejection with a host-observed caller",
  scope => fixtures(scope, { f: ["codex"], absent: ["codex", "deep", false], low: ["codex", "lightweight"] }), async ({ f, absent, low }) => {
  try {
    const model = randomUUID(), args = { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-authority") };
    const admitted = await f.call<WorkflowPlanV1>("plan_workflow", args, model, "medium");
    expect(admitted.ok).toBe(true);
    expect(admitted.data?.bootstrapExecution?.context.reasoningEffort).toBe("medium");
    // AGS 3.1.1: the root session's effort is the user's choice; an effort the catalog does not support is recorded.
    const low = await f.call<WorkflowPlanV1>("plan_workflow", args, model, "low");
    expect(low.error).toBeNull();
    expect(low.data?.bootstrapExecution?.context).toMatchObject({ reasoningEffort: "low", policyNotes: ["CURRENT_POLICY_EFFORT_UNSUPPORTED"] });
    await f.unchanged();
  } finally { await f.close(); }
  try {
    // A model the installed catalog cannot resolve still runs with its class unknown.
    const unresolved = await absent.call<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-no-capability") }, randomUUID());
    expect(unresolved.error).toBeNull();
    expect(unresolved.data?.bootstrapExecution?.context).toMatchObject({ modelClass: null, policyNotes: ["MODEL_NOT_IN_CATALOG"] });
    await absent.unchanged();
  } finally { await absent.close(); }
  try { const admitted = await low.call<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: task("owned-host-low-capability") }, randomUUID());
    expect(admitted.ok).toBe(true); expect(admitted.data?.bootstrapExecution?.context.modelClass).toBe("lightweight"); await low.unchanged(); }
  finally { await low.close(); }
}, 30_000);
