import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContinuityService, renderHookText } from "../../mcp-server/src/continuity-service.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { StateCleanupService } from "../../mcp-server/src/state-cleanup-service.js";
import { rootCaller } from "../helpers/caller.js";
import { bytes, direct, domainRows, fixture, histories, legacyFixture, legacyRows, memory, NEW_B, NOW, OLD, OLD_A,
  sizedMemory, sql } from "./fixtures/ags38-d53-fixture.js";

// Synthetic host observation only: these tests do not claim native compaction/model evidence.
const host = "synthetic-d53-boundary";
registerHookHostAdapter(host, {
  processPid: () => undefined,
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, name) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host: name,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_D53_ROOT" } } };
  },
});
const resources: Array<{ close(): void }> = [];
afterEach(() => { for (const resource of resources.splice(0).reverse()) resource.close(); });
function own<T extends { close(): void }>(value: T): T { resources.push(value); return value; }
function hook(service: ContinuityService, session: string, source: string) {
  return handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, source }, service, host);
}

describe("D53 API·hook·cleanup의 현재 전용 경계", () => {
  it("D53-BOUNDARY: OLD_A→NEW_B 뒤 API·hook·옛 replay에 OLD_A가 다시 나타나지 않는다", () => {
    const f = own(fixture()), empty = direct(f.service.loadContext({ schemaVersion: "1.0.0" }, f.caller).data);
    expect(empty.memory).toBeNull();
    const aRequest = { schemaVersion: "1.0.0", requestId: "a", expectedStateToken: empty.stateToken, ...memory(OLD_A) };
    expect(f.service.checkpointContext(aRequest, f.caller).ok).toBe(true);
    const oldCandidate = f.service.inspectContext({ schemaVersion: "1.0.0" }, f.caller).data!;
    f.service.markPreCompact(f.session);
    const b = direct(f.save(memory(NEW_B), "b").data);
    const refreshedCompact = hook(f.service, f.session, "compact");
    expect(JSON.stringify(refreshedCompact)).toContain(NEW_B);
    expect(JSON.stringify(refreshedCompact)).not.toContain(OLD_A);
    expect(hook(f.service, f.session, "compact")).toEqual({});
    const loaded = f.service.loadContext({ schemaVersion: "1.0.0" }, f.caller);
    expect(direct(loaded.data)).toEqual(b);
    const inspected = f.service.inspectContext({ schemaVersion: "1.0.0" }, f.caller);
    expect(inspected.data?.summary).toMatchObject({ stateToken: b.stateToken, memoryDigest: b.memoryDigest });
    expect(JSON.stringify(inspected)).not.toContain(NEW_B);
    expect(inspected.data).not.toHaveProperty("memory");
    const replay = f.service.checkpointContext(aRequest, f.caller);
    expect(replay).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    const resumeHook = hook(f.service, f.session, "resume");
    expect(JSON.stringify(resumeHook)).toContain(NEW_B);
    const outputs: unknown[] = [loaded, inspected, replay, refreshedCompact, resumeHook];
    if (oldCandidate.restoreToken) {
      const stale = f.service.loadContext({ schemaVersion: "1.0.0", candidateToken: oldCandidate.restoreToken }, f.caller);
      expect(stale.ok).toBe(false);
      outputs.push(stale);
    }
    const resumed = renderHookText(f.service.restoreCurrentForSession(f.session), "ko");
    expect(resumed).toContain(NEW_B);
    outputs.push(resumed);
    f.service.markPreCompact(f.session);
    const compact = hook(f.service, f.session, "compact");
    expect(JSON.stringify(compact)).toContain(NEW_B);
    outputs.push(compact);
    expect(f.service.compactContext(f.session)).toBeNull();
    for (const output of outputs) expect(JSON.stringify(output)).not.toContain(OLD_A);
    expect(histories(f.databasePath)).toHaveLength(1);
    expect(JSON.stringify(histories(f.databasePath))).toContain(OLD_A); // private TEST oracle proves canary existed.
  });

  it("D53-REFRESH: 같은 epoch 최신 B를 한 번 복구하고 소비 뒤 checkpoint/no-op/late replay로 재개방하지 않는다", () => {
    const f = own(fixture());
    expect(f.save(memory(OLD_A), "a").ok).toBe(true);
    const a = f.current();
    f.service.markPreCompact(f.session);
    const requestB = { schemaVersion: "1.0.0", requestId: "b", expectedStateToken: a.stateToken, ...memory(NEW_B) };
    const b = direct(f.service.checkpointContext(requestB, f.caller).data);
    expect(b.epoch).toBe(a.epoch);
    expect(f.save(memory(NEW_B), "b-noop").data).toEqual(b);
    const first = hook(f.service, f.session, "compact");
    expect(JSON.stringify(first)).toContain(NEW_B);
    expect(JSON.stringify(first)).not.toContain(OLD_A);
    expect(hook(f.service, f.session, "compact")).toEqual({});
    const c = direct(f.save(memory("CURRENT_C_소비뒤갱신"), "c").data);
    expect(c.epoch).toBe(b.epoch);
    expect(hook(f.service, f.session, "compact")).toEqual({});
    expect(f.save(c.memory!, "c-noop").data).toEqual(c);
    expect(hook(f.service, f.session, "compact")).toEqual({});
    const lateReplay = f.service.checkpointContext(requestB, f.caller);
    expect(lateReplay).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    expect(JSON.stringify(lateReplay)).not.toContain(OLD_A);
    expect(JSON.stringify(lateReplay)).not.toContain(NEW_B);
    expect(hook(f.service, f.session, "compact")).toEqual({});
    expect(f.current()).toEqual(c);
  });

  it.each(["clear", "purge", "suppressed"] as const)("D53-REFRESH: %s 경계 뒤에는 pending A나 최신 B를 자동복원하지 않는다", action => {
    const f = own(fixture());
    expect(f.save(memory(OLD_A), "a").ok).toBe(true);
    f.service.markPreCompact(f.session);
    expect(f.save(memory(NEW_B), "b").ok).toBe(true);
    if (action === "clear") f.service.clearSession(f.session);
    else if (action === "purge") expect(f.service.purgeDirectContext({ schemaVersion: "1.0.0", requestId: "purge-b",
      expectedStateToken: f.current().stateToken }, f.caller).ok).toBe(true);
    else expect(f.service.suppressContextRestore({ schemaVersion: "1.0.0", expectedEpoch: f.current().epoch }, f.caller).ok).toBe(true);
    const afterBoundary = hook(f.service, f.session, "compact");
    for (const marker of [OLD_A, NEW_B]) expect(JSON.stringify(afterBoundary)).not.toContain(marker);
    expect(f.service.restoreCurrentForSession(f.session)).toBeNull();
    if (action !== "suppressed") expect(f.current().memory).toBeNull();
  });

  it("D53-BOUNDARY hook: 일반 턴은 본문 없이 갱신 cue, qualified progress callId는 한 번만 cue", () => {
    const f = own(fixture());
    expect(f.save(memory(OLD_A), "a").ok).toBe(true);
    expect(f.save(memory(NEW_B), "b").ok).toBe(true);
    const prompt = handleContinuityHook({ hook_event_name: "UserPromptSubmit", session_id: f.session,
      prompt: "사용자 교정을 반영하고 계속한다" }, f.service, host);
    expect(JSON.stringify(prompt)).toContain("checkpoint_context");
    for (const marker of [OLD_A, NEW_B]) expect(JSON.stringify(prompt)).not.toContain(marker);
    const progress = { hook_event_name: "PostToolUse", session_id: f.session,
      tool_name: "mcp__agent_governance_suite__record_stage_result", tool_use_id: "owned-progress-call", tool_input: {} };
    const first = handleContinuityHook(progress, f.service, host);
    expect(JSON.stringify(first)).toContain("checkpoint_context");
    expect(handleContinuityHook(progress, f.service, host)).toEqual({});
    const unrelated = handleContinuityHook({ ...progress, tool_name: "mcp__another_server__record_stage_result",
      tool_use_id: "owned-unrelated-call" }, f.service, host);
    expect(unrelated).toEqual({});
    for (const marker of [OLD_A, NEW_B]) expect(JSON.stringify(first)).not.toContain(marker);
    const observations = sql(f.databasePath, db => db.prepare("SELECT * FROM continuity_observations WHERE event LIKE 'checkpoint-progress:%'").all());
    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain("owned-progress-call");
  });

  it.each(["history", "asOf", "epoch", "revision", "offset", "taskCorrelation"])("D53-BOUNDARY: 비계약 history selector %s 거부", selector => {
    const f = own(fixture());
    f.save(memory(OLD_A), "a"); f.save(memory(NEW_B), "b");
    const before = domainRows(f.databasePath);
    for (const call of [f.service.loadContext.bind(f.service), f.service.inspectContext.bind(f.service)]) {
      const result = call({ schemaVersion: "1.0.0", [selector]: selector === "history" ? true : 1 }, f.caller);
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(JSON.stringify(result)).not.toContain(OLD_A);
    }
    expect(domainRows(f.databasePath)).toEqual(before);
  });

  it("D53-FORK: 검증된 부모 current만 채택하고 advanced history와 이미 채워진 자식은 거부", () => {
    const f = own(fixture("owned-parent")), ids = ["owned-parent-anchor"], at = [Date.parse(OLD)];
    const parentCaller = { ...f.caller, readLineage: () => ({ ids, at }) };
    const parent = direct(f.service.checkpointContext({ schemaVersion: "1.0.0", requestId: "parent-a",
      expectedStateToken: f.current().stateToken, ...memory(OLD_A) }, parentCaller).data);
    const child = (session: string) => {
      f.service.startFork(session, undefined, () => ({ parentSessionId: f.session }));
      const caller = rootCaller("synthetic-d53-host", session, { readLineage: () => ({ ids, at }) });
      const candidate = f.service.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
      expect(candidate.reasonCodes).toContain("FORK_PARENT_CANDIDATE");
      expect(candidate.restoreToken).toEqual(expect.any(String));
      return { caller, candidate };
    };
    const first = child("owned-child-first"), stale = child("owned-child-stale");
    const loaded = f.service.loadContext({ schemaVersion: "1.0.0", candidateToken: first.candidate.restoreToken! }, first.caller);
    expect(loaded.ok).toBe(true);
    const adopted = direct(loaded.data);
    expect(adopted.memory).toEqual(parent.memory);
    expect(adopted.taskCorrelation).not.toBe(parent.taskCorrelation);
    expect(adopted.stateToken).not.toBe(parent.stateToken);
    const savedChild = f.service.checkpointContext({ schemaVersion: "1.0.0", requestId: "child-own",
      expectedStateToken: adopted.stateToken, ...memory("CHILD_OWN") }, first.caller);
    expect(savedChild.ok).toBe(true);
    expect(f.service.loadContext({ schemaVersion: "1.0.0", candidateToken: first.candidate.restoreToken! }, first.caller).ok).toBe(false);
    expect(direct(f.service.loadContext({ schemaVersion: "1.0.0" }, first.caller).data).memory).toEqual(memory("CHILD_OWN"));
    expect(f.save(memory(NEW_B), "parent-b").ok).toBe(true);
    const rejected = f.service.loadContext({ schemaVersion: "1.0.0", candidateToken: stale.candidate.restoreToken! }, stale.caller);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(OLD_A);
    expect(f.service.inspectContext({ schemaVersion: "1.0.0" }, stale.caller).data?.reasonCodes).toContain("FORK_PARENT_ADVANCED");
    expect(f.store.getCurrent(f.service.correlateSession(stale.caller.sessionId))?.memory).toBeNull();
    expect(histories(f.databasePath).some(row => row.state_token === parent.stateToken)).toBe(true);
  });

  it("D53-CLEANUP: preview/receipt의 history 비노출, active 보호와 stale plan 재검사", () => {
    const f = own(fixture()), workflow = own(new SqliteWorkflowStore(join(f.directory, "workflow.sqlite3")));
    f.setNow(OLD);
    expect(f.save(memory(OLD_A), "old-a").ok).toBe(true);
    expect(f.save(memory(NEW_B), "old-b").ok).toBe(true);
    // Expired payload in a retained task: exercise payload cleanup, not whole-task retention.
    sql(f.databasePath, db => db.prepare("UPDATE continuity_tasks SET updated_at=?").run(NOW));
    const cleanup = new StateCleanupService(workflow, f.store, new ContractValidator(), () => new Date(NOW));
    const preview = cleanup.prepare({ schemaVersion: "1.0.0" });
    expect(preview.ok).toBe(true);
    // Public cleanup exposes the sole current candidate, never archived rows/selectors/counts.
    expect(preview.data!.counts.continuitySnapshots).toBe(1);
    expect(preview.data!.candidates.continuitySnapshots).toHaveLength(1);
    expect(preview.data!.candidates.continuitySnapshots[0]).toMatchObject({ stateToken: f.current().stateToken });
    expect(histories(f.databasePath)).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain(OLD_A);
    f.setNow(NOW);
    expect(f.save({ ...memory("ACTIVE_CURRENT"), status: "active" }, "active").ok).toBe(true);
    const before = domainRows(f.databasePath);
    const rejected = cleanup.execute({ schemaVersion: "1.0.0", planToken: preview.data!.planToken });
    expect(rejected).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    expect(JSON.stringify(rejected)).not.toContain(OLD_A);
    expect(domainRows(f.databasePath)).toEqual(before);
    const active = cleanup.prepare({ schemaVersion: "1.0.0" });
    expect(active.ok).toBe(true);
    expect(active.data!.counts.continuitySnapshots).toBe(0);
    expect(active.data!.counts.continuityTasks).toBe(0);
    const receipt = cleanup.execute({ schemaVersion: "1.0.0", planToken: active.data!.planToken });
    expect(receipt.ok).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(OLD_A);
    expect(domainRows(f.databasePath)).toEqual(before);
  });
});

describe("D53 schema2/3 손실 없는 이관", () => {
  it.each([2, 3] as const)("D53-MIGRATION schema%i: 작은 현재와 모든 legacy 원문을 보존하고 재open 중복 없음", version => {
    const f = own(legacyFixture(version, memory(NEW_B)));
    const store = own(new SqliteContinuityStore(f.databasePath));
    expect(sql(f.databasePath, db => db.prepare("PRAGMA user_version").get())).toEqual({ user_version: 4 });
    expect(store.getCurrent(f.task)).toMatchObject({ epoch: 2, memory: memory(NEW_B) });
    expect(store.getCurrent(f.task, 1)).toBeNull();
    const history = histories(f.databasePath);
    expect(history).toHaveLength(2);
    expect(history.map(row => row.memory_json)).toEqual(f.originals);
    expect(history.every(row => row.format === "legacy-snapshot-v1")).toBe(true);
    const before = domainRows(f.databasePath);
    const reopened = own(new SqliteContinuityStore(f.databasePath));
    expect(reopened.getCurrent(f.task)?.memory).toEqual(memory(NEW_B));
    expect(domainRows(f.databasePath)).toEqual(before);
  });

  it.each([2, 3] as const)("D53-MIGRATION schema%i: oversize mapping 누락/불일치는 원문·schema·복구파일 불변", version => {
    const f = own(legacyFixture(version, sizedMemory(2400, "objective"))), before = legacyRows(f.databasePath);
    const recovery = readFileSync(f.recoveryPath);
    for (const mappings of [[], [{ taskCorrelation: f.task, expectedSnapshotDigest: `sha256:${"0".repeat(64)}`, memory: memory(NEW_B) }]]) {
      expect(() => new SqliteContinuityStore(f.databasePath, mappings)).toThrowError(expect.objectContaining({ reason: "MIGRATION_INCOMPLETE" }));
      expect(legacyRows(f.databasePath)).toEqual(before);
      expect(readFileSync(f.recoveryPath)).toEqual(recovery);
    }
    const optimized = memory("최신 교정: 운영 변경 금지; 목표와 남은 검증을 보존한다");
    const store = own(new SqliteContinuityStore(f.databasePath, [{ taskCorrelation: f.task,
      expectedSnapshotDigest: f.current.snapshotDigest, memory: optimized }]));
    expect(store.getCurrent(f.task)?.memory).toEqual(optimized);
    expect(bytes(store.getCurrent(f.task)!.memory!)).toBeLessThanOrEqual(2000);
    expect(histories(f.databasePath).map(row => row.memory_json)).toEqual(f.originals);
    expect(readFileSync(f.recoveryPath)).toEqual(recovery);
  });

  it("D53-MIGRATION: archive 뒤 receipt 변환 오류는 DDL/current/history까지 rollback하고 원문으로 재시도 가능", () => {
    const f = own(legacyFixture(2, sizedMemory(2400, "objective")));
    sql(f.databasePath, db => db.exec("CREATE TRIGGER d53_migration_fault BEFORE UPDATE ON continuity_requests BEGIN SELECT RAISE(ABORT,'owned migration interruption'); END"));
    const before = legacyRows(f.databasePath), recovery = readFileSync(f.recoveryPath);
    const mapping = [{ taskCorrelation: f.task, expectedSnapshotDigest: f.current.snapshotDigest, memory: memory(NEW_B) }];
    expect(() => new SqliteContinuityStore(f.databasePath, mapping)).toThrow();
    expect(legacyRows(f.databasePath)).toEqual(before);
    expect(readFileSync(f.recoveryPath)).toEqual(recovery);
    sql(f.databasePath, db => db.exec("DROP TRIGGER d53_migration_fault"));
    const store = own(new SqliteContinuityStore(f.databasePath, mapping));
    expect(store.getCurrent(f.task)?.memory).toEqual(memory(NEW_B));
    expect(histories(f.databasePath).map(row => row.memory_json)).toEqual(f.originals);
  });

  it("D53-MIGRATION schema3 receiver: origin snapshot을 current로 되돌려 노출하지 않는다", () => {
    const f = own(legacyFixture(3, memory(OLD_A), true));
    const store = own(new SqliteContinuityStore(f.databasePath));
    const service = new ContinuityService(store, new ContractValidator());
    expect(() => store.getTask(f.task)).toThrowError(expect.objectContaining({ reason: "RECEIVER_STATE_UNSUPPORTED" }));
    expect(histories(f.databasePath).map(row => row.memory_json)).toEqual(f.originals);
    expect(JSON.stringify(service.loadContext({ schemaVersion: "1.0.0" }, rootCaller("synthetic-d53-host", "unrelated-owned-session"))))
      .not.toContain(OLD_A);
  });
});
