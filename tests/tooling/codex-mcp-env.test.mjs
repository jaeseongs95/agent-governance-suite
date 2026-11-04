import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");

/** Every AGENT_GOVERNANCE_* name the server and the scripts it loads read; the list in .mcp.json must not fall behind. */
async function governanceVariables() {
  const names = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.mjs")) {
        for (const match of (await readFile(file, "utf8")).matchAll(/AGENT_GOVERNANCE_[A-Z0-9_]+/g)) names.add(match[0]);
      }
    }
  };
  await walk(path.join(root, "mcp-server", "src"));
  await walk(path.join(root, "skills", "session-board", "scripts"));
  return names;
}

describe("Codex MCP server environment", () => {
  // Codex hands a stdio MCP server only its default variables plus the names in env_vars (codex rust-v0.166.0
  // rmcp-client/src/utils.rs create_env_for_mcp_server); hooks get the full environment. A state path variable missing
  // here makes the hooks and the server read different databases (the first start_workflow then finds no workspace).
  it.each([".mcp.json", "codex-plugin-en/.mcp.json"])("%s passes every AGS variable and the state base through", async (file) => {
    const server = JSON.parse(await readFile(path.join(root, file), "utf8")).mcpServers["agent-governance-suite"];
    const passed = new Set(server.env_vars);
    const missing = [...await governanceVariables()].filter((name) => !passed.has(name) && !(name in server.env));
    expect(missing).toEqual([]);
    for (const base of ["XDG_STATE_HOME", "LOCALAPPDATA"]) expect(passed.has(base), base).toBe(true);
  });
});
