import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { producerFailure, producerFailureReason, retainFailureCause } from "./failure-diagnostics.js";
import { errorCode, reportWakeFailure, type WakeDispatchOutcome, type WakeDispatchPort } from "./session-message-wake-port.js";

function isWindowsNativeExecutable(candidatePath: string): boolean {
  const root = path.win32.parse(candidatePath).root;
  return root !== "\\" && root !== "/" && path.win32.isAbsolute(candidatePath)
    && path.win32.extname(candidatePath).toLowerCase() === ".exe"
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(candidatePath);
}
function isVerifiedWindowsNativeExecutable(candidatePath: string): boolean {
  return isWindowsNativeExecutable(candidatePath)
    && !/(?:^|[\\/])(?:tmp|var[\\/]tmp|dev[\\/]shm|temp|appdata[\\/]local[\\/]temp|users[\\/]public)(?:[\\/]|$)/iu.test(candidatePath);
}
// # ceiling: host-internal format stopgap (language_server.log, projects/*.json, agentapi.bat); replace with official host wake contract when available
export function resolveWindowsAgentApiFromShim(homeDir: string): { exe: string | null; diagnostic?: string } {
  // Antigravity's native hook executor does not set ANTIGRAVITY_AGENTAPI_EXE when spawning hooks or
  // detached relays, and instead writes <HOME>/.gemini/antigravity/bin/agentapi.bat wrapping the
  // native language_server*.exe. Never execute the .bat shim or invoke cmd.exe (D-0311); read it
  // as inert text and extract the quoted absolute .exe target only when it exists on disk.
  if (!homeDir) return { exe: null, diagnostic: "AGENTAPI_SHIM_MISSING" };
  let shimText: string;
  try {
    shimText = readFileSync(path.join(homeDir, ".gemini", "antigravity", "bin", "agentapi.bat"), "utf8");
  } catch (error) {
    return { exe: null, diagnostic: errorCode(error) === "ENOENT" ? "AGENTAPI_SHIM_MISSING" : "AGENTAPI_SHIM_READ_FAILED" };
  }
  const match = /^"([A-Za-z]:[\\/][^\r\n"]+?\.exe)"\s+agentapi(?:\s|$)/imu.exec(shimText);
  const extracted = match?.[1]?.trim() ?? "";
  if (!extracted) return { exe: null, diagnostic: "AGENTAPI_SHIM_FORMAT_UNRECOGNIZED" };
  if (!isVerifiedWindowsNativeExecutable(extracted)) return { exe: null, diagnostic: "AGENTAPI_SHIM_TARGET_UNTRUSTED" };
  if (!existsSync(extracted)) return { exe: null, diagnostic: "AGENTAPI_SHIM_TARGET_MISSING" };
  return { exe: extracted };
}
function resolveGeminiAgentApiWithDiagnostic(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { launch: { command: string; argsPrefix: string[] } | null; diagnostic?: string } {
  const configured = environment.ANTIGRAVITY_AGENTAPI_EXE;
  if (configured !== undefined) {
    if (!configured) {
      return platform === "win32"
        ? { launch: null, diagnostic: "missing-agentapi-exe:AGENTAPI_EXE_EMPTY" }
        : { launch: { command: "agentapi", argsPrefix: [] } };
    }
    if (platform === "win32" && !isWindowsNativeExecutable(configured)) {
      return { launch: null, diagnostic: "missing-agentapi-exe:AGENTAPI_EXE_UNVERIFIED" };
    }
    return { launch: { command: configured, argsPrefix: ["agentapi"] } };
  }
  const homeDir = environment.USERPROFILE || environment.HOME || "";
  if (platform === "win32") {
    const shim = resolveWindowsAgentApiFromShim(homeDir);
    if (shim.exe) {
      return { launch: { command: shim.exe, argsPrefix: ["agentapi"] } };
    }
    // agy CLI 1.4.12 ships no Windows shim; its installer-default agy.exe serves `agy.exe agentapi ...` natively.
    const agyExe = environment.LOCALAPPDATA ? path.win32.join(environment.LOCALAPPDATA, "agy", "bin", "agy.exe") : "";
    if (agyExe && isVerifiedWindowsNativeExecutable(agyExe) && existsSync(agyExe)) {
      return { launch: { command: agyExe, argsPrefix: ["agentapi"] } };
    }
    return { launch: null, diagnostic: `missing-agentapi-exe:${shim.diagnostic ?? "AGENTAPI_SHIM_MISSING"}` };
  }
  // Antigravity IDE shim first, then the agy CLI 1.4.12 shim (`exec agy agentapi "$@"`), then PATH.
  const command = [
    path.join(homeDir, ".gemini", "antigravity", "bin", "agentapi"),
    path.join(homeDir, ".gemini", "antigravity-cli", "bin", "agentapi"),
  ].find((candidate) => existsSync(candidate));
  return { launch: { command: command ?? "agentapi", argsPrefix: [] } };
}
export function resolveGeminiAgentApi(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; argsPrefix: string[] } | null {
  return resolveGeminiAgentApiWithDiagnostic(environment, platform).launch;
}

function sanitizeWakeEnvDiagnostic(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (/^[A-Z0-9_,:;.-]+$/u.test(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const codes: string[] = [];
    const collect = (val: unknown): void => {
      if (typeof val === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(val)) codes.push(val);
      else if (Array.isArray(val)) for (const item of val) collect(item);
      else if (val && typeof val === "object") for (const item of Object.values(val as Record<string, unknown>)) collect(item);
    };
    collect(parsed);
    return codes.length > 0 ? codes.join(",") : undefined;
  } catch {
    return undefined;
  }
}
/** Adds the connector-supplied environment diagnostic to the common bounded wake diagnostic. */
function reportAntigravityWakeFailure(phase: string, error: Error, environment: NodeJS.ProcessEnv, detail?: string): void {
  const envDiag = sanitizeWakeEnvDiagnostic(environment.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC);
  reportWakeFailure(phase, error, environment, [detail, envDiag].filter(Boolean).join(";") || undefined);
}

/**
 * agentapi (agy 1.4.12) reports a missing language-server connection as JSON on stdout, exit 1:
 * `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}` or `{"error":"rpc error: ... missing CSRF token"}`.
 * agy CLI hooks never receive that connection, so it is fixed for the birth, unlike a failed lookup.
 */
function agentApiConnectionMissing(stdout: unknown): boolean {
  if (typeof stdout !== "string") return false;
  try {
    const reported = (JSON.parse(stdout) as { error?: unknown }).error;
    return typeof reported === "string" && /ANTIGRAVITY_LS_ADDRESS is not set|missing CSRF token/u.test(reported);
  } catch {
    return false;
  }
}
const lsConnectionMissing = (): Error => producerFailure("GEMINI_LS_CONNECTION_MISSING", "agentapi has no language-server connection.");

const prerequisiteMissing = (reasonCode: string): WakeDispatchOutcome => ({ result: "not-delivered", kind: "prerequisite-missing", reasonCode });
const transient = (reasonCode: string): WakeDispatchOutcome => ({ result: "not-delivered", kind: "transient", reasonCode });

/** agentapi send-message result. Spawn failure is definite; a spawned failure may have sent. */
export function antigravityWakeOutcome(error: unknown, spawned: boolean): WakeDispatchOutcome {
  if (!error) return { result: "handed-off" };
  if (spawned) return { result: "unknown", reasonCode: "GEMINI_SEND_FAILED" };
  return errorCode(error) === "ENOENT" ? prerequisiteMissing("GEMINI_AGENTAPI_UNAVAILABLE") : transient("GEMINI_SEND_SPAWN_FAILED");
}

async function ringAntigravity(sessionId: string, message: string, environment: NodeJS.ProcessEnv = process.env): Promise<WakeDispatchOutcome> {
  const childEnv: NodeJS.ProcessEnv = { ...environment };
  const sourceProjectId = childEnv.ANTIGRAVITY_PROJECT_ID;
  if (typeof sourceProjectId !== "string" || !sourceProjectId.trim()) {
    reportAntigravityWakeFailure("gemini-preflight", producerFailure("GEMINI_PROJECT_ID_MISSING", "Gemini source project identity is missing."), childEnv, "missing-project-id");
    return prerequisiteMissing("GEMINI_PROJECT_ID_MISSING");
  }
  const { launch, diagnostic: launchDiagnostic } = resolveGeminiAgentApiWithDiagnostic(childEnv);
  if (!launch) {
    reportAntigravityWakeFailure("gemini-preflight", producerFailure("GEMINI_AGENTAPI_UNAVAILABLE", "Gemini agentapi executable is unavailable."), childEnv, launchDiagnostic ?? "missing-agentapi-exe");
    return prerequisiteMissing("GEMINI_AGENTAPI_UNAVAILABLE");
  }
  const { command, argsPrefix } = launch;
  let targetProjectId: string;
  try {
    const meta = await new Promise<string>((resolve, reject) => {
      execFile(command, [...argsPrefix, "get-conversation-metadata", sessionId],
        { windowsHide: true, timeout: 5_000, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error, stdout) => error ? reject(agentApiConnectionMissing(stdout) ? lsConnectionMissing() : error) : resolve(stdout));
    });
    if (agentApiConnectionMissing(meta)) throw lsConnectionMissing();
    const parsed = JSON.parse(meta) as {
      response?: { conversationMetadata?: { metadata?: { projectId?: unknown } } };
    };
    const projectId = parsed.response?.conversationMetadata?.metadata?.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw producerFailure("GEMINI_METADATA_PROJECT_MISSING", "Gemini conversation metadata has no project identity.");
    }
    targetProjectId = projectId;
  } catch (cause) {
    // Metadata failure happens before any send-message process is started. Keep the actual cause; never send.
    const error = producerFailureReason(cause) ? cause as Error
      : retainFailureCause(producerFailure("GEMINI_METADATA_FAILED", "Gemini conversation metadata lookup failed."), cause);
    reportAntigravityWakeFailure("gemini-metadata", error, childEnv);
    // No agentapi on PATH, or the conversation names no project: fixed for this birth. A failed lookup may recover.
    if (errorCode(cause) === "ENOENT") return prerequisiteMissing("GEMINI_AGENTAPI_UNAVAILABLE");
    const reason = producerFailureReason(error);
    return reason === "GEMINI_METADATA_PROJECT_MISSING" || reason === "GEMINI_LS_CONNECTION_MISSING"
      ? prerequisiteMissing(reason) : transient("GEMINI_METADATA_FAILED");
  }
  if (sourceProjectId !== targetProjectId) {
    reportAntigravityWakeFailure("gemini-metadata", producerFailure("GEMINI_PROJECT_MISMATCH", "Gemini conversation project identity does not match."), childEnv);
    return prerequisiteMissing("GEMINI_PROJECT_MISMATCH");
  }
  return new Promise((resolve) => {
    let spawned = false;
    let settled = false;
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (error) {
        const tagged = producerFailureReason(error) ? error as Error
          : retainFailureCause(producerFailure("GEMINI_SEND_FAILED", "Gemini send-message failed."), error);
        reportAntigravityWakeFailure("gemini-send", tagged, childEnv);
      }
      resolve(antigravityWakeOutcome(error, spawned));
    };
    try {
      const child = execFile(command, [...argsPrefix, "send-message", sessionId, message],
        { windowsHide: true, timeout: 10_000, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error) => finish(error));
      child.once("spawn", () => { spawned = true; });
      child.once("error", (error) => finish(error));
    } catch (cause) {
      finish(cause);
    }
  });
}

/** No public delivery contract: a handed-off marker may be lost, so resend on the short base (design 3.2). */
export const antigravityQueueWakePort: WakeDispatchPort = {
  capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
  resendBaseMs: 10 * 60_000,
  dispatch: (target, message) => ringAntigravity(target.sessionId, message),
};
