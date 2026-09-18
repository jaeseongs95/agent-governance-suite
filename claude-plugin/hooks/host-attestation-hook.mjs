#!/usr/bin/env node
// Claude Code launcher for the shared host attestation hook bundle.
// The token is signed with a key in the Claude plugin's workflow database under
// CLAUDE_PLUGIN_DATA, the same database the MCP server opens. Whenever no token
// is issued, a token the caller put in the arguments is removed, so strict
// orchestration fails closed with BINDING_REQUIRED instead of trusting it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIELD = "_hostAttestation";

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
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
} catch {
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
const output = result.status === 0 && !result.error && typeof result.stdout === "string" ? result.stdout : "";
finish(output || withoutCallerToken());
