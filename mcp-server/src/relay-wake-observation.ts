import {randomUUID} from "node:crypto";
import {lstatSync, renameSync} from "node:fs";
import path from "node:path";
import {readDiagnosticConfig} from "./diagnostics.js";
import {processStartToken} from "./process-identity.js";
import {transportWakePort, writeRelayDiagnosticSnapshot, type WakeDispatchPort} from "./session-message-wake-port.js";

type WakeEvent = "begin" | "none-skip" | "dispatch-attempt" | "native-launch-attempt" | "native-spawn" | "end";

function observationPrefix(transport: string, environment: NodeJS.ProcessEnv): string | undefined {
  const config = readDiagnosticConfig(environment.AGENT_GOVERNANCE_LOG_CONFIG);
  if (config.destination !== "file" || !config.file || !path.isAbsolute(config.file)
    || !["TRACE", "DEBUG"].includes(config.categories?.transport ?? config.level)) return undefined;
  transportWakePort(transport); // Only installed transport identifiers may leave this boundary.
  const directory = lstatSync(path.dirname(config.file));
  return directory.isDirectory() && !directory.isSymbolicLink()
    && (!process.getuid || directory.uid === process.getuid()) ? config.file : undefined;
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

/** Parent-side expectation only; its own coverage must be matched to the native hook/process census. */
export function createRelaySpawnObservation(transport: string, environment = process.env) {
  try {
    const prefix = observationPrefix(transport, environment);
    if (!prefix) return undefined;
    const generation = randomUUID(), writerPid = process.pid;
    const writerProcessStart = processStartToken(writerPid, process.platform, 500) ?? "UNKNOWN";
    const file = `${prefix}-relay-spawn-${generation}.json`, startedAt = new Date().toISOString();
    const events: {seq: number; event: "begin" | "returned" | "spawn" | "error" | "throw"}[] = [];
    let childPid: number | "UNKNOWN" = "UNKNOWN", childProcessStart = "UNKNOWN";
    let sinkErrors = 0, droppedEvents = 0;
    const record = (event: typeof events[number]["event"], pid?: number) => {
      try {
        if (event === "returned" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) childPid = pid;
        if ((event === "returned" || event === "spawn") && typeof childPid === "number" && childProcessStart === "UNKNOWN") {
          childProcessStart = processStartToken(childPid, process.platform, 500) ?? "UNKNOWN";
        }
        if (events.length >= 8) {droppedEvents++; return;}
        events.push({seq: events.length + 1, event});
        if (!publishSnapshot(file, {schemaVersion: "1.0.0", kind: "relay-spawn-observation", generation,
          writerPid, writerProcessStart, startedAt, selectedTransport: transport, childPid, childProcessStart,
          events, sinkErrors, droppedEvents})) throw new Error("DIAGNOSTIC_WRITE_FAILED");
      } catch { sinkErrors++; }
    };
    record("begin");
    return {returned(pid?: number) {record("returned", pid);}, spawned() {record("spawn");},
      failed() {record("error");}, threw() {record("throw");}};
  } catch { return undefined; }
}
