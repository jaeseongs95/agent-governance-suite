// Initialize each packaged server under both schema profiles and compare instructions with the shared intake block.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const repo = process.argv[2];
const intake = readFileSync(path.join(repo, "skills/orchestrator/SKILL.md"), "utf8").match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)[1];
const results = [];
for (const [label, root] of [["codex-root", repo], ["claude-plugin", path.join(repo, "claude-plugin")]]) {
  for (const profile of ["default", "anthropic"]) {
    const state = mkdtempSync(path.join(tmpdir(), "ags-init-"));
    const env = { PATH: process.env.PATH, HOME: state, AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: profile,
      AGENT_GOVERNANCE_DB_PATH: path.join(state, "w.sqlite3"), AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "c.sqlite3"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "b.sqlite3"), AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "t.sqlite3"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "m"), CLAUDE_PLUGIN_DATA: path.join(state, "pd") };
    const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }) + "\n";
    const r = spawnSync(process.execPath, [path.join(root, "mcp-server/dist/server.mjs")], { cwd: root, env, input, encoding: "utf8", timeout: 20000 });
    const msg = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 1);
    const ins = msg?.result?.instructions ?? "";
    results.push({ label, profile, status: r.status, containsIntakeOnce: ins.split(intake).length === 2, instructionsSha256: (await import("node:crypto")).createHash("sha256").update(ins).digest("hex") });
    rmSync(state, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(results, null, 1));
if (!results.every((r) => r.containsIntakeOnce) || new Set(results.map((r) => r.instructionsSha256)).size !== 1) process.exit(1);
