import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

it("starts the bundled MCP server without acceptance schema files beside mcp-server", async () => {
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "ags-al06-acceptance-bundle-"));
  try {
    await mkdir(path.join(cleanRoot, "mcp-server", "dist"), { recursive: true });
    await Promise.all([
      ...["contracts", "runtime", "skills"].map((directory) => cp(path.join(root, directory), path.join(cleanRoot, directory), { recursive: true })),
      cp(path.join(root, "mcp-server/dist/server.mjs"), path.join(cleanRoot, "mcp-server/dist/server.mjs")),
    ]);
    await expect(access(path.join(cleanRoot, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(cleanRoot, "mcp-server/contracts"))).rejects.toMatchObject({ code: "ENOENT" });
    const environment = {
      ...process.env,
      SKILL_REGISTRY_PATH: path.join(cleanRoot, "skills/registry.json"),
      AGENT_GOVERNANCE_DB_PATH: path.join(cleanRoot, "state/workflows.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(cleanRoot, "state/continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(cleanRoot, "state/trust.sqlite3"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(cleanRoot, "state/session-board.sqlite3"),
      AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(cleanRoot, "state/shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(cleanRoot, "state/messaging"),
    };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.AGENT_GOVERNANCE_ROOT;
    delete environment.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG;
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "al06-acceptance-clean-room", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const child = spawnSync(process.execPath, [path.join(cleanRoot, "mcp-server/dist/server.mjs")], {
      cwd: cleanRoot, env: environment, input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const responses = child.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    expect(responses.find((message) => message.id === 1)).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
    const tools = responses.find((message) => message.id === 2);
    expect(tools?.error).toBeUndefined();
    expect(tools?.result?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "plan_workflow" })]));
  } finally {
    if (path.dirname(cleanRoot) !== path.resolve(tmpdir()) || !path.basename(cleanRoot).startsWith("ags-al06-acceptance-bundle-")) {
      throw new Error("Unexpected clean-room cleanup path");
    }
    await rm(cleanRoot, { recursive: true, force: true });
  }
}, 30_000);
