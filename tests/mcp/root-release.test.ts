import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiResultV1, ConvergenceRootV1, TaskEnvelopeV1, WorkflowPlanV1 } from "../../contracts/types.js";
import { codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { HostAttestationProvider, hostActorId } from "../../mcp-server/src/host-attestation.js";
import { codexExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { closeSessionMessaging } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService, type MinimalWorkflowStartV1 } from "../../mcp-server/src/workflow-service.js";
import { codexCallMeta } from "../helpers/caller.js";

// 3.6.0: a root another session left open (its session ended days ago) kept the whole workspace blocked. ROOT_CONFLICT
// now names the root's times, latest run and owner presence; release_convergence_root lets the owner, or another
// session with the user's decision while the owner is not online, release it; the bypasses that took another
// session's root (frame-change claim, replacement) are refused.
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const OWNER = "release-owner-session";
const OTHER = "release-other-session";
const productDir = fileURLToPath(new URL("../../.phase-fixture/root-release", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type Details = Record<string, unknown> & {
  nextActions: Array<{ action: string; tool: string; arguments?: Record<string, unknown>; requires?: string[] }>;
  ownerPresence: { state: string; self: boolean; ownerBound: boolean; sessions: Array<{ host: string; sessionId: string; actorId: string; state: string }> };
};

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "root-release-"));
  const messaging = path.join(directory, "messaging");
  const validator = new ContractValidator();
  const store = new SqliteWorkflowStore(path.join(directory, "workflow.sqlite3"));
  const continuityStore = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
  const continuity = new ContinuityService(continuityStore, validator, store);
  const provider = new HostAttestationProvider(codexExecutionAdapter);
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), continuity, undefined, undefined, validator,
    "default", provider, path.join(directory, "session-board.sqlite3"), new SessionMessageService(messaging), null, null, codexMetaIngress());
  const client = new Client({ name: "root-release", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // The owner's presence as its hooks would write it, in the state directory the server reads.
  mkdirSync(messaging, { recursive: true });
  const presence = new SessionMessageStore(path.join(messaging, "session-messages.sqlite3"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  cleanups.push(() => { store.close(); continuityStore.close(); presence.close(); closeSessionMessaging(messaging); });
  cleanups.push(async () => { await client.close(); await server.close(); });
  let birth = 0;
  const born = (sessionId: string) => presence.startPresence({ host: "codex", sessionId, instanceId: `instance-${sessionId}-${++birth}`,
    transport: "codex-test", wakeVisibility: "none", canWakeSilently: false });
  const ended = (sessionId: string) => {
    const current = presence.presence({ host: "codex", sessionId });
    expect(presence.endPresence({ host: "codex", sessionId }, "session-end", current.instanceId!)).toBe(true);
  };
  const call = async <T>(name: string, args: Record<string, unknown>, sessionId: string): Promise<ApiResultV1<T>> => {
    const response = await client.callTool({ name, arguments: args, _meta: codexCallMeta(sessionId) });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
    return JSON.parse(text!) as ApiResultV1<T>;
  };
  const start = (writeTargets: string[], sessionId: string, extra: Record<string, unknown> = {}) => call<MinimalWorkflowStartV1>("start_workflow", {
    goal: `Change ${writeTargets.join(", ")}.`, stages: ["minimal-implementation"], acceptanceCriteria: ["The change works."],
    workspace: productDir, writeTargets, ...extra }, sessionId);
  const root = (rootId: string): ConvergenceRootV1 => store.getConvergenceSnapshot(rootId)!.root;
  const release = (rootId: string, sessionId: string, extra: Record<string, unknown> = {}) => call<Record<string, unknown>>("release_convergence_root", {
    rootId, expectedRevision: root(rootId).revision, reason: "The work moved elsewhere.", ...extra }, sessionId);
  return { service, store, continuity, call, start, root, release, born, ended };
}

const releaseAction = (details: Details) => details.nextActions.find(item => item.tool === "release_convergence_root");

describe("ROOT_CONFLICT names the blocking root's times, latest run, owner presence and how to release it", () => {
  it("start_workflow: unknown, online and own owner presence each lead to their own next action", async () => {
    const { start, born, root } = await harness();
    const first = await start(["alpha"], OWNER);
    expect(first.error).toBeNull();
    const rootId = first.data!.rootId;

    const unknown = await start(["alpha"], OTHER);
    expect(unknown.error).toMatchObject({ code: "ROOT_CONFLICT", messageKey: "workflow.service.startWorkflowRootConflict" });
    const details = unknown.error!.details as Details;
    const stored = root(rootId);
    expect(details).toMatchObject({ rootId, ownedBySession: false, rootCreatedAt: stored.createdAt, rootUpdatedAt: stored.updatedAt,
      rootRevision: stored.revision, latestRun: { runId: first.data!.runId, state: "running" } });
    expect(typeof (details.latestRun as { updatedAt: unknown }).updatedAt).toBe("string");
    expect(details.ownerPresence).toMatchObject({ state: "unknown", self: false, ownerBound: true, sessions: [] });
    expect(releaseAction(details)).toEqual({ action: "release-with-user-approval", tool: "release_convergence_root",
      arguments: { rootId, expectedRevision: stored.revision }, requires: ["userApprovalRefs"] });
    expect(unknown.error!.message).toContain(stored.createdAt);
    expect(unknown.error!.message).toContain(first.data!.runId);
    expect(unknown.error!.message).toContain("release_convergence_root");

    born(OWNER);
    const online = await start(["alpha"], OTHER);
    const onlineDetails = online.error!.details as Details;
    expect(onlineDetails.ownerPresence).toMatchObject({ state: "online", ownerBound: true,
      sessions: [{ host: "codex", sessionId: OWNER, actorId: hostActorId("codex", OWNER), state: "online" }] });
    expect(releaseAction(onlineDetails)).toBeUndefined();
    expect(onlineDetails.nextActions).toContainEqual({ action: "ask-owner-session", tool: "prepare_session_message",
      arguments: { targetHost: "codex", targetSessionId: OWNER } });

    const own = await start(["alpha/inner"], OWNER);
    const ownDetails = own.error!.details as Details;
    expect(ownDetails.ownerPresence).toMatchObject({ self: true });
    expect(releaseAction(ownDetails)).toEqual({ action: "release-own-root", tool: "release_convergence_root",
      arguments: { rootId, expectedRevision: root(rootId).revision } });
  });

  it("open_convergence_root carries the same details and guidance", async () => {
    const { start, call, root } = await harness();
    const first = await start(["alpha"], OWNER);
    const blocking = root(first.data!.rootId);
    const opened = await call("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null,
      taskEnvelope: { ...blocking.taskEnvelope, taskId: "task-other-session" }, frame: blocking.frame, userApprovalRefs: [] }, OTHER);
    expect(opened.error).toMatchObject({ code: "ROOT_CONFLICT", messageKey: "workflow.service.activeConvergenceRootCoversWorkspace" });
    const details = opened.error!.details as Details;
    expect(details).toMatchObject({ rootId: blocking.rootId, ownedBySession: false, rootCreatedAt: blocking.createdAt,
      latestRun: { runId: first.data!.runId, state: "running" }, ownerPresence: { state: "unknown", ownerBound: true } });
    expect(details.nextActions[0]).toEqual({ action: "restart-with-disjoint-writeTargets", tool: "open_convergence_root" });
    expect(releaseAction(details)?.action).toBe("release-with-user-approval");
    expect(opened.error!.message).toContain(blocking.createdAt);
  });
});

describe("release_convergence_root", () => {
  it("lets the owner release its own root: the running run is blocked, the root abandoned, and the scope is free", async () => {
    const { start, release, root, store, service } = await harness();
    const first = await start(["alpha"], OWNER);
    const rootId = first.data!.rootId;
    const released = await release(rootId, OWNER);
    expect(released.error).toBeNull();
    expect(released.data).toMatchObject({ rootId, state: "abandoned", closedRun: { runId: first.data!.runId, state: "blocked" },
      release: { releasedByOwner: true, releasedBy: hostActorId("codex", OWNER), previousState: "open", ownerPresence: null,
        userApprovalRefs: [], reason: "The work moved elsewhere.", closedRunId: first.data!.runId } });
    const stored = root(rootId);
    expect(stored).toMatchObject({ state: "abandoned", release: { releasedByOwner: true, closedRunId: first.data!.runId } });
    expect(store.getRun(first.data!.runId)).toMatchObject({ state: "blocked", blockers: ["root-released"] });
    expect(store.getConvergenceSnapshot(rootId)!.outcomes.at(-1)).toMatchObject({ workflowRunId: first.data!.runId, state: "aborted" });
    expect(service.getConvergenceStatus(rootId).error).toBeNull();

    // The scope no longer blocks another session.
    expect((await start(["alpha"], OTHER)).error).toBeNull();
    // A returning owner learns why its root is gone.
    const resumed = await start(["alpha"], OWNER, { rootId, priorFailure: { hypothesis: "h", changeSummary: "c", discriminator: "d",
      evidenceRefs: [registryPath] } });
    expect(resumed.error).toMatchObject({ code: "INVALID_TRANSITION", messageKey: "workflow.service.rootReleased",
      details: { reason: "ROOT_RELEASED", rootId, release: { reason: "The work moved elsewhere.", releasedByOwner: true } } });
    expect(resumed.error!.message).toContain("The work moved elsewhere.");
    expect((await release(rootId, OWNER)).error).toMatchObject({ code: "INVALID_TRANSITION", details: { reason: "ROOT_NOT_ACTIVE" } });
  });

  it("lets another session release it only while no owner session is online, read at the call, and only with the user's decision", async () => {
    const { start, release, root, born, ended } = await harness();
    const first = await start(["alpha"], OWNER);
    const rootId = first.data!.rootId;
    const approval = { userApprovalRefs: ["user-message: release the stale alpha root"] };

    born(OWNER);
    expect((await release(rootId, OTHER, approval)).error).toMatchObject({ code: "INVALID_TRANSITION",
      details: { reason: "OWNER_SESSION_ONLINE", ownerPresence: { state: "online" } } });
    expect(root(rootId).state).toBe("open");

    ended(OWNER);
    // The conflict said ended; the owner came back before the release: the release reads presence again and refuses.
    expect(((await start(["alpha"], OTHER)).error!.details as Details).ownerPresence.state).toBe("ended");
    born(OWNER);
    expect((await release(rootId, OTHER, approval)).error?.details).toMatchObject({ reason: "OWNER_SESSION_ONLINE" });
    ended(OWNER);

    expect((await release(rootId, OTHER)).error).toMatchObject({ code: "INVALID_INPUT", details: { reason: "USER_APPROVAL_REQUIRED" } });
    expect((await release(rootId, OTHER, { ...approval, expectedRevision: root(rootId).revision + 1 })).error?.code).toBe("STALE_REVISION");
    expect(root(rootId).state).toBe("open");

    const released = await release(rootId, OTHER, approval);
    expect(released.error).toBeNull();
    expect(root(rootId).release).toMatchObject({ releasedByOwner: false, releasedBy: hostActorId("codex", OTHER), ownerPresence: "ended",
      ownerActors: [hostActorId("codex", OWNER)], userApprovalRefs: approval.userApprovalRefs, closedRunId: first.data!.runId });
    expect(typeof root(rootId).release!.presenceObservedAt).toBe("string");
    expect((await start(["alpha"], OTHER)).error).toBeNull();
  });

  it("releases a root whose owner presence is no longer kept (unknown) only with the user's decision", async () => {
    const { start, release, root } = await harness();
    const first = await start(["beta"], OWNER);
    expect((await release(first.data!.rootId, OTHER)).error?.details).toMatchObject({ reason: "USER_APPROVAL_REQUIRED", ownerPresence: { state: "unknown" } });
    const released = await release(first.data!.rootId, OTHER, { userApprovalRefs: ["user-decision-1"] });
    expect(released.error).toBeNull();
    expect(root(first.data!.rootId).release).toMatchObject({ releasedByOwner: false, ownerPresence: "unknown", ownerActors: [] });
  });
});

describe("another session's root is not taken by the old bypasses", () => {
  /** The root's task with a changed objective: a claim with it changes the frame. */
  const changedTask = (root: ConvergenceRootV1): TaskEnvelopeV1 => ({ ...root.taskEnvelope, objective: `${root.taskEnvelope.objective} Also more.` });

  it("refuses another session's frame-change claim and replacement, and keeps the owner's own", async () => {
    const { start, call, root } = await harness();
    const first = await start(["alpha"], OWNER);
    const rootId = first.data!.rootId;
    const claimWithChangedFrame = async (sessionId: string) => {
      const current = root(rootId);
      const task = changedTask(current);
      const planned = await call<WorkflowPlanV1>("plan_workflow", task as unknown as Record<string, unknown>, sessionId);
      expect(planned.error).toBeNull();
      return call("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId, expectedRevision: current.revision, taskEnvelope: task,
        frame: current.frame, plan: planned.data, outputTargets: ["alpha"], priorFailure: null }, sessionId);
    };

    expect((await claimWithChangedFrame(OTHER)).error).toMatchObject({ code: "INVALID_INPUT", details: { reason: "ROOT_NOT_OWNED", rootId } });
    expect(root(rootId).state).toBe("open");
    // The owner's own frame change still moves its root to review.
    expect((await claimWithChangedFrame(OWNER)).error?.code).toBe("FRAME_REVIEW_REQUIRED");
    expect(root(rootId).state).toBe("needs-review");

    const parent = root(rootId);
    const replaced = await call("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: rootId,
      taskEnvelope: { ...parent.taskEnvelope, taskId: "task-replacement" }, frame: parent.frame, userApprovalRefs: ["user-approval:replace"] }, OTHER);
    expect(replaced.error).toMatchObject({ code: "INVALID_INPUT", details: { reason: "ROOT_NOT_OWNED", rootId } });
    expect(root(rootId).state).toBe("needs-review");
  });

  it("keeps the previous behavior for a root no session bound", async () => {
    const { service, start, call, root } = await harness();
    const first = await start(["alpha"], OWNER);
    const template = root(first.data!.rootId);
    const locator = "gamma";
    const taskEnvelope: TaskEnvelopeV1 = { ...template.taskEnvelope, taskId: "task-unbound", scope: { included: [locator], excluded: [] },
      workUnits: [{ ...template.taskEnvelope.workUnits[0]!, writeTargets: [locator] }] };
    const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope, userApprovalRefs: [],
      frame: { ...template.frame, targetArtifacts: [{ artifactId: "target-1", role: "target", locator,
        digest: convergenceDigest({ objective: taskEnvelope.objective, locator }) }] } });
    expect(opened.error).toBeNull();
    const unbound = opened.data!;
    const task = changedTask(unbound);
    const planned = await call<WorkflowPlanV1>("plan_workflow", task as unknown as Record<string, unknown>, OTHER);
    const claimed = await call("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: unbound.rootId, expectedRevision: unbound.revision,
      taskEnvelope: task, frame: unbound.frame, plan: planned.data, outputTargets: [locator], priorFailure: null }, OTHER);
    expect(claimed.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    expect(root(unbound.rootId).state).toBe("needs-review");
  });
});
