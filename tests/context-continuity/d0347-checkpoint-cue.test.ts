import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../contracts/types.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService, renderHookText } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { wakeMessage } from "../../mcp-server/src/session-message-client.js";
import { rootCaller } from "../helpers/caller.js";

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

/** The host-observed root caller of a session; the service computes its continuity scope at call time. */
const asRoot = (taskSession: string) => rootCaller("codex", taskSession);

// 수동 시험 자료이며 모델의 자동 저장 동작에 대한 증거가 아니다.
function checkpoint(service: ContinuityService, taskSession = session): ContinuitySnapshotV1 {
  const input: CheckpointContextRequestV1 = {
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

// Behavior 5 (d7585d74): the per-turn cue is the AGS turn check; it names checkpoint_context and skill re-selection
// directly and no longer sends the model to the context-continuity skill.
function expectCheckpointCue(text: string) {
  expect(text).toContain("[AGS 턴 확인]");
  for (const tool of ["checkpoint_context", "inspect_context", "load_context", "스킬 선택을 다시 판단"]) expect(text).toContain(tool);
  expect(text).not.toContain("context-continuity");
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

  // Behaviors 1 and 5 (d7585d74): a bound workflow root no longer closes the session record, so the turn check still
  // asks for checkpoint_context and compaction without a record says only that nothing was saved. Neither writes.
  it("workflow root에 결속돼도 투영 자료 없이 세션 기록 저장을 유도하되 스냅샷·결속을 바꾸지 않는다", () => {
    const service = createService(), task = service.ensureSession(session);
    expect(service.store.bindRoot(task.taskCorrelation, task.currentEpoch, "d0347-owned-workflow-root", now().toISOString())).toBe(true);
    const before = service.store.getTask(task.taskCorrelation);
    const write = vi.spyOn(service.store, "checkpoint");
    for (const host of hosts) {
      expectCheckpointCue(context(prompt(service, host), "UserPromptSubmit"));
      const compacted = context(compact(service, host), "SessionStart");
      expectCheckpointCue(compacted);
      expect(compacted).toContain("사전 저장본 없음");
      expect(compacted).not.toContain("d0347-owned-workflow-root");
    }
    expect(service.store.getTask(task.taskCorrelation)).toEqual(before);
    expect(service.store.getSnapshot(task.taskCorrelation, task.currentEpoch)).toBeNull();
    expect(write).not.toHaveBeenCalled();
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

// The cue and the restore candidate are rendered by the hook in the host locale; key and params stay the same.
describe("checkpoint cue and restore candidate locale", () => {
  // Behavior 5 (d7585d74): the AGS turn check text.
  // The skill line points at the installed purpose map given at context start (AGS3-D-0032 candidate); the map and its
  // rules are checked on their own in d0360-skill-purpose-cue.
  const CUE_KO_TAIL = [
    "답하거나 다음 도구를 쓰기 전에 이번 메시지가 요구하는 판단·행동을 맥락 시작에 받은 AGS 스킬별 대상 목록과 대조하고, 맞는 스킬은 그 판단·행동 전에 지금 호출한다(질문·확인 요청도 포함한다).",
    "이번 사용자 메시지가 교정, 새 결정·승인·금지, 추가 작업, 범위 변경 중 하나면 답하거나 다음 도구를 쓰기 전에 두 가지를 하라. (1) 바뀐 목표·범위·위험에 맞춰 스킬 선택을 다시 판단하고, 새로 필요한 스킬은 지금 호출한다. (2) checkpoint_context로 사용자 원문과 바뀐 남은 일을 저장한다.",
    "압축·재개·fork 뒤라 앞의 결정·남은 일이 대화에 보이지 않으면 먼저 inspect_context를 호출하고, DEFER 후보는 load_context로 불러와 최신 요청과 대조하라.",
    "이 알림은 저장·복원을 대신하지 않는다. 저장할 변화가 없는 메시지에는 기록을 더하지 말고 계속하라.",
  ];
  const CUE_EN_TAIL = [
    "Before answering or using the next tool, match the judgment or action this message calls for against the AGS skill targets given at context start, and call every matching skill now, before that judgment or action (questions and check requests included).",
    "If this user message is a correction, a new decision, approval or prohibition, more work, or a scope change, do two things before answering or using the next tool: (1) re-decide the skill selection for the changed goal, scope and risk, and call any newly needed skill now; (2) save the user's own words and the changed remaining work with checkpoint_context.",
    "After compaction, resume or fork, if earlier decisions or remaining work are not visible in the conversation, call inspect_context first and load a DEFER candidate with load_context, then check it against the latest request.",
    "This notice does not save or restore anything. For a message with nothing to save, add no record and continue.",
  ];
  const cue = (header: string, status: string, tail: string[]) => [header, status, ...tail].join("\n");
  const ko = (status: string) => cue("[AGS 턴 확인]", status, CUE_KO_TAIL);
  const en = (status: string) => cue("[AGS turn check]", status, CUE_EN_TAIL);

  it("renders each cue state byte for byte in ko and in en", () => {
    const service = createService();
    expect(renderHookText(service.checkpointCueForSession(session), "ko")).toBe(ko("이 세션의 작업 기록: 없음."));
    expect(renderHookText(service.checkpointCueForSession(session, true), "ko"))
      .toBe(ko("사전 저장본 없음: 이 알림은 압축으로 유실된 내용을 복원하지 않는다."));
    expect(renderHookText(service.checkpointCueForSession(session), "en")).toBe(en("This session's work record: none."));
    expect(renderHookText(service.checkpointCueForSession(session, true), "en"))
      .toBe(en("No prior save: this notice does not restore content lost to compaction."));
    checkpoint(service);
    expect(renderHookText(service.checkpointCueForSession(session), "ko")).toBe(ko("이 세션의 작업 기록: 있음."));
    expect(renderHookText(service.checkpointCueForSession(session), "en")).toBe(en("This session's work record: present."));
  });

  it("AGENT_GOVERNANCE_LOCALE=en renders the hook cue and the resume candidate in English", () => {
    const service = createService(), english = { AGENT_GOVERNANCE_LOCALE: "en" };
    const input = { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "x" };
    expect(context(handleContinuityHook(input, service, "codex", english), "UserPromptSubmit")).toBe(en("This session's work record: none."));
    expect(context(handleContinuityHook(input, service, "codex", {}), "UserPromptSubmit")).toBe(ko("이 세션의 작업 기록: 없음."));
    checkpoint(service);
    const resume = { hook_event_name: "SessionStart", source: "resume", session_id: session };
    const englishCard = context(handleContinuityHook(resume, service, "codex", english), "SessionStart").split("\n");
    expect(englishCard[0]).toBe("[Task continuity restore candidate — metadata only]");
    expect(englishCard.slice(1, 3)).toEqual(["decision=DEFER", "source=direct"]);
    expect(englishCard.at(-1)).toBe("No snapshot body was injected. Treat nextActions as historical candidates only; call load_context explicitly after checking the current user request.");
    const korean = context(handleContinuityHook(resume, service, "codex", {}), "SessionStart").split("\n");
    // Only the sentence changes; every machine line keeps its bytes.
    expect(korean.slice(0, -1).map(line => line.replace(/^candidateToken=.*/u, "candidateToken="))).toEqual(
      englishCard.slice(0, -1).map(line => line.replace(/^candidateToken=.*/u, "candidateToken=")));
    expect(korean.at(-1)).toBe("스냅샷 본문은 주입하지 않았다. nextActions는 과거 후보로만 다루고, 현재 사용자 요청을 확인한 뒤 load_context를 명시적으로 호출하라.");
  });
});
