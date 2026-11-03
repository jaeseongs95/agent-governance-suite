import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A workspace locator whose root exists on every host. Workspace identity resolves the nearest existing ancestor, and a
 * fixed drive such as `D:/` is missing on the Windows test server (the identity is then WORKSPACE_IDENTITY_UNRESOLVED).
 */
export function fixtureLocator(...parts: string[]): string {
  return path.join(tmpdir(), "ags-fixture-workspaces", ...parts).replaceAll("\\", "/");
}
