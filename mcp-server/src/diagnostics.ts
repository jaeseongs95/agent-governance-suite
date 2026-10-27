import {fork} from "node:child_process";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {ERROR_CODE} from "../../contracts/types.js";
import {SESSION_PROOF_FIELD} from "./session-actor-proof.js";

export const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL", "OFF"] as const;
type Level = typeof LOG_LEVELS[number];
export interface DiagnosticOutcome {ok: boolean; errorCode?: unknown; reasonCode?: unknown; failedChecks?: unknown;}
type Category = "lifecycle" | "request" | "binding" | "transport";
export interface DiagnosticConfig {
  level: Level;
  categories?: Partial<Record<Category, Level>>;
  destination: "stderr" | "file";
  file?: string;
  format: "json";
  bufferBytes: number;
  rotationBytes: number;
  rotationIntervalMs: number;
  retainedFiles: number;
  flushDeadlineMs: number;
}
const defaults: DiagnosticConfig = {level: "OFF", destination: "stderr", format: "json", bufferBytes: 65536,
  rotationBytes: 1048576, rotationIntervalMs: 1000, retainedFiles: 3, flushDeadlineMs: 100};
const categories: Category[] = ["lifecycle", "request", "binding", "transport"];
const reasons = new Set(["LOG_CONFIG_INVALID","CALLER_SESSION_BINDING_REJECTED", "ROOT_HOOK_PROOF_REQUIRED", "ROOT_PROOF_VERIFICATION_FAILED",
  "ROOT_PROOF_KEY_INVALID", "ROOT_PROOF_TOO_LARGE", "ROOT_PROOF_FORMAT_INVALID", "ROOT_PROOF_SIGNATURE_INVALID",
  "ROOT_PROOF_PAYLOAD_INVALID", "ROOT_PROOF_SCOPE_OR_TIME_INVALID", "ROOT_PROOF_ALREADY_CONSUMED"]);
const checks = new Set(["shape", "actorInput", "issuedInFuture", "expired", "tool", "ttl", "inputDigest"]);
const codes = new Set<string>(ERROR_CODE);
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function readDiagnosticConfig(raw: string | undefined): DiagnosticConfig {
  if (!raw) return {...defaults};
  if (raw.length > 8192) throw new Error("INVALID_LOG_CONFIGURATION");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_LOG_CONFIGURATION");
  const value = record(parsed);
  if (Object.keys(value).some(key => ![...Object.keys(defaults), "categories", "file"].includes(key))
    || (value.categories !== undefined && (value.categories === null || typeof value.categories !== "object" || Array.isArray(value.categories)))) throw new Error("INVALID_LOG_CONFIGURATION");
  const config = {...defaults, ...value} as DiagnosticConfig;
  const level = (v: unknown) => typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
  if (!level(config.level) || !["stderr", "file"].includes(config.destination) || config.format !== "json"
    || (config.destination === "file" && (typeof config.file !== "string" || !config.file))
    || Object.entries(record(config.categories)).some(([k, v]) => !categories.includes(k as Category) || !level(v))) throw new Error("INVALID_LOG_CONFIGURATION");
  for (const [key, min, max] of [["bufferBytes", 1024, 1048576], ["rotationBytes", 1024, 1073741824],
    ["rotationIntervalMs", 100, 86400000], ["retainedFiles", 1, 100], ["flushDeadlineMs", 1, 1000]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error("INVALID_LOG_CONFIGURATION");
  }
  return config;
}

export async function createDiagnostics(config: DiagnosticConfig, registeredMethods: ReadonlySet<string>) {
  const instance = randomUUID();
  const loss = {droppedRecords: 0, droppedBytes: 0, unconfirmedRecords: 0, unconfirmedBytes: 0, sinkErrors: 0, shutdownLossPossible: false};
  const priorities = {TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 50, FATAL: 60, OFF: Infinity};
  const enabled = (category: Category, level: Exclude<Level, "OFF">) => priorities[level] >= priorities[config.categories?.[category] ?? config.level];
  const active = config.level !== "OFF" || Object.values(config.categories ?? {}).some(level => level !== "OFF");
  const pending = new Map<number, number>();
  let pendingBytes = 0, sequence = 0, unavailable = false, closed = false, flushed = false;
  const accountUnconfirmed = () => {
    loss.unconfirmedRecords += pending.size; loss.unconfirmedBytes += pendingBytes;
    pending.clear(); pendingBytes = 0;
  };
  let resolveReady: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>(resolve => {resolveReady = resolve;});
  let child: ReturnType<typeof fork> | undefined;
  if (active) {
    try {
      const source = import.meta.url.endsWith(".ts");
      child = fork(fileURLToPath(new URL(source ? "./diagnostics-worker.ts" : "./diagnostics-worker.mjs", import.meta.url)), [], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        serialization: "json",
      });
      child.on("message", (message: unknown) => {
        const response = record(message);
        if (response.ready === true) resolveReady(true);
        if (response.flushed === true) flushed = true;
        if (typeof response.ack === "number") {const bytes = pending.get(response.ack); if (bytes !== undefined) {pending.delete(response.ack); pendingBytes -= bytes;}}
        if (typeof response.droppedRecords === "number") loss.droppedRecords += response.droppedRecords;
        if (typeof response.droppedBytes === "number") loss.droppedBytes += response.droppedBytes;
        if (response.failed === true) {loss.sinkErrors++; unavailable = true; resolveReady(false);}
      });
      const failed = () => {
        resolveReady(false);
        if (!closed || !flushed || pending.size > 0) {unavailable = true; loss.sinkErrors++; loss.shutdownLossPossible = true; accountUnconfirmed();}
      };
      child.on("error", failed); child.on("exit", failed);
      child.send({config, instance}, error => {if (error) failed();});
      child.unref(); child.channel?.unref();
    } catch {loss.sinkErrors++; unavailable = true; resolveReady(false);}
  } else resolveReady(true);
  function event(category: Category, level: Exclude<Level, "OFF">, event: "startup" | "connected" | "configuration_invalid" | "startup_failed" | "request_start" | "request_end" | "binding_check" | "shutdown_start", fields: Record<string, unknown> = {}) {
    // No arbitrary context object crosses this allowlist, even at TRACE.
    if (!enabled(category, level) || closed) return;
    const safe: Record<string, unknown> = {event, ...loss};
    if (typeof fields.correlation === "string" && /^[a-f0-9-]{36}$/.test(fields.correlation)) safe.correlation = fields.correlation;
    if (typeof fields.method === "string") safe.method = registeredMethods.has(fields.method) ? fields.method : "UNKNOWN";
    if (typeof fields.elapsedMs === "number" && Number.isFinite(fields.elapsedMs)) safe.elapsedMs = Math.max(0, fields.elapsedMs);
    if (["success", "rejected", "thrown", "UNKNOWN"].includes(String(fields.outcome))) safe.outcome = fields.outcome;
    if (typeof fields.errorCode === "string") safe.errorCode = codes.has(fields.errorCode) ? fields.errorCode : "UNKNOWN";
    if (typeof fields.reasonCode === "string") safe.reasonCode = reasons.has(fields.reasonCode) ? fields.reasonCode : "UNKNOWN";
    if (Array.isArray(fields.failedChecks)) safe.failedChecks = fields.failedChecks.filter(v => typeof v === "string" && checks.has(v));
    for (const key of ["proofPresent", "bindingPresent", "verified"] as const) if (typeof fields[key] === "boolean") safe[key] = fields[key];
    if (typeof fields.buildVersion === "string" && /^[a-zA-Z0-9.+-]{1,64}$/.test(fields.buildVersion)) safe.buildVersion = fields.buildVersion;
    if (typeof fields.runtimePath === "string" && fields.runtimePath.startsWith("file:")) safe.runtimePath = fields.runtimePath;
    if (typeof fields.runtimeHash === "string" && /^[a-f0-9]{64}$/.test(fields.runtimeHash)) safe.runtimeHash = fields.runtimeHash;
    // Hook startup and host updatedInput are outside the server's observation boundary.
    safe.hookDelivery = "UNKNOWN";
    safe.updatedInputApplied = "UNKNOWN";
    const bytes = Buffer.byteLength(JSON.stringify(safe)) + 128;
    if (!child || unavailable || pendingBytes + bytes > config.bufferBytes) {loss.droppedRecords++; loss.droppedBytes += bytes; return;}
    const id = ++sequence;
    pending.set(id, bytes); pendingBytes += bytes;
    try {child.send({id, category, level, fields: safe}, error => {if (error) {unavailable = true; loss.sinkErrors++;}});}
    catch {unavailable = true; loss.sinkErrors++;}

  }
  return {
    event,
    loss,
    ready,
    registerMethods(methods: string[]) { for (const method of methods) (registeredMethods as Set<string>).add(method); },
    async observe<T>(method: string, args: unknown, call: (correlation?: string) => Promise<T>, outcome?: () => DiagnosticOutcome | undefined): Promise<T> {
      const correlation = randomUUID(), started = performance.now();
      event("request", "DEBUG", "request_start", {method, correlation});
      const input = record(args);
      event("binding", "DEBUG", "binding_check", {method, correlation, bindingPresent: Object.hasOwn(input, "_sessionBinding"), proofPresent: Object.hasOwn(input, SESSION_PROOF_FIELD)});
      try {
        const response = await call(correlation);
        const result = outcome?.();
        event("request", result?.ok === true ? "INFO" : "WARN", "request_end", {method, correlation, elapsedMs: performance.now() - started,
          outcome: result?.ok === true ? "success" : result ? "rejected" : "UNKNOWN", errorCode: result?.errorCode, reasonCode: result?.reasonCode, failedChecks: result?.failedChecks});
        return response;
      } catch (error) {
        event("request", "ERROR", "request_end", {method, correlation, elapsedMs: performance.now() - started, outcome: "thrown"});
        throw error;
      }
    },
    async close(): Promise<void> {
      if (!child || closed) return;
      event("lifecycle", "INFO", "shutdown_start");
      closed = true;
      const target = child;
      await new Promise<void>(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (!flushed || pending.size > 0) {loss.shutdownLossPossible = true; accountUnconfirmed();}
          clearTimeout(timer); resolve();
        };
        const timer = setTimeout(() => {
          loss.shutdownLossPossible = true;
          accountUnconfirmed();
          target.kill("SIGKILL"); finish();
        }, config.flushDeadlineMs);
        target.once("exit", finish); target.once("error", finish);
        try {target.send({close: true}, error => {if (error) {target.kill("SIGKILL"); finish();}});} catch {target.kill("SIGKILL"); finish();}
      });
    },
  };
}
export type Diagnostics = Awaited<ReturnType<typeof createDiagnostics>>;
