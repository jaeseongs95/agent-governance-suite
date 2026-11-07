import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const runner = path.join(import.meta.dirname, "plugin-run.mjs");
const hash = text => createHash("sha256").update(text).digest("hex");
function trial(host, cap, mode = "execute") {
  const root = mkdtempSync(path.join(tmpdir(), "ags-native-budget-"));
  const plugin = path.join(root, "plugin"), run = path.join(root, "run");
  const capture = path.join(root, "argv.json"), spec = path.join(root, "spec.json"), fake = path.join(root, "cli.mjs");
  for (const rel of [".claude-plugin", ".codex-plugin", "hooks", "mcp-server/dist"]) mkdirSync(path.join(plugin, rel), { recursive: true });
  for (const rel of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) writeFileSync(path.join(plugin, rel), JSON.stringify({ name: "synthetic-budget-fixture" }));
  writeFileSync(path.join(plugin, "hooks/hooks.json"), "{}");
  writeFileSync(path.join(plugin, "mcp-server/dist/server.mjs"), "// synthetic; never executed\n");
  writeFileSync(spec, JSON.stringify({ timeoutSec: 5, files: { "README.md": "Synthetic argument test only.\n" }, turns: [{ id: "argv", prompt: "Synthetic transport test." }] }));
  // Existing CLAUDE_BIN seam observes the real driver's argv without login, hooks, MCP, or a model.
  writeFileSync(fake, `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
writeFileSync(process.env.CUE_BUDGET_CAPTURE, JSON.stringify(args));
const session = args[args.indexOf("--session-id") + 1];
createInterface({ input: process.stdin }).on("line", line => {
  if (JSON.parse(line).type === "user") process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: session, total_cost_usd: 0 }) + "\\n");
});
`);
  const pin = path.join(root, "installed-pin.json");
  writeFileSync(pin, JSON.stringify({ pluginRoot: plugin, pluginId: "synthetic-budget-fixture", cacheSha256: "a".repeat(64),
    hooksSha256: hash("{}"), serverSha256: hash("// synthetic; never executed\n") }));
  const env = { ...process.env, CUE_CANDIDATE_SHA: "b".repeat(40), CLAUDE_BIN: fake, CUE_BUDGET_CAPTURE: capture };
  delete env.NODE_TEST_CONTEXT;
  delete env.CUE_MAX_BUDGET_USD;
  if (cap !== undefined) env.CUE_MAX_BUDGET_USD = cap;
  const result = spawnSync(process.execPath, [runner, mode, host, host === "claude" ? plugin : pin, run, spec, "opus", "high"],
    { env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
  return { root, run, result, args: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null };
}

describe("native plugin budget argument boundary", { skip: process.platform !== "linux" }, () => {
  for (const cap of ["1", "0.25"]) it(`passes Claude cap ${cap} to the native CLI boundary`, () => {
    const t = trial("claude", cap);
    try {
      assert.equal(t.result.error, undefined);
      assert.equal(t.result.status, 0, t.result.stderr);
      assert.equal(t.args.filter(arg => arg === "--max-budget-usd").length, 1, "cap must reach the native CLI exactly once");
      assert.equal(t.args[t.args.indexOf("--max-budget-usd") + 1], cap);
      assert.ok(t.args.includes("-p"));
      assert.equal(t.args[t.args.indexOf("--model") + 1], "opus");
      assert.equal(t.args[t.args.indexOf("--effort") + 1], "high");
      assert.ok(t.args.includes("--plugin-dir"));
      assert.equal(JSON.parse(readFileSync(path.join(t.run, "transport-summary.json"), "utf8")).cleanup.groupCleanup, "CONFIRMED");
    } finally { rmSync(t.root, { recursive: true, force: true }); }
  });
  it("keeps Claude's unspecified budget behavior", () => {
    const t = trial("claude");
    try {
      assert.equal(t.result.status, 0, t.result.stderr);
      assert.ok(!t.args.includes("--max-budget-usd"));
      assert.equal(t.args[t.args.indexOf("--model") + 1], "opus");
      assert.equal(t.args[t.args.indexOf("--effort") + 1], "high");
    } finally { rmSync(t.root, { recursive: true, force: true }); }
  });
  for (const cap of ["0", "-1", "", "NaN", "Infinity"]) it(`rejects invalid cap ${JSON.stringify(cap)} before fixture/CLI creation`, () => {
    const t = trial("claude", cap);
    try {
      assert.equal(t.result.error, undefined);
      assert.notEqual(t.result.status, 0);
      assert.match(t.result.stderr, /CUE_MAX_BUDGET_USD must be a finite positive number/u);
      assert.equal(existsSync(t.run), false);
      assert.equal(t.args, null);
    } finally { rmSync(t.root, { recursive: true, force: true }); }
  });
  it("refuses a Claude-only cap for Codex instead of forwarding or ignoring it", () => {
    const t = trial("codex", "1", "prepare");
    try {
      assert.notEqual(t.result.status, 0);
      assert.match(t.result.stderr, /CUE_MAX_BUDGET_USD is only supported for Claude/u);
      assert.equal(existsSync(t.run), false);
      assert.equal(t.args, null);
    } finally { rmSync(t.root, { recursive: true, force: true }); }
  });
  it("keeps Codex prepare unchanged when no budget is supplied", () => {
    const t = trial("codex", undefined, "prepare");
    try {
      assert.equal(t.result.status, 0, t.result.stderr);
      assert.equal(JSON.parse(readFileSync(path.join(t.run, "native-plugin-pin.json"), "utf8")).host, "codex");
      assert.equal(JSON.parse(readFileSync(path.join(t.run, "tasks.json"), "utf8"))[0].id, "argv");
      assert.equal(t.args, null);
    } finally { rmSync(t.root, { recursive: true, force: true }); }
  });
});
