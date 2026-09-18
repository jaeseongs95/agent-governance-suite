import { realpathSync } from "node:fs";
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

/** Resolves the immutable glossary shipped inside the Korean prose skill. */
export function resolveKoreanProseGlossaryPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../../skills/korean-prose-editor/resources/korean-prose-glossary.sqlite3", moduleUrl));
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

  let stateRoot: string;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  }
  return path.resolve(stateRoot, "agent-governance-suite", "workflows.sqlite3");
}

/** Resolves continuity state beside workflow state unless explicitly overridden. */
export function resolveContinuityDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  currentWorkingDirectory: string = process.cwd(),
): string {
  const configured = environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  const workflowPath = resolveWorkflowDatabasePath(
    environment,
    platform,
    homeDirectory,
    currentWorkingDirectory,
  );
  if (workflowPath === ":memory:") return ":memory:";
  return path.join(path.dirname(workflowPath), "continuity.sqlite3");
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
 * Selects the advertised MCP tool schema profile. Only the exact value
 * "anthropic" changes the default, so an unset or unknown value keeps the
 * historical schemas.
 */
export function resolveToolSchemaProfile(
  environment: NodeJS.ProcessEnv = process.env,
): "default" | "anthropic" {
  return environment.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE === "anthropic" ? "anthropic" : "default";
}

/**
 * Enables the Claude Code host attestation adapter. Only the Claude Code plugin
 * manifest sets this; an unset or unknown value keeps the server without a
 * trusted execution provider, so strict orchestration stays BINDING_REQUIRED.
 */
export function resolveHostAttestation(
  environment: NodeJS.ProcessEnv = process.env,
): "claude-code" | null {
  return environment.AGENT_GOVERNANCE_HOST_ATTESTATION === "claude-code" ? "claude-code" : null;
}
