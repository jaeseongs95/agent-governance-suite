import type { HostExecutionAdapter } from "./host-attestation.js";
import { defaultExecutionAdapters } from "./host-execution-adapters.js";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the packaged registry beside the bundled server. Deployments may
 * override it without changing the plugin manifest or specialist skills.
 */
export function resolveRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  return environment.SKILL_REGISTRY_PATH
    ?? fileURLToPath(new URL("../../skills/registry.json", moduleUrl));
}

/** Resolves the immutable glossary the server's lookup tool owns; skills read it only through that tool. */
export function resolveKoreanProseGlossaryPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../runtime/korean-prose-glossary/korean-prose-glossary.sqlite3", moduleUrl));
}

/** Resolves durable workflow state outside the plugin installation by default. */
export function resolveWorkflowDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  const configured = environment.AGENT_GOVERNANCE_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.resolve(userStateDirectory(environment, platform, homeDirectory), "workflows.sqlite3");
}

/** The per-user state directory shared by every host installation on this machine. */
function userStateDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  let stateRoot: string;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  }
  return path.resolve(stateRoot, "agent-governance-suite");
}

/** The host-neutral state root shared across local AI runtimes. */
function sharedUserStateDirectory(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path.normalize(configured);
  }
  return path.resolve(homeDirectory, ".agent-governance-suite");
}

/** This machine's persistent AGS host ID (root identities), beside the other shared host state. */
export function resolveHostIdPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "host-id");
}

/** Resolves the per-user TLS broker directory shared by supported local hosts. */
export function resolveSessionMessageStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}

/** Resolves the signed receipt store shared by every supported local host. */
export function resolveTrustDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(
    resolveSessionMessageStateDirectory(environment, platform, homeDirectory, currentWorkingDirectory),
    "trust.sqlite3",
  );
}

function besideWorkflowDatabase(
  variable: string,
  fileName: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
  currentWorkingDirectory: string,
): string {
  const configured = environment[variable]?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  const workflowPath = resolveWorkflowDatabasePath(
    environment,
    platform,
    homeDirectory,
    currentWorkingDirectory,
  );
  if (workflowPath === ":memory:") return ":memory:";
  return path.join(path.dirname(workflowPath), fileName);
}

/** Resolves continuity state beside workflow state unless explicitly overridden. */
export function resolveContinuityDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  return besideWorkflowDatabase("AGENT_GOVERNANCE_CONTINUITY_DB_PATH", "continuity.sqlite3", environment, platform, homeDirectory, currentWorkingDirectory);
}

/**
 * Resolves the session board every host on this machine shares (Claude Code and Codex alike). It stays in the
 * user state directory even when a host moves its own workflow database, unless explicitly overridden.
 */
export function resolveSessionBoardDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "session-board.sqlite3");
}

/**
 * The global and role contexts and the session-to-role bindings every host on this computer shares (the situational
 * context stays in each host's continuity store). Same directory as the session board unless explicitly overridden.
 */
export function resolveContextLayerDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  const configured = environment.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "context-layers.sqlite3");
}

/** The data key that encrypts the JEV keys registered on the admin page, beside the shared context file. */
export function resolveJevKeyVaultPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveContextLayerDatabasePath(environment)), "jev-key-vault.bin");
}

/** The fixed local port of the admin page (AGS3-T-0024); 0 turns the page off. */
export const DEFAULT_ADMIN_PORT = 47615;

export function resolveAdminPort(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = environment.AGENT_GOVERNANCE_ADMIN_PORT?.trim();
  if (!configured) return DEFAULT_ADMIN_PORT;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("AGENT_GOVERNANCE_ADMIN_PORT must be an integer from 0 to 65535.");
  return port;
}

/** The page address agents give the user; always `localhost` (a WebAuthn relying party ID cannot be an IP address). */
export function adminPageUrl(port: number): string {
  return `http://localhost:${port}/`;
}

/** Where the MCP server that serves the page records the port it actually listens on (AGS3-D-0078). */
export function resolveAdminPageRecordPath(environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = homedir()): string {
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "admin-page.json");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The recorded page port while the process that recorded it is alive; null when there is none or it cannot be read. */
export function readAdminPageRecord(environment: NodeJS.ProcessEnv = process.env): { port: number; pid: number } | null {
  try {
    const record = JSON.parse(readFileSync(resolveAdminPageRecordPath(environment), "utf8")) as { port?: unknown; pid?: unknown };
    const { port, pid } = record;
    if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      && typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processAlive(pid)) return { port, pid };
  } catch { /* No record or an unreadable one. */ }
  return null;
}

/**
 * The page address to give the user: the port a live AGS process recorded it serves on, else the configured port;
 * null when the page is turned off. Throws when AGENT_GOVERNANCE_ADMIN_PORT is invalid, like resolveAdminPort.
 */
export function resolveAdminPageUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const port = resolveAdminPort(environment);
  if (port === 0) return null;
  return adminPageUrl(readAdminPageRecord(environment)?.port ?? port);
}

function canonicalDatabasePath(databasePath: string, platform: NodeJS.Platform): string | null {
  if (databasePath === ":memory:") return null;
  const absolute = path.resolve(databasePath);
  const unresolved: string[] = [];
  let cursor = absolute;
  let resolved = absolute;
  while (true) {
    try {
      resolved = path.join(realpathSync.native(cursor), ...unresolved.reverse());
      break;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      unresolved.push(path.basename(cursor));
      cursor = parent;
    }
  }
  const normalized = path.normalize(resolved);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

/** Rejects aliases that would mix optional continuity tables into workflow state. */
export function assertDistinctDatabasePaths(
  workflowDatabasePath: string,
  continuityDatabasePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const workflowIdentity = canonicalDatabasePath(workflowDatabasePath, platform);
  const continuityIdentity = canonicalDatabasePath(continuityDatabasePath, platform);
  if (workflowIdentity !== null && workflowIdentity === continuityIdentity) {
    throw new Error("Workflow and continuity databases must use different files.");
  }
}

/**
 * Selects the advertised MCP tool schema profile. The normalized value
 * "inline-references" selects the host-neutral compatibility behavior.
 * The historical exact "anthropic" alias remains supported.
 */
export function resolveToolSchemaProfile(
  environment: NodeJS.ProcessEnv = process.env,
): "default" | "inline-references" | "anthropic" {
  const configured = environment.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE;
  if (configured === "anthropic") return "anthropic";
  return configured?.trim().toLowerCase() === "inline-references" ? "inline-references" : "default";
}

/** Selects an actual trusted adapter; the environment supplies only a lookup key, never authority. */
export function resolveHostAttestation(
  environment: NodeJS.ProcessEnv = process.env,
  adapters: ReadonlyMap<string, HostExecutionAdapter> = defaultExecutionAdapters,
): HostExecutionAdapter | null {
  const host = environment.AGENT_GOVERNANCE_HOST_ATTESTATION;
  if (!host) return null;
  const adapter = adapters.get(host);
  return adapter && adapter.host === host && typeof adapter.modelClassForModel === "function"
    && (adapter.resolveModel === undefined || typeof adapter.resolveModel === "function") ? adapter : null;
}
