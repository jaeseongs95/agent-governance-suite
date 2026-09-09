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
