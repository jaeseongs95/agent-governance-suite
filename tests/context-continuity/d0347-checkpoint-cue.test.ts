import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../contracts/types.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { wakeMessage } from "../../mcp-server/src/session-message-client.js";

const stores = new Set<SqliteContinuityStore>();
const directories: string[] = [];
const hosts = ["codex", "claude-code"] as const;
const session = "d0347-owned-session";
const now = () => new Date("2026-11-01T02:00:00.000Z");

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function createService(databasePath = ":memory:") {
  const store = new SqliteContinuityStore(databasePath);
  stores.add(store);
  return new ContinuityService(store, new ContractValidator(), null, now);
}

function bound<T extends Record<string, unknown>>(service: ContinuityService, taskSession: string, tool: string, input: T) {
  return { ...input, _continuityBinding: service.issueToolBinding(taskSession, tool, input) };
}

// 수동 시험 자료이며 모델의 자동 저장 동작에 대한 증거가 아니다.
function checkpoint(service: ContinuityService, taskSession = session): ContinuitySnapshotV1 {
  const input: Omit<CheckpointContextRequestV1, "_continuityBinding"> = {
    schemaVersion: "1.0.0", requestId: `d0347-checkpoint-${taskSession}`, expectedRevision: 0, status: "active",
    core: {
      objective: `기존 목표 표식 ${taskSession}`,
      completionCriteria: ["기존 완료 기준 표식"], constraints: ["기존 제약 표식"],
      decisions: ["기존 교정 표식"], progress: ["기존 완료 작업 표식"], blockers: [], nextActions: ["기존 후보 행동 표식"],
    },
    evidenceRefs: [],
  };
  const result = service.checkpointContext(input, asRoot(taskSession));
  expect(result.ok).toBe(true);
  return result.data!;
}

function prompt(service: ContinuityService, host: string, extra: Record<string, unknown> = {}) {
  return handleContinuityHook({ hook_event_name: "UserPromptSubmit", session_id: session,
    prompt: "새 교정 표식: 다음 판단 전에 검증 근거를 보존하라.", ...extra }, service, host);
}

function compact(service: ContinuityService, host: string) {
  return handleContinuityHook({ hook_event_name: "SessionStart", source: "compact", session_id: session }, service, host);
}

function context(output: Record<string, unknown>, event: string): string {
  expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: event, additionalContext: expect.any(String) } });
  return (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
}

function expectCheckpointCue(text: string) {
  expect(text).toContain("[Task continuity checkpoint check]");
  for (const tool of ["checkpoint_context", "inspect_context", "load_context"]) expect(text).toContain(tool);
  for (const forged of ["decision=DEFER", "decision=INJECT", "candidateToken=", "restoreToken", "_continuityBinding"])
    expect(text).not.toContain(forged);
}

function suppress(service: ContinuityService) {
  expect(service.suppressContextRestore({
    schemaVersion: "1.0.0", expectedEpoch: 1,
  }, asRoot(session)).data?.suppressed).toBe(true);
}

function purge(service: ContinuityService, snapshot: ContinuitySnapshotV1) {
  expect(service.purgeDirectContext({
    schemaVersion: "1.0.0", requestId: "d0347-owned-purge", expectedEpoch: snapshot.epoch, expectedRevision: snapshot.revision,
  }, asRoot(session)).data?.purged).toBe(true);
}

describe("D0347 문맥을 보유한 입력 경계의 저장 유도", () => {
  it.each(hosts)("%s의 첫 사용자 입력은 저장을 유도하되 스냅샷을 만들지 않는다", host => {
    const service = createService();
    const write = vi.spyOn(service.store, "checkpoint");
    const text = context(prompt(service, host), "UserPromptSubmit");
    expectCheckpointCue(text);
    expect(text).not.toContain("새 교정 표식");
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(hosts)("%s는 기존 저장본이 있어도 교정 저장을 유도하고 기존 본문을 노출·갱신하지 않는다", host => {
    const service = createService(), saved = checkpoint(service);
    const before = service.store.getTask(saved.taskCorrelation);
    const write = vi.spyOn(service.store, "checkpoint");
    const text = context(prompt(service, host), "UserPromptSubmit");
    expectCheckpointCue(text);
    for (const value of [saved.core.objective, ...saved.core.constraints, ...saved.core.decisions, ...saved.core.nextActions])
      expect(text).not.toContain(value);
    expect(service.store.getSnapshot(saved.taskCorrelation, saved.epoch)).toEqual(saved);
    expect(service.store.getTask(saved.taskCorrelation)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(hosts)("%s compact는 사전 저장본 부재만 알리고 실제 복원 후보를 꾸미지 않는다", host => {
    const service = createService();
    handleContinuityHook({ hook_event_name: "PreCompact", session_id: session }, service, host);
    const text = context(compact(service, host), "SessionStart");
    expectCheckpointCue(text);
    expect(text).toContain("사전 저장본 없음");
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toBeNull();

    const saved = checkpoint(service);
    // 저장본은 있지만 pre-compact marker가 없으면 기존 계약대로 후보를 새로 발급하지 않는다.
    expect(compact(service, host)).toEqual({});
    expect(service.store.getSnapshot(saved.taskCorrelation, saved.epoch)).toEqual(saved);
  });

  it("workflow root에 결속되면 투영 자료가 없어도 직접 저장을 유도하지 않는다", () => {
    const service = createService(), task = service.ensureSession(session);
    expect(service.store.bindRoot(task.taskCorrelation, task.currentEpoch, "d0347-owned-workflow-root", now().toISOString())).toBe(true);
    const before = service.store.getTask(task.taskCorrelation);
    for (const host of hosts) {
      expect(prompt(service, host)).toEqual({});
      expect(compact(service, host)).toEqual({});
    }
    expect(service.store.getTask(task.taskCorrelation)).toEqual(before);
    expect(service.store.getSnapshot(task.taskCorrelation, task.currentEpoch)).toBeNull();
  });

  it.each(["suppress", "purge"] as const)("사용자의 %s 뒤에는 저장 유도로 선택을 우회하지 않는다", change => {
    const service = createService(), saved = checkpoint(service);
    if (change === "suppress") suppress(service);
    else purge(service, saved);
    const before = service.store.getTask(saved.taskCorrelation);
    const tombstone = service.store.getTombstone(saved.taskCorrelation, saved.epoch);
    const write = vi.spyOn(service.store, "checkpoint");
    for (const host of hosts) {
      expect(prompt(service, host)).toEqual({});
      expect(compact(service, host)).toEqual({});
    }
    expect(service.store.getTask(saved.taskCorrelation)).toEqual(before);
    expect(service.store.getTombstone(saved.taskCorrelation, saved.epoch)).toEqual(tombstone);
    expect(service.store.getSnapshot(saved.taskCorrelation, saved.epoch)).toEqual(change === "purge" ? null : saved);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(hosts)("%s의 하위·잘못된 actor 표시는 저장 권한이나 안내를 만들지 않는다", host => {
    const service = createService();
    for (const agent_id of ["owned-child", "", null, 42]) {
      expect(prompt(service, host, { agent_id })).toEqual({});
      expect(handleContinuityHook({ hook_event_name: "SessionStart", source: "compact", session_id: session, agent_id }, service, host)).toEqual({});
    }
    expect(prompt(service, host, { session_id: " " })).toEqual({});
    expect(handleContinuityHook({ hook_event_name: "UnknownEvent", session_id: session }, service, host)).toEqual({});
    expect(service.store.getTask(service.correlateSession(session))).toBeNull();
  });

  it("관측할 수 없는 native actor에는 저장을 유도하지 않는다", () => {
    const service = createService();
    expect(prompt(service, "gemini")).toEqual({});
    expect(compact(service, "gemini")).toEqual({});
    expect(service.store.getTask(service.correlateSession(session))).toBeNull();
  });

  it.each(hosts)("%s는 marker뿐인 깨우기를 건너뛰고 실제 사용자 교정이 섞인 입력은 보존한다", host => {
    const service = createService(), marker = wakeMessage("d0347_owned_wake_nonce_0001");
    expect(prompt(service, host, { prompt: ` \n${marker}\n ` })).toEqual({});
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toBeNull();
    expectCheckpointCue(context(prompt(service, host, { prompt: `${marker}\n새 사용자 교정` }), "UserPromptSubmit"));
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toBeNull();
  });
});

describe("D0347 저장 유도의 현재 세대 재검증", () => {
  it.each((["checkpointCueForSession", "compactContext"] as const).flatMap(operation =>
    (["clear", "suppress", "purge"] as const).map(change => ({ operation, change }))))("$operation / $change: 메타데이터 읽기 뒤 커밋되면 과거 권한으로 안내·스냅샷을 만들지 않는다", async ({ operation, change }) => {
    const directory = await mkdtemp(join(tmpdir(), "d0347-cue-race-"));
    directories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const first = createService(databasePath), second = createService(databasePath);
    const saved = checkpoint(first), parent = checkpoint(first, "d0347-owned-parent");
    const parentTask = second.store.getTask(parent.taskCorrelation);
    const original = first.store.ensureTask.bind(first.store);
    let changed = false;
    vi.spyOn(first.store, "ensureTask").mockImplementationOnce((...args) => {
      const stale = original(...args);
      if (change === "clear") second.clearSession(session);
      else if (change === "suppress") suppress(second);
      else purge(second, saved);
      changed = true;
      return stale;
    });
    const write = vi.spyOn(first.store, "checkpoint");
    expect(first[operation](session)).toBeNull();
    expect(changed).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(second.store.getTask(saved.taskCorrelation)).toMatchObject({ currentEpoch: change === "clear" ? 2 : 1,
      suppressed: change === "suppress" });
    expect(second.store.getSnapshot(saved.taskCorrelation, 1)).toEqual(change === "purge" ? null : saved);
    expect(second.store.getSnapshot(saved.taskCorrelation, 2)).toBeNull();
    expect(second.store.getTask(parent.taskCorrelation)).toEqual(parentTask);
    expect(second.store.getSnapshot(parent.taskCorrelation, parent.epoch)).toEqual(parent);
    if (change === "purge") expect(second.store.getTombstone(saved.taskCorrelation, 1)?.revision).toBe(saved.revision);
  });

  it("명시적 표준 저장 뒤 새 연결의 정확 후보로만 본문을 읽는다: 자동 모델 저장 증거는 아니다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d0347-cue-load-"));
    directories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3"), first = createService(databasePath);
    expectCheckpointCue(context(prompt(first, "codex"), "UserPromptSubmit"));
    const saved = checkpoint(first);
    first.store.close();
    const reopened = createService(databasePath);
    const candidate = reopened.inspectContext({ schemaVersion: "1.0.0" }, asRoot(session)).data!;
    expect(candidate).toMatchObject({ decision: "DEFER", summary: { epoch: saved.epoch, revision: saved.revision, snapshotDigest: saved.snapshotDigest } });
    expect(JSON.stringify(candidate)).not.toContain(saved.core.objective);
    const loaded = reopened.loadContext({
      schemaVersion: "1.0.0", candidateToken: candidate.restoreToken!,
      epoch: candidate.summary!.epoch, revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest,
    }, asRoot(session));
    expect(loaded.data).toEqual(saved);
  });
});
