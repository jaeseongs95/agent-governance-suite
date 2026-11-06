import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { ConvergenceFrameV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { createRootApprovalHandler, type PendingRootApproval, type RootApprovalRecord, type RootApprovalAction } from "../../mcp-server/src/root-approval.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService, type RootAccess } from "../../mcp-server/src/workflow-service.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-approval-store-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const databasePath = path.join(directory, "workflow.sqlite3");
  const open = () => {
    const store = new SqliteWorkflowStore(databasePath);
    cleanups.push(() => store.close());
    const validator = new ContractValidator();
    return { store, service: new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store) };
  };
  const first = open();
  const task: TaskEnvelopeV1 = { schemaVersion: "1.0.0", taskId: "approval-store-task", objective: "Repair target.",
    scope: { included: ["target.ts"], excluded: [] }, acceptanceCriteria: ["Correct target."], riskLevel: "low",
    workUnits: [{ id: "edit", objective: "Repair.", dependencies: [], writeTargets: ["target.ts"] }],
    requiredCapabilities: ["minimal-implementation"], constraints: [],
    authorization: { allowedActions: ["write"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
  const frame: ConvergenceFrameV1 = { schemaVersion: "1.0.0", workspace: { workspaceId: directory, locator: directory },
    controlArtifacts: [{ artifactId: "validator", role: "validator", locator: "test.ts", digest: convergenceDigest("validator") }],
    targetArtifacts: [{ artifactId: "target", role: "target", locator: "target.ts", digest: convergenceDigest("target") }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
  const input = { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] };
  const root = first.service.openConvergenceRoot(input).data!;
  expect(root).toBeTruthy();
  const current = () => first.store.getConvergenceSnapshot(root.rootId)!.root;
  const access: RootAccess = { actorId: "verified-actor", ownsRoot: () => false, ownedByOtherSession: () => false,
    ownerPresence: () => ({ state: "ended", self: false, ownerBound: true, sessions: [], unavailable: null, observedAt: new Date().toISOString() }) };
  const request = (action: RootApprovalAction) => action === "release-root"
    ? { rootId: root.rootId, expectedRevision: current().revision, reason: "Approved release.", userApprovalRefs: [] }
    : { ...input, parentRootId: root.rootId, taskEnvelope: { ...task, taskId: "replacement" } };
  const gate = () => { const previous = current(); expect(first.store.updateConvergenceRoot({ ...previous, state: "needs-review", revision: previous.revision + 1 }, previous.revision)).toBe(true); };
  const prepare = (service = first.service, action: RootApprovalAction = "release-root", raw: unknown = request(action)) => {
    const result = service.prepareRootApproval(action, raw, access);
    expect(result.error).toBeNull();
    expect(result.data).not.toBeNull();
    return result.data!;
  };
  const record = (pending: PendingRootApproval, service = first.service, requestId = "request-1") => {
    const result = service.recordRootApproval(pending, { kind: "mcp-form", connectionId: "trusted-test-connection", requestId }, access, new AbortController().signal);
    expect(result.error).toBeNull();
    return result.data!;
  };
  return { ...first, directory, databasePath, open, root, current, access, request, gate, prepare, record };
}

describe("D0008 workflow database persistence and competing connections", () => {
  for (const priorVersion of [5, 6]) it(`AP-S01 migrates a populated v${priorVersion} database and reopens without losing existing data`, () => {
    const f = fixture();
    f.store.getOrCreateSecret("migration-fixture", () => "fixture-value");
    const rootBefore = f.current();
    f.store.close();
    const database = new DatabaseSync(f.databasePath);
    database.exec(`DROP TABLE root_approval_decisions; ${priorVersion === 5 ? "DROP TABLE call_admissions;" : ""} PRAGMA user_version = ${priorVersion};`);
    database.close();
    const second = f.open();
    expect(second.store.getSchemaVersion()).toBe(7);
    expect(second.store.getConvergenceSnapshot(f.root.rootId)!.root).toEqual(rootBefore);
    expect(second.store.getOrCreateSecret("migration-fixture", () => "wrong-value")).toBe("fixture-value");
    const pending = f.prepare(second.service).pending;
    const saved = f.record(pending, second.service);
    second.store.close();
    const third = f.open();
    expect(third.store.getRootApproval(saved.approvalId)).toEqual(saved);
    expect(third.service.prepareRootApproval("release-root", { rootId: f.root.rootId, expectedRevision: rootBefore.revision, reason: "retry", userApprovalRefs: [] }, f.access).data?.approvalId)
      .toBe(saved.approvalId);
  });
  it("AP-S02 rolls back a failed approval-record transaction without touching roots", () => {
    const f = fixture();
    const saved = f.record(f.prepare().pending);
    const candidate: RootApprovalRecord = { ...saved, approvalId: "rollback-record", source: { ...saved.source, requestId: "rollback-request" } };
    expect(() => f.store.withWorkflowTransaction(() => { f.store.insertRootApproval(candidate); throw new Error("injected transaction failure"); })).toThrow("injected transaction failure");
    expect(f.store.getRootApproval(candidate.approvalId)).toBeNull();
    expect(f.current()).toEqual(f.root);
    expect(f.store.getRootApproval(saved.approvalId)).toEqual(saved);
  });
  for (const pair of [["replace-root", "replace-root"], ["replace-root", "release-root"], ["release-root", "release-root"]] as const) {
    it(`AP-S03 independent connections fence ${pair.join("/")} after both captured the same revision`, () => {
      const f = fixture();
      if (pair.some(action => action === "replace-root")) f.gate();
      const second = f.open();
      const a = f.prepare(f.service, pair[0]).pending;
      f.record(a);
      const b = f.prepare(second.service, pair[1]).pending;
      if (pair[0] !== pair[1]) f.record(b, second.service, "request-other-action");
      expect(f.service.executePreparedRootOperation(a, f.access, new AbortController().signal).error).toBeNull();
      expect(second.service.executePreparedRootOperation(b, f.access, new AbortController().signal).error?.code).toBe("STALE_REVISION");
      expect(f.current().state).toBe("abandoned");
      expect(second.store.getConvergenceSnapshot(f.root.rootId)!.root).toEqual(f.current());
    });
  }
  it("AP-S04 observes revocation from another connection at the final mutation boundary", () => {
    const f = fixture();
    const pending = f.prepare().pending;
    const saved = f.record(pending);
    const second = f.open();
    expect(second.store.revokeRootApproval(saved.approvalId, "2026-11-07T00:00:00.000Z")).toBe(true);
    expect(f.service.executePreparedRootOperation(pending, f.access, new AbortController().signal).ok).toBe(false);
    expect(f.current()).toEqual(f.root);
  });
  it("AP-N05 reuses accepted decisions in a new unsupported composition and database connection", async () => {
    const f = fixture();
    const saved = f.record(f.prepare().pending);
    const second = f.open();
    const unsupported = { getClientCapabilities: () => ({}), elicitInput: () => { throw new Error("must not elicit"); } } as unknown as Pick<Server, "getClientCapabilities" | "elicitInput">;
    const operation = createRootApprovalHandler(unsupported, second.service);
    const request: Record<string, unknown> = f.request("release-root");
    delete request.userApprovalRefs;
    const result = await operation("release-root", request, f.access, { requestId: "new-process-request", signal: new AbortController().signal });
    expect(result.error).toBeNull();
    expect(f.current().release!.userApprovalRefs).toEqual([saved.approvalId]);
    expect(f.store.getRootApproval(saved.approvalId)).toEqual(saved);
  });
  it("AP-N06 keeps exact scope tuples and rejects replacement expansion", () => {
    const f = fixture();
    f.gate();
    const replacement = f.request("replace-root");
    const saved = f.record(f.prepare(f.service, "replace-root", replacement).pending);
    for (const raw of [
      { ...replacement, taskEnvelope: { ...f.root.taskEnvelope, objective: "Publish unrelated production." }, userApprovalRefs: [saved.approvalId] },
      { ...replacement, taskEnvelope: { ...f.root.taskEnvelope, workUnits: [{ ...f.root.taskEnvelope.workUnits[0]!, writeTargets: ["other.ts"] }] }, userApprovalRefs: [saved.approvalId] },
    ]) expect(f.service.openConvergenceRoot(raw, f.access).ok).toBe(false);
    expect(f.service.releaseConvergenceRoot({ ...f.request("release-root"), userApprovalRefs: [saved.approvalId] }, f.access).ok).toBe(false);
    expect(f.service.openConvergenceRoot({ ...replacement, userApprovalRefs: [saved.approvalId] }, { ...f.access, actorId: "other-actor" }).ok).toBe(false);
    const regeneratedId: Record<string, unknown> = { ...replacement, taskEnvelope: { ...f.root.taskEnvelope, taskId: "regenerated-id" } };
    delete regeneratedId.userApprovalRefs;
    expect(f.service.openConvergenceRoot(regeneratedId, f.access).error).toBeNull();
  });
  it("AP-N08 forwards original request ID/signal and records nothing after a late cancelled accept", async () => {
    const f = fixture();
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const shown = new Promise<void>(resolve => { started = resolve; });
    let options: { relatedRequestId: unknown; signal: AbortSignal } | undefined;
    const producer = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: (_: unknown, requestOptions: typeof options) => {
      options = requestOptions; started(); return new Promise(resolve => { finish = resolve; });
    } } as unknown as Pick<Server, "getClientCapabilities" | "elicitInput">;
    const operation = createRootApprovalHandler(producer, f.service);
    const pending = operation("release-root", f.request("release-root"), f.access, { requestId: "original-request", signal: controller.signal });
    await shown;
    expect(options!.relatedRequestId).toBe("original-request");
    expect(options!.signal).toBe(controller.signal);
    const scope = f.prepare().pending.scopeDigest;
    controller.abort();
    finish({ action: "accept", content: { confirm: true } });
    expect((await pending).error?.details).toMatchObject({ reason: "USER_APPROVAL_CANCELLED" });
    expect(f.store.findRootApproval(scope)).toBeNull();
    expect(f.current()).toEqual(f.root);
  });
  it("AP-N09 preserves a stored decision after execution failure and ignores extra response scope fields", async () => {
    const f = fixture();
    const producer = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => {
      const before = f.current();
      const independent = f.open();
      expect(independent.store.updateConvergenceRoot({ ...before, revision: before.revision + 1 }, before.revision)).toBe(true);
      return { action: "accept", content: { confirm: true, rootId: "forged-root", actorId: "forged-actor", action: "replace-root" } };
    } } as unknown as Pick<Server, "getClientCapabilities" | "elicitInput">;
    const operation = createRootApprovalHandler(producer, f.service);
    expect((await operation("release-root", f.request("release-root"), f.access, { requestId: "first", signal: new AbortController().signal })).error?.code).toBe("STALE_REVISION");
    const next = f.prepare();
    expect(next.approvalId).not.toBeNull();
    expect(f.service.executePreparedRootOperation(next.pending, f.access, new AbortController().signal).error).toBeNull();
  });
  it("AP-N07 rechecks an owner returning online and preserves the accepted decision for a later retry", async () => {
    const f = fixture();
    let online = false;
    let forms = 0;
    const access: RootAccess = { ...f.access, ownerPresence: rootId => ({ ...f.access.ownerPresence(rootId), state: online ? "online" : "ended" }) };
    const producer = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => {
      forms++; online = true; return { action: "accept", content: { confirm: true } };
    } } as unknown as Pick<Server, "getClientCapabilities" | "elicitInput">;
    const operation = createRootApprovalHandler(producer, f.service);
    expect((await operation("release-root", f.request("release-root"), access, { requestId: "first", signal: new AbortController().signal })).error?.details)
      .toMatchObject({ reason: "OWNER_SESSION_ONLINE" });
    expect(f.current()).toEqual(f.root);
    online = false;
    expect((await operation("release-root", f.request("release-root"), access, { requestId: "retry", signal: new AbortController().signal })).error).toBeNull();
    expect(forms).toBe(1);
  });
  it("AP-S03/AP-N10 actual parallel writers deduplicate the same source through product store methods", async () => {
    const f = fixture();
    const saved = f.record(f.prepare().pending);
    const shared = new SharedArrayBuffer(4);
    const flag = new Int32Array(shared);
    const script = `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {tsImport}=await import('tsx/esm/api');
      const {SqliteWorkflowStore}=await tsImport(workerData.moduleUrl,workerData.parentUrl);
      const store=new SqliteWorkflowStore(workerData.databasePath);parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.shared),0,0);try{const saved=store.insertRootApproval(workerData.record);parentPort.postMessage({id:saved.approvalId});}
      finally{store.close();}})().catch(e=>{parentPort.postMessage({error:String(e)});process.exitCode=1;});`;
    const launch = (id: string) => {
      const worker = new Worker(script, { eval: true, workerData: { moduleUrl: new URL("../../mcp-server/src/sqlite-workflow-store.ts", import.meta.url).href,
        parentUrl: import.meta.url, databasePath: f.databasePath, shared,
        record: { ...saved, approvalId: id, source: { ...saved.source, requestId: "parallel-request" } } } });
      cleanups.push(async () => { await worker.terminate(); });
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const result = new Promise<string>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message: { ready?: boolean; id?: string; error?: string }) => {
          if (message.ready) ready(); else if (message.error) reject(new Error(message.error)); else if (message.id) resolve(message.id);
        });
        worker.on("exit", code => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
      });
      return { started, result };
    };
    const a = launch("parallel-a");
    const b = launch("parallel-b");
    await Promise.all([a.started, b.started]);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0, 2);
    const ids = await Promise.all([a.result, b.result]);
    expect(new Set(ids).size).toBe(1);
    expect(["parallel-a", "parallel-b"]).toContain(ids[0]);
    expect([f.store.getRootApproval("parallel-a"), f.store.getRootApproval("parallel-b")].filter(Boolean)).toHaveLength(1);
  });
});
