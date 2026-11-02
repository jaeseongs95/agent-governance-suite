import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { failureContext, failureReason } from "../failure-diagnostics.js";
import { PLUGIN_INFO } from "../plugin-info.js";
import { resolveSharedStateDirectory } from "../runtime-config.js";
import { startService, type RunningService, type ServiceEvent, type ServiceExitReason } from "./ags-service.js";
import { prepareUserDirectory, readBuildDigest, serviceStateDirectory } from "./ipc-endpoint.js";
import { ensureService } from "./service-client.js";

/**
 * Entry of mcp-server/dist/ags-service.mjs (docs/ags31-dbms-service-design.md 4.2, 5.9).
 *
 *   node ags-service.mjs [serve] --state-dir DIR [--idle-ms N] [--max-connections N] [--queue-limit N]
 *   node ags-service.mjs status --state-dir DIR
 *
 * A Windows service is started through CIM and inherits no environment, so every value comes from the arguments;
 * AGENT_GOVERNANCE_* variables are not read here. Values that differ per connection arrive in the hello profile.
 */
const EVENT_LOG_LIMIT_BYTES = 1024 * 1024;

function parseArguments(argv: readonly string[]): { command: string; values: Map<string, string> } {
  const values = new Map<string, string>();
  let command = "serve";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) { command = argv[0]; index = 1; }
  for (; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${name ?? ""}`);
    values.set(name.slice(2), value);
  }
  return { command, values };
}

function positiveInteger(values: Map<string, string>, name: string): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer.`);
  return value;
}

/** Lifecycle events: one bounded JSON line each in service/service-events.log (one older generation kept) and stderr. */
function eventWriter(stateDirectory: string): (event: ServiceEvent) => void {
  const file = path.join(serviceStateDirectory(stateDirectory), "service-events.log");
  return event => {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + "\n";
    try { process.stderr.write("[agent-governance-suite] service " + line); } catch { /* stderr may be closed. */ }
    try {
      try { if (statSync(file).size > EVENT_LOG_LIMIT_BYTES) renameSync(file, file + ".1"); }
      catch (error) { if ((error as { code?: unknown }).code !== "ENOENT") throw error; }
      appendFileSync(file, line, { mode: 0o600 });
    } catch { /* The event log is diagnostic; it cannot stop or start the service. */ }
  };
}

async function serve(stateDirectory: string, values: Map<string, string>): Promise<number> {
  const record = eventWriter(stateDirectory);
  const build = readBuildDigest(fileURLToPath(import.meta.url));
  let running: RunningService;
  try {
    const idleMs = positiveInteger(values, "idle-ms");
    const maxConnections = positiveInteger(values, "max-connections");
    const queueLimit = positiveInteger(values, "queue-limit");
    prepareUserDirectory(serviceStateDirectory(stateDirectory));
    running = await startService({ stateDirectory, version: PLUGIN_INFO.version, build, onEvent: record,
      ...(idleMs ? { idleMs } : {}), ...(maxConnections ? { maxConnections } : {}), ...(queueLimit ? { queueLimit } : {}) });
  } catch (error) {
    const reason = failureReason(error).reason ?? "SERVICE_START_FAILED";
    record({ event: "start_failed", reason, context: failureContext(error) });
    // D2: a second service ends quietly; the first one keeps serving.
    return reason === "SERVICE_ALREADY_RUNNING" ? 0 : 1;
  }
  record({ event: "started", version: PLUGIN_INFO.version, build });
  const stop = (reason: ServiceExitReason) => { void running.shutdown(reason); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
    try { process.on(signal, () => stop("signal")); } catch { /* Not every signal exists on every OS. */ }
  }
  const { reason } = await running.closed;
  record({ event: "stopped", reason });
  return 0;
}

async function status(stateDirectory: string): Promise<number> {
  try {
    const session = await ensureService({ stateDirectory, role: "rpc", deadlineMs: 3_000, launch: false, handover: false,
      client: { kind: "cli", version: PLUGIN_INFO.version, build: readBuildDigest(fileURLToPath(import.meta.url)) } });
    const result = await session.request("service.status", {}, { deadlineMs: 2_000 });
    session.close();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ reason: failureReason(error).reason ?? "SERVICE_STATUS_FAILED" }) + "\n");
    return 1;
  }
}

let exitCode: number;
try {
  const { command, values } = parseArguments(process.argv.slice(2));
  const stateDirectory = path.resolve(values.get("state-dir") ?? resolveSharedStateDirectory({}, homedir()));
  if (command === "serve") exitCode = await serve(stateDirectory, values);
  else if (command === "status") exitCode = await status(stateDirectory);
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`[agent-governance-suite] service ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 2;
}
// Ends lingering handles (a socket still flushing); the owner lock is already released on a normal stop.
process.exit(exitCode);
