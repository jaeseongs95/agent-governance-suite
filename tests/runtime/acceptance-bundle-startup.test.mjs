import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

async function removeCleanRoom(cleanRoot, primaryFailed, observe) {
  observe("cleanup", "enter");
  try {
    if (path.dirname(cleanRoot) !== path.resolve(tmpdir()) || !path.basename(cleanRoot).startsWith("ags-al06-acceptance-bundle-")) {
      throw new Error("Unexpected clean-room cleanup path");
    }
    await rm(cleanRoot, { recursive: true, force: true });
    observe("cleanup", "complete");
  } catch (error) {
    observe("cleanup", "failed", { suppressed: primaryFailed });
    if (!primaryFailed) throw error;
  }
}

it("starts the bundled MCP server without acceptance schema files beside mcp-server", async () => {
  const started = performance.now();
  let stage = "clean-root";
  const observe = (current, event, result = {}) => {
    stage = current;
    // One bounded record goes directly to the captured stderr, including on timeout.
    writeSync(2, JSON.stringify({ observation: "acceptance-bundle-startup", stage, event,
      elapsedMs: Math.round(performance.now() - started), ...result }) + "\n");
  };
  observe("clean-root", "enter");
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "ags-al06-acceptance-bundle-")).catch(error => {
    observe("clean-root", "failed");
    throw error;
  });
  observe("clean-root", "complete");
  let primaryFailed = false;
  try {
    observe("copy", "enter");
    await mkdir(path.join(cleanRoot, "mcp-server", "dist"), { recursive: true });
    await Promise.all([
      ...["contracts", "runtime", "skills"].map((directory) => cp(path.join(root, directory), path.join(cleanRoot, directory), { recursive: true })),
      cp(path.join(root, "mcp-server/dist/server.mjs"), path.join(cleanRoot, "mcp-server/dist/server.mjs")),
    ]);
    observe("copy", "complete");
    observe("prepare", "enter");
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
    observe("prepare", "complete");
    observe("child", "enter");
    const child = spawnSync(process.execPath, [path.join(cleanRoot, "mcp-server/dist/server.mjs")], {
      cwd: cleanRoot, env: environment, input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    observe("child", "complete", {
      status: child.status,
      signal: child.signal,
      errorCode: child.error ? ["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "EPERM"].includes(child.error.code) ? child.error.code : "OTHER" : null,
    });
    observe("assertions", "enter");
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const responses = child.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    expect(responses.find((message) => message.id === 1)).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
    const tools = responses.find((message) => message.id === 2);
    expect(tools?.error).toBeUndefined();
    expect(tools?.result?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "plan_workflow" })]));
    observe("assertions", "complete");
  } catch (error) {
    primaryFailed = true;
    observe(stage, "failed");
    throw error;
  } finally {
    await removeCleanRoom(cleanRoot, primaryFailed, observe);
  }
}, 30_000);
