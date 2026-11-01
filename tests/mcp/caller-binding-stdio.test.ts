import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stdioServerForSuite } from "../helpers/stdio-server.js";

// Packaged-boundary contract of the session binding: only the shipped hook and server bundles and the MCP
// wire format are used, so the same file also runs against an older build. Synthetic hook input, not native capture.
const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = (name: string) => path.join(root, "mcp-server", "dist", name);
const TOOL = "validate_collaboration_decision";
let directory = "";
let environment: Record<string, string> = {};

// One server for the file, started before any test's time limit and outside a hook timer (stdioServerForSuite).
const server = stdioServerForSuite(async ({ defer, connect }) => {
  directory = await mkdtemp(path.join(tmpdir(), "ags-caller-binding-stdio-"));
  defer(() => rm(directory, { recursive: true, force: true }));
  environment = { ...getDefaultEnvironment(), AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code",
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messaging"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared") };
  return connect("caller-binding-stdio", { command: process.execPath, args: [dist("server.mjs")], cwd: directory, env: environment });
});

/** Runs the packaged Claude governance hook for one tool call, as Claude Code would before sending it. */
function admit(toolUseId: string, agentId?: string) {
  const hooked = spawnSync(process.execPath, [dist("governance-hook.mjs"), "--host=claude-code"], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "binding-root-session", tool_use_id: toolUseId,
      cwd: directory, transcript_path: path.join(directory, "absent.jsonl"), ...(agentId === undefined ? {} : { agent_id: agentId }),
      tool_name: `mcp__agent_governance_suite__${TOOL}`, tool_input: { decision: {} } }),
  });
  return { status: hooked.status, stdout: hooked.stdout };
}
async function call(args: Record<string, unknown>, toolUseId?: string) {
  const reply = await server().client.callTool({ name: TOOL, arguments: args, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}) });
  return JSON.parse((reply.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; data?: { callerObservation?: unknown }; error?: unknown };
}

it("refuses a call whose caller the host did not observe, naming the missing provenance", async () => {
  expect(await call({ decision: {} })).toMatchObject({ ok: false,
    error: { code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } } });
});

it("binds a root call to the host-observed session and accepts its tool-use ID once", async () => {
  expect(admit("toolu_binding_root")).toEqual({ status: 0, stdout: "" });
  expect(await call({ decision: {} }, "toolu_binding_root")).toMatchObject({ ok: true, data: { callerObservation: {
    host: "claude-code", sessionId: "binding-root-session", actorKind: "main", observedBy: "host-observed" } } });
  expect(await call({ decision: {} }, "toolu_binding_root")).toMatchObject({ ok: false,
    error: { code: "BINDING_REQUIRED", details: { ingressReason: "CALL_ADMISSION_MISSING" } } });
});

it("admits a subagent call under its parent session as a child, never as the root", async () => {
  expect(admit("toolu_binding_child", "binding-subagent")).toEqual({ status: 0, stdout: "" });
  expect(await call({ decision: {} }, "toolu_binding_child")).toMatchObject({ ok: true, data: { callerObservation: {
    host: "claude-code", sessionId: "binding-root-session", actorKind: "subagent", observedBy: "host-observed" } } });
});

it.each(["_sessionProof", "_sessionBinding", "_hostAttestation", "_continuityBinding"])(
  "refuses caller identity %s in tool arguments even for an observed call", async field => {
    const id = `toolu_binding_reserved${field}`;
    expect(admit(id)).toEqual({ status: 0, stdout: "" });
    expect(await call({ decision: {}, [field]: "caller-supplied" }, id)).toMatchObject({ ok: false,
      error: { code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field } } });
  });
