#!/usr/bin/env node
// Claude Code launcher for the shared host attestation hook bundle.
// The token is signed with a key in the Claude plugin's workflow database under
// CLAUDE_PLUGIN_DATA, the same database the MCP server opens. Whenever no token
// is issued, a token the caller put in the arguments is removed, so strict
// orchestration fails closed with BINDING_REQUIRED instead of trusting it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const FIELD = "_hostAttestation";
const LAUNCHER = "host-attestation-hook";

/** Names the failed launcher stage with a bounded code; never messages, paths or input. */
function reportLauncherFailure(stage, cause, observed = {}) {
  try {
    let code;
    if (cause && (typeof cause === "object" || typeof cause === "function") && !types.isProxy(cause)) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(descriptor.value)) code = descriptor.value;
    }
    writeSync(2, `[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: LAUNCHER, stage, ...(code ? { code } : {}), ...observed })}\n`);
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch (cause) {
  reportLauncherFailure("stdin", cause);
  process.exit(0);
}

function withoutCallerToken() {
  try {
    const input = JSON.parse(raw);
    const toolInput = input?.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";
    if (!Object.prototype.hasOwnProperty.call(toolInput, FIELD)) return "";
    const updatedInput = { ...toolInput };
    delete updatedInput[FIELD];
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } });
  } catch {
    return "";
  }
}

function finish(output) {
  if (output) process.stdout.write(output);
  // Attestation is fail-closed on the server: never block the tool call on launcher failures.
  process.exit(0);
}

const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (!dataDirectory) finish(withoutCallerToken());

try {
  mkdirSync(dataDirectory, { recursive: true });
} catch (cause) {
  reportLauncherFailure("data-directory", cause);
  finish(withoutCallerToken());
}

const hookPath = fileURLToPath(new URL("../mcp-server/dist/host-attestation-hook.mjs", import.meta.url));
const result = spawnSync(process.execPath, [hookPath], {
  input: raw,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "inherit"],
  timeout: 9000,
  env: {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
  },
});
const signal = typeof result.signal === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.signal) ? { signal: result.signal } : {};
if (result.error) reportLauncherFailure("spawn", result.error, signal);
else if (result.status !== 0) reportLauncherFailure("hook-exit", null, { status: Number.isInteger(result.status) ? result.status : null, ...signal });
const output = result.status === 0 && !result.error && typeof result.stdout === "string" ? result.stdout : "";
finish(output || withoutCallerToken());
