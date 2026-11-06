import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiResultV1, ConvergenceFrameV1, ConvergenceRootV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { closeSessionMessaging } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { codexCallMeta, rootCaller } from "../helpers/caller.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const SESSION = "native-approval-caller";

function rootInput(workspace: string) {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "native-approval-task", objective: "Repair the authorized target.",
    scope: { included: ["target.ts"], excluded: [] }, acceptanceCriteria: ["The target is repaired."], riskLevel: "low",
    workUnits: [{ id: "edit", objective: "Repair target.", dependencies: [], writeTargets: ["target.ts"] }],
    requiredCapabilities: ["minimal-implementation"], constraints: [],
    authorization: { allowedActions: ["write"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame: ConvergenceFrameV1 = {
    schemaVersion: "1.0.0", workspace: { workspaceId: workspace, locator: workspace },
    controlArtifacts: [{ artifactId: "validator", role: "validator", locator: "test.ts", digest: convergenceDigest("validator") }],
    targetArtifacts: [{ artifactId: "target", role: "target", locator: "target.ts", digest: convergenceDigest("target") }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
  return { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] };
}

async function harness(support = true, result: () => ElicitResult | Promise<ElicitResult> = () => ({ action: "accept", content: { confirm: true } })) {
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-native-approval-"));
  const validator = new ContractValidator();
  const store = new SqliteWorkflowStore(path.join(directory, "workflow.sqlite3"));
  const continuityStore = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
  const continuity = new ContinuityService(continuityStore, validator, store);
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const messaging = path.join(directory, "messaging");
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), continuity, undefined, undefined, validator,
    "default", null, path.join(directory, "board.sqlite3"), new SessionMessageService(messaging), null, null, codexMetaIngress());
  const client = new Client({ name: "native-approval", version: "1" }, { capabilities: support ? { elicitation: { form: {} } } : {} });
  const forms: Array<{ message: string; requestId: string | number }> = [];
  if (support) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    if ("message" in request.params) forms.push({ message: request.params.message, requestId: extra.requestId });
    return result();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  cleanups.push(() => { store.close(); continuityStore.close(); closeSessionMessaging(messaging); });
  cleanups.push(async () => { await client.close(); await server.close(); });
  const input = rootInput(directory);
  const opened = service.openConvergenceRoot(input);
  expect(opened.error).toBeNull();
  const rootId = opened.data!.rootId;
  const root = () => store.getConvergenceSnapshot(rootId)!.root;
  const call = async <T>(name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await client.callTool({ name, arguments: args, _meta: codexCallMeta(SESSION) }, undefined, signal ? { signal } : undefined);
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
    return JSON.parse(text!) as ApiResultV1<T>;
  };
  const release = (refs: string[] = [], signal?: AbortSignal) => call("release_convergence_root", { rootId, expectedRevision: root().revision,
    reason: "The existing task moved elsewhere.", userApprovalRefs: refs }, signal);
  const replacement = () => ({ ...input, parentRootId: rootId, taskEnvelope: { ...input.taskEnvelope, taskId: "replacement-task" } });
  const gateParent = () => { const current = root(); expect(store.updateConvergenceRoot({ ...current, state: "needs-review", revision: current.revision + 1 }, current.revision)).toBe(true); };
  return { directory, validator, service, store, continuity, client, server, forms, input, rootId, root, call, release, replacement, gateParent };
}

describe("AGS3-D-0008 native producer through actual MCP default composition", () => {
  for (const action of ["release", "replace"] as const) {
    it(`AP-N01 rejects unknown refs on ${action} without eliciting or mutating`, async () => {
      const f = await harness();
      if (action === "replace") f.gateParent();
      const before = f.root();
      const result = action === "release" ? await f.release(["anything"])
        : await f.call("open_convergence_root", { ...f.replacement(), userApprovalRefs: ["anything"] });
      expect(result.ok).toBe(false);
      expect(f.root()).toEqual(before);
      expect(f.forms).toHaveLength(0);
    });
    it(`AP-N02 accepts native form confirm for ${action}`, async () => {
      const f = await harness();
      if (action === "replace") f.gateParent();
      const result = action === "release" ? await f.release() : await f.call<ConvergenceRootV1>("open_convergence_root", f.replacement());
      expect(result.error).toBeNull();
      expect(f.root().state).toBe("abandoned");
      expect(f.forms).toHaveLength(1);
      expect(f.forms[0]!.message).toContain(f.rootId);
      expect(f.forms[0]!.message).toContain(hostActorId("codex", SESSION));
    });
  }
  for (const response of [{ action: "accept", content: { confirm: false } }, { action: "accept" },
    { action: "accept", content: { confirm: "true" } }, { action: "decline" }, { action: "cancel" }] as ElicitResult[]) {
    it(`AP-N03 refuses ${JSON.stringify(response)} without mutation`, async () => {
      const f = await harness(true, () => response);
      const before = f.root();
      expect((await f.release()).ok).toBe(false);
      expect(f.root()).toEqual(before);
      expect(f.forms).toHaveLength(1);
    });
  }
  it("AP-N04 unsupported clients keep own-root release working", async () => {
    const f = await harness(false);
    expect(f.continuity.bindOpenedRoot(rootCaller("codex", SESSION), f.rootId)).toBe(true);
    expect((await f.release()).error).toBeNull();
    expect(f.forms).toHaveLength(0);
  });
  it("AP-N04 unsupported clients refuse only a protected operation without an existing decision", async () => {
    const f = await harness(false);
    const before = f.root();
    expect((await f.release()).error?.details).toMatchObject({ reason: "USER_APPROVAL_PRODUCER_UNSUPPORTED" });
    expect(f.root()).toEqual(before);
    expect(f.forms).toHaveLength(0);
  });
  it("AP-N04 unsupported clients keep initial root creation working", async () => {
    const f = await harness(false);
    expect((await f.release(["anything"])).ok).toBe(false);
    expect(f.continuity.bindOpenedRoot(rootCaller("codex", SESSION), f.rootId)).toBe(true);
    expect((await f.release()).error).toBeNull();
    expect((await f.call("open_convergence_root", { ...f.input, taskEnvelope: { ...f.input.taskEnvelope, taskId: "new-task" } })).error).toBeNull();
    expect(f.forms).toHaveLength(0);
  });
  it("AP-N09 rechecks revision after the form response", async () => {
    const f = await harness(true, () => {
      const root = f.root();
      expect(f.store.updateConvergenceRoot({ ...root, revision: root.revision + 1 }, root.revision)).toBe(true);
      return { action: "accept", content: { confirm: true } };
    });
    const result = await f.release();
    expect(result.error?.code).toBe("STALE_REVISION");
    expect(f.root().state).toBe("open");
    // The accepted decision was committed before the mutation failed. Ref omission reuses it, not another form.
    expect((await f.call("release_convergence_root", { rootId: f.rootId, expectedRevision: f.root().revision, reason: "Retry accepted operation without refs." })).error).toBeNull();
    expect(f.forms).toHaveLength(1);
  });
  it("AP-N08 cancels the original request and ignores a late form accept", async () => {
    let answer!: (result: ElicitResult) => void;
    let shown!: () => void;
    const displayed = new Promise<void>(resolve => { shown = resolve; });
    const f = await harness(true, () => { shown(); return new Promise<ElicitResult>(resolve => { answer = resolve; }); });
    const controller = new AbortController();
    const pending = f.release([], controller.signal);
    const outcome = pending.then(value => value, error => error);
    await displayed;
    controller.abort();
    answer({ action: "accept", content: { confirm: true } });
    await outcome;
    // Drain the request/response continuations; no timing sleep or extra product query.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.root().state).toBe("open");
  });
});
