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
