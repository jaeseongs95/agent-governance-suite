// Measures the text one plugin tree hands the model through its hooks, outside any host:
//   node measure-hooks.mjs <claude|codex> <pluginRoot> <outFile>
// It reads the tree's own hooks.json, runs every command registered for SessionStart (startup, resume, compact) and for
// UserPromptSubmit (one call per turn of tasks.mjs) with a made-up payload, and counts characters. The state is a
// temporary folder. This measures source output, not host wrapping, model input or tokens.
// Raw stdout/context files beside outFile preserve bytes and allow list/payload comparisons.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TURNS } from "./tasks.mjs";

const [host, pluginRoot, outFile] = process.argv.slice(2);
if (!["claude", "codex"].includes(host) || !pluginRoot || !outFile) throw new Error("usage: node measure-hooks.mjs <claude|codex> <pluginRoot> <outFile>");

const root = path.resolve(pluginRoot);
const output = path.resolve(outFile);
const outputs = `${output}.outputs`;
if (existsSync(output) || existsSync(outputs)) throw new Error("Measurement output already exists; use a fresh outFile");
const hooksFile = path.join(root, "hooks", "hooks.json");
const registered = JSON.parse(readFileSync(hooksFile, "utf8")).hooks;
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(outputs);
const tmp = mkdtempSync(path.join(tmpdir(), "cue-ab-hooks-"));
const cwd = path.join(tmp, "repo");
mkdirSync(cwd);
const env = {
  ...process.env,
  XDG_STATE_HOME: path.join(tmp, "state"),
  AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(tmp, "shared"),
  ...(host === "claude" ? { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: path.join(tmp, "data") } : { PLUGIN_ROOT: root }),
};
let sequence = 0;
let failed = false;
const digest = value => createHash("sha256").update(value).digest("hex");

function contextOutput(stdout) {
  if (!stdout.trim()) return { status: "NO_OUTPUT", text: null };
  try {
    const out = JSON.parse(stdout);
    const text = out?.hookSpecificOutput?.additionalContext ?? out?.additionalContext ?? out?.systemMessage;
    return text == null ? { status: "NO_CONTEXT", text: null }
      : typeof text === "string" ? { status: "TEXT", text }
        : { status: "INVALID_CONTEXT", text: null };
  } catch { return { status: "INVALID_JSON", text: null }; }
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
        ? spawnSync(hook.command, (hook.args ?? []).map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)), { input, env, cwd, timeout: 20_000 })
        : spawnSync("bash", ["-c", hook.command], { input, env, cwd, timeout: 20_000 });
      const ms = Date.now() - started;
      const stdout = run.stdout ?? Buffer.alloc(0), stderr = run.stderr ?? Buffer.alloc(0);
      const text = stdout.toString("utf8"), context = contextOutput(text);
      const stem = String(++sequence).padStart(4, "0");
      const save = (suffix, bytes) => {
        const file = path.join(outputs, `${stem}.${suffix}`);
        writeFileSync(file, bytes);
        return { file: path.relative(path.dirname(output), file), sha256: digest(bytes) };
      };
      const contextBytes = context.text == null ? null : Buffer.from(context.text, "utf8");
      const rowFailed = run.status !== 0 || Boolean(run.error) || context.status.startsWith("INVALID_");
      failed ||= rowFailed;
      rows.push({ hook: label, exit: run.status, signal: run.signal, errorCode: run.error?.code ?? null, failed: rowFailed, ms,
        stdoutChars: text.length, stdoutCodePoints: [...text].length, stdoutBytes: stdout.length,
        contextChars: context.text?.length ?? 0, contextCodePoints: [...(context.text ?? "")].length, contextBytes: contextBytes?.length ?? 0,
        contextStatus: context.status, stderrChars: stderr.toString("utf8").length, stderrBytes: stderr.length,
        stdout: save("stdout", stdout), stderr: save("stderr", stderr), context: contextBytes == null ? null : save("context.txt", contextBytes) });
    }
  }
  return { event, supported: rows.length > 0, rows, stdoutChars: rows.reduce((n, row) => n + row.stdoutChars, 0),
    stdoutBytes: rows.reduce((n, row) => n + row.stdoutBytes, 0), contextChars: rows.reduce((n, row) => n + row.contextChars, 0),
    contextBytes: rows.reduce((n, row) => n + row.contextBytes, 0) };
}

const base = (sessionId, name, extra) => ({
  session_id: sessionId, transcript_path: path.join(tmp, `${sessionId}.jsonl`), cwd, hook_event_name: name,
  ...(host === "codex" ? { turn_id: randomUUID(), model: "measure", permission_mode: "bypassPermissions" } : { permission_mode: "bypassPermissions" }),
  ...extra,
});

const result = { host, pluginRoot: root, hooksFile, locale: env.AGENT_GOVERNANCE_LOCALE ?? null,
  localeScope: "passed AGENT_GOVERNANCE_LOCALE; null means unset/default", characterUnit: "UTF-16 code units (String.length)",
  measurementScope: "source output with synthetic inputs; no native/model wrapping or tokens", sessionStart: {}, userPromptSubmit: [] };
try {
  for (const source of ["startup", "resume", "compact"]) {
    result.sessionStart[source] = fire("SessionStart", source, base(randomUUID(), "SessionStart", { source }));
  }
  const session = randomUUID();
  result.preludeSessionStart = fire("SessionStart", "startup", base(session, "SessionStart", { source: "startup" }));
  for (const [index, turn] of TURNS.entries()) {
    result.userPromptSubmit.push({ turn: index + 1, ...fire("UserPromptSubmit", undefined, base(session, "UserPromptSubmit", { prompt: turn.prompt })) });
  }
  result.failed = failed;
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  const per = result.userPromptSubmit.map((row) => row.contextChars);
  console.log(`${host}: SessionStart context chars startup=${result.sessionStart.startup.contextChars} resume=${result.sessionStart.resume.contextChars} compact=${result.sessionStart.compact.contextChars}; UserPromptSubmit context chars per turn=${per.join(",")}; failed=${failed}`);
  if (failed) process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
