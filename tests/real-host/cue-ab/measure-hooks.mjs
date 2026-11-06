// Measures the text one plugin tree hands the model through its hooks, outside any host:
//   node measure-hooks.mjs <claude|codex> <pluginRoot> <outFile>
// It reads the tree's own hooks.json, runs every command registered for SessionStart (startup, resume, compact) and for
// UserPromptSubmit (one call per turn of tasks.mjs) with a made-up payload, and counts characters. The state is a
// temporary folder, so nothing of the machine's AGS state is touched. This is a stand-in for what the host injects:
// the host's own wrapping is not included, and the cue text can differ slightly with the session's state.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TURNS } from "./tasks.mjs";

const [host, pluginRoot, outFile] = process.argv.slice(2);
if (!["claude", "codex"].includes(host) || !pluginRoot || !outFile) throw new Error("usage: node measure-hooks.mjs <claude|codex> <pluginRoot> <outFile>");

const root = path.resolve(pluginRoot);
const tmp = mkdtempSync(path.join(tmpdir(), "cue-ab-hooks-"));
const cwd = path.join(tmp, "repo");
mkdirSync(cwd);
const env = {
  ...process.env,
  XDG_STATE_HOME: path.join(tmp, "state"),
  AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(tmp, "shared"),
  ...(host === "claude" ? { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: path.join(tmp, "data") } : { PLUGIN_ROOT: root }),
};
delete env.AGENT_GOVERNANCE_LOCALE; // both arms use the machine's default locale, as the real runs do.

const hooksFile = path.join(root, "hooks", "hooks.json");
const registered = JSON.parse(readFileSync(hooksFile, "utf8")).hooks;

function contextChars(stdout) {
  if (!stdout.trim()) return 0;
  try {
    const out = JSON.parse(stdout);
    const text = out?.hookSpecificOutput?.additionalContext ?? out?.additionalContext ?? out?.systemMessage;
    return typeof text === "string" ? text.length : 0;
  } catch { return 0; }
}

/** Every command registered for the event whose matcher accepts `matcherInput`, run once with `payload`. */
function fire(event, matcherInput, payload) {
  const rows = [];
  for (const entry of registered[event] ?? []) {
    if (entry.matcher && matcherInput !== undefined && !new RegExp(entry.matcher, "u").test(matcherInput)) continue;
    for (const hook of entry.hooks ?? []) {
      if (hook.type && hook.type !== "command") continue;
      const label = String(hook.args?.[0] ?? hook.command).match(/([\w-]+)\.mjs/u)?.[1] ?? String(hook.command);
      const input = JSON.stringify(payload);
      const started = Date.now();
      const run = host === "claude"
        ? spawnSync(hook.command, (hook.args ?? []).map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)), { input, env, cwd, encoding: "utf8", timeout: 20_000 })
        : spawnSync("bash", ["-c", hook.command], { input, env, cwd, encoding: "utf8", timeout: 20_000 });
      const stdout = run.stdout ?? "";
      rows.push({ hook: label, exit: run.status, ms: Date.now() - started, stdoutChars: stdout.length, contextChars: contextChars(stdout), stderrChars: (run.stderr ?? "").length });
    }
  }
  return { event, rows, stdoutChars: rows.reduce((n, row) => n + row.stdoutChars, 0), contextChars: rows.reduce((n, row) => n + row.contextChars, 0) };
}

const base = (sessionId, name, extra) => ({
  session_id: sessionId, transcript_path: path.join(tmp, `${sessionId}.jsonl`), cwd, hook_event_name: name,
  ...(host === "codex" ? { turn_id: randomUUID(), model: "measure", permission_mode: "bypassPermissions" } : { permission_mode: "bypassPermissions" }),
  ...extra,
});

const result = { host, pluginRoot: root, hooksFile, locale: process.env.AGENT_GOVERNANCE_LOCALE ?? null, sessionStart: {}, userPromptSubmit: [] };
for (const source of ["startup", "resume", "compact"]) {
  result.sessionStart[source] = fire("SessionStart", source, base(randomUUID(), "SessionStart", { source }));
}
const session = randomUUID();
fire("SessionStart", "startup", base(session, "SessionStart", { source: "startup" }));
for (const [index, turn] of TURNS.entries()) {
  result.userPromptSubmit.push({ turn: index + 1, ...fire("UserPromptSubmit", undefined, base(session, "UserPromptSubmit", { prompt: turn.prompt })) });
}
writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
rmSync(tmp, { recursive: true, force: true });
const per = result.userPromptSubmit.map((row) => row.contextChars);
console.log(`${host}: SessionStart context chars startup=${result.sessionStart.startup.contextChars} resume=${result.sessionStart.resume.contextChars} compact=${result.sessionStart.compact.contextChars}; UserPromptSubmit context chars per turn=${per.join(",")}`);
