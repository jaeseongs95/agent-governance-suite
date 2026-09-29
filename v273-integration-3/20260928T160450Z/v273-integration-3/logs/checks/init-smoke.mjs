// Independent reproduction: initialize each packaged server over stdio under both schema profiles
// and check that the instructions contain the shared intake block exactly once.
// Usage: node init-smoke.mjs <candidate-repo> <isolated-claude-plugin-copy>
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const [repo, pluginCopy] = process.argv.slice(2);
const req = createRequire(join(repo, "package.json"));
const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const shared = readFileSync(join(repo, "skills/orchestrator/SKILL.md"), "utf8");
const intake = shared.match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)[1];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const layouts = { "codex-root": join(repo, "mcp-server/dist/server.mjs"), "claude-plugin(in-repo)": join(repo, "claude-plugin/mcp-server/dist/server.mjs"), "claude-plugin(isolated copy)": join(pluginCopy, "mcp-server/dist/server.mjs") };
const rows = [];
for (const [layout, server] of Object.entries(layouts)) for (const profile of ["default", "anthropic", "(unset)"]) {
  const state = mkdtempSync(join(tmpdir(), "ags-audit-init-"));
  const env = { PATH: process.env.PATH, HOME: state, XDG_STATE_HOME: state, AGENT_GOVERNANCE_SHARED_STATE_DIR: state, AGENT_GOVERNANCE_UPDATE_CHECK: "off" };
  if (profile !== "(unset)") env.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE = profile;
  const client = new Client({ name: "audit", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "pipe" });
  try {
    await client.connect(transport);
    const text = client.getInstructions() ?? "";
    const tools = (await client.listTools()).tools;
    rows.push({ layout, profile, intakeOccurrences: text.split(intake).length - 1, instructionsSha256: sha(text), bytes: Buffer.byteLength(text), tools: tools.length, mentionsClaude: /Claude|Anthropic|Codex|Skill 도구/u.test(text) });
  } catch (e) { rows.push({ layout, profile, error: String(e) }); }
  finally { await client.close().catch(() => {}); rmSync(state, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ intakeSha256: sha(intake), rows }, null, 2));
const ok = rows.every((r) => r.intakeOccurrences === 1 && !r.mentionsClaude) && new Set(rows.map((r) => r.instructionsSha256)).size === 1;
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
