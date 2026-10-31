import {randomUUID} from "node:crypto";
import {lstatSync, renameSync} from "node:fs";
import path from "node:path";
import {readDiagnosticConfig} from "./diagnostics.js";
import {processStartToken} from "./process-identity.js";
import {transportWakePort, writeRelayDiagnosticSnapshot, type WakeDispatchPort} from "./session-message-wake-port.js";

type WakeEvent = "begin" | "none-skip" | "dispatch-attempt" | "native-launch-attempt" | "native-spawn" | "end";

/** Environment-only opt-in check; no filesystem access. */
function observationFile(transport: string, environment: NodeJS.ProcessEnv): string | undefined {
  const config = readDiagnosticConfig(environment.AGENT_GOVERNANCE_LOG_CONFIG);
  if (config.destination !== "file" || !config.file || !path.isAbsolute(config.file)
    || !["TRACE", "DEBUG"].includes(config.categories?.transport ?? config.level)) return undefined;
  // 설치된 transport 식별자만 이 경계를 나간다. 미설치 transport는 관측 꺼짐이며 실패가 아니다.
  try { transportWakePort(transport); } catch { return undefined; }
  return config.file;
}

function ownedDirectory(file: string): boolean {
  const directory = lstatSync(path.dirname(file));
  return directory.isDirectory() && !directory.isSymbolicLink() && (!process.getuid || directory.uid === process.getuid());
}

function observationPrefix(transport: string, environment: NodeJS.ProcessEnv): string | undefined {
  const file = observationFile(transport, environment);
  return file && ownedDirectory(file) ? file : undefined;
}

function publishSnapshot(file: string, value: object): boolean {
  if (!writeRelayDiagnosticSnapshot(file + ".tmp", JSON.stringify(value))) return false;
  renameSync(file + ".tmp", file);
  return true;
}

/** Bounded, opt-in diagnostic only. Never a lease, delivery receipt or host acceptance proof. */
export function createRelayWakeObservation(transport: string, port: WakeDispatchPort, environment = process.env) {
  try {
    const prefix = observationPrefix(transport, environment);
    if (!prefix || transportWakePort(transport) !== port) return undefined;

    const generation = randomUUID();
    // OS creation metadata of this writer, never the parent's identity or any authority token.
    const processStart = processStartToken(process.pid, process.platform, 500);
    const file = `${prefix}-relay-${generation}.json`;
    const events: {seq: number; event: WakeEvent}[] = [];
    const counters = {noneSkips: 0, dispatchAttempts: 0, nativeLaunchAttempts: 0, nativeSpawns: 0};
    const startedAt = new Date().toISOString();
    let sinkErrors = 0, droppedEvents = 0, sequence = 0, ended = false, normalEnd = false;
    const increment = (key: keyof typeof counters) => {
      if (counters[key] < Number.MAX_SAFE_INTEGER) counters[key]++;
      else droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + 1);
    };
    const publish = () => {
      try {
        const snapshot = {schemaVersion: "1.0.0", kind: "relay-wake-observation",
          generation, pid: process.pid, processStart: processStart ?? "UNKNOWN", startedAt,
          selectedTransport: transport, idleWake: port.capabilities.idleWake,
          hostAcceptance: "UNKNOWN", events, counters: {...counters,
            nativeLaunchAttempts: port.observesNativeLaunch ? counters.nativeLaunchAttempts : "UNKNOWN",
            nativeSpawns: port.observesNativeLaunch ? counters.nativeSpawns : "UNKNOWN"},
          sinkErrors, droppedEvents, ended, normalEnd};
        // Publish only after the complete temporary snapshot was successfully closed.
        if (!publishSnapshot(file, snapshot)) throw new Error("DIAGNOSTIC_WRITE_FAILED");
      } catch { sinkErrors = Math.min(Number.MAX_SAFE_INTEGER, sinkErrors + 1); }
    };
    const record = (event: WakeEvent) => {
      try {
        if (ended) return;
        if (!["begin", "none-skip", "dispatch-attempt", "native-launch-attempt", "native-spawn", "end"].includes(event)) {
          droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + 1);
          return;
        }
        if (event === "none-skip") {increment("noneSkips"); if (counters.noneSkips > 1) return;}
        if (event === "dispatch-attempt") increment("dispatchAttempts");
        if (event === "native-launch-attempt") increment("nativeLaunchAttempts");
        if (event === "native-spawn") increment("nativeSpawns");
        if (event === "end") ended = true;
        // Reserve one slot and one final publication for end. Overflow permanently invalidates completeness.
        if (events.length < 31 || event === "end") events.push({seq: ++sequence, event});
        else {droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + 1); return;}
        publish();
      } catch { sinkErrors = Math.min(Number.MAX_SAFE_INTEGER, sinkErrors + 1); }
    };
    record("begin");
    return {record, end(complete: boolean) {normalEnd = complete; record("end");}};
  } catch { return undefined; } // Even identifier/OS metadata initialization cannot block the relay.
}
export type RelayWakeObservation = ReturnType<typeof createRelayWakeObservation>;

/**
 * 부모가 spawn 호출 직전부터 본 사건만 남긴다. 전체 생성 집합이나 자식 실행 성공을 증명하지 않는다.
 * deferred는 훅 예산 경로용이다. 신원 조회와 파일 접근 없이 메모리에만 쌓고 flush()에서 한 번 게시한다.
 */
export function createRelaySpawnObservation(transport: string, environment = process.env, deferred = false,
  onFailure?: (error: unknown) => void) {
  // 초기화·게시 실패는 호출자에게 보고하고 relay 시작은 막지 않는다. 관측 꺼짐(설정 없음)은 실패가 아니다.
  const fail = (error: unknown) => { try { onFailure?.(error); } catch { /* 보고 실패가 relay 시작을 막지 않는다. */ } };
  try {
    const prefix = observationFile(transport, environment);
    if (!prefix) return undefined;
    // 설정은 켜졌는데 소유 디렉터리가 아니면 꺼짐이 아니라 실패다. 예산 경로는 flush에서 확인한다.
    const requireOwnedDirectory = () => { if (!ownedDirectory(prefix)) throw new Error("DIAGNOSTIC_DIRECTORY_NOT_OWNED"); };
    if (!deferred) requireOwnedDirectory();
    const identity = (pid: number) => deferred ? "UNKNOWN" : processStartToken(pid, process.platform, 500) ?? "UNKNOWN";
    const generation = randomUUID(), writerPid = process.pid, writerProcessStart = identity(writerPid);
    const file = `${prefix}-relay-spawn-${generation}.json`, startedAt = new Date().toISOString();
    const events: {seq: number; event: "begin" | "returned" | "spawn" | "error"}[] = [];
    let childPid: number | "UNKNOWN" = "UNKNOWN", childProcessStart = "UNKNOWN";
    let sinkErrors = 0, droppedEvents = 0;
    const publish = () => {
      try {
        if (!publishSnapshot(file, {schemaVersion: "1.0.0", kind: "relay-spawn-observation", generation,
          writerPid, writerProcessStart, startedAt, publishedAt: new Date().toISOString(), selectedTransport: transport,
          childPid, childProcessStart, events, sinkErrors, droppedEvents})) throw new Error("DIAGNOSTIC_WRITE_FAILED");
      } catch (error) { sinkErrors++; fail(error); } // 게시 실패는 파일에 남지 못할 수 있으므로 호출자에게도 보고한다.
    };
    const record = (event: typeof events[number]["event"], pid?: number) => {
      try {
        if (event === "returned" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) childPid = pid;
        if ((event === "returned" || event === "spawn") && typeof childPid === "number" && childProcessStart === "UNKNOWN") {
          childProcessStart = identity(childPid);
        }
        if (events.length >= 8) {droppedEvents++; return;}
        events.push({seq: events.length + 1, event});
        if (!deferred) publish();
      } catch { sinkErrors++; }
    };
    record("begin");
    return {returned(pid?: number) {record("returned", pid);}, spawned() {record("spawn");}, failed() {record("error");},
      flush() {
        if (!deferred) return;
        try { requireOwnedDirectory(); } catch (error) { fail(error); return; } // 확인하지 못하면 게시하지 않는다.
        publish();
      }};
  } catch (error) { fail(error); return undefined; } // 초기화 실패는 관측 없음(UNKNOWN)으로 남기고 보고한다.
}
