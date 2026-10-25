import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-hook-host-contract-"));
  directories.push(directory);
  const database = path.join(directory, "workflow.sqlite3");
  return { directory, database, env: { ...process.env,
    AGENT_GOVERNANCE_DB_PATH: database,
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messaging"),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
    AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "0", AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE: "0",
  } };
}

// All public hook CLIs retain exit 0; bounded diagnostics distinguish a failed run.
function hook(bundle: string, args: string[], input: Record<string, unknown>, environment: NodeJS.ProcessEnv): { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } } {
  const result = spawnSync(process.execPath, [path.join(root, "mcp-server/dist", bundle + ".mjs"), ...args], {
    input: JSON.stringify(input), env: environment, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() ? JSON.parse(result.stdout) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } } : {};
}

function attestationInput(directory: string) {
  const transcript = path.join(directory, "synthetic-claude.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId: "host-contract-session", isSidechain: false,
    effort: "high", message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "host-contract-call", name: "plan_workflow", input: {} }] } }) + "\n", "utf8");
  return { hook_event_name: "PreToolUse", session_id: "host-contract-session", tool_use_id: "host-contract-call",
    transcript_path: transcript, tool_name: "mcp__agent_governance_suite__plan_workflow", effort: { level: "high" },
    modelName: "claude-opus-5", stepIdx: 17,
    tool_input: { schemaVersion: "1.0.0", taskId: "host-contract-task", marker: "preserve",
      _hostAttestation: "caller-token", _hostSkillObservation: { caller: true } } };
}

describe("explicit hook CLI host contract (synthetic packaged fixtures, not native-host evidence)", () => {
  it.each([{ args: [] }, { args: ["--host=claude-code"] }])("preserves the Claude attestation entry default and explicit form ($args)", ({ args }) => {
    const f = fixture();
    const output = hook("host-attestation-hook", args, attestationInput(f.directory), f.env);
    expect(output.hookSpecificOutput!.updatedInput!._hostAttestation).toEqual(expect.any(String));
    expect(output.hookSpecificOutput!.updatedInput!._hostAttestation).not.toBe("caller-token");
    expect(output.hookSpecificOutput!.updatedInput!.marker).toBe("preserve");
  });

  it.each([{ args: ["--host=gemini"] }, { args: ["--host", "gemini"] }])("never interprets Gemini caller fields as a Claude observation ($args)", ({ args }) => {
    const f = fixture();
    const output = hook("host-attestation-hook", args, attestationInput(f.directory), f.env);
    expect(output.hookSpecificOutput!.updatedInput!).toEqual({ schemaVersion: "1.0.0", taskId: "host-contract-task", marker: "preserve" });
    expect(existsSync(f.database)).toBe(false);
    const started = hook("host-attestation-hook", args, { hook_event_name: "SessionStart", session_id: "host-contract-session", model: "claude-opus-5" }, f.env);
    expect(started).toEqual({});
    expect(existsSync(path.join(f.directory, "host-models"))).toBe(false);
  });

  for (const bundle of ["session-message-hook", "session-board-hook"]) {
    it.each([{ args: [], host: "codex" }, { args: ["--host=codex"], host: "codex" },
      { args: ["--host=claude-code"], host: "claude-code" }, { args: ["--host=gemini"], host: "gemini" },
      { args: ["--host", "gemini"], host: "gemini" }])(
      bundle + " binds the selected host while retaining its default ($host/$args)", ({ args, host }) => {
        const f = fixture();
        const tool = bundle === "session-message-hook" ? "prepare_session_message" : "list_session_status";
        const output = hook(bundle, args, { hook_event_name: "PreToolUse", session_id: "host-contract-session", agent_id: "",
          tool_name: "mcp__agent_governance_suite__" + tool,
          tool_input: { schemaVersion: "1.0.0", marker: "preserve", _sessionBinding: { host: "wrong", sessionId: "wrong" } } }, f.env);
        expect(output.hookSpecificOutput!.updatedInput!).toEqual({ schemaVersion: "1.0.0", marker: "preserve",
          _sessionBinding: { host, sessionId: "host-contract-session" } });
      });
  }

  it.each([{ args: ["--host="] }, { args: ["--host=../invalid"] }, { args: ["--host=gemini", "--host=codex"] }, { args: ["--host", ""] }])(
    "does not fall back to another host for an invalid explicit selection ($args)", ({ args }) => {
      const f = fixture();
      const input = attestationInput(f.directory);
      for (const bundle of ["host-attestation-hook", "session-message-hook", "session-board-hook"]) {
        const tool = bundle === "host-attestation-hook" ? "plan_workflow" : bundle === "session-message-hook" ? "prepare_session_message" : "list_session_status";
        const output = hook(bundle, args, { ...input, tool_name: "mcp__agent_governance_suite__" + tool }, f.env);
        const updated = output.hookSpecificOutput?.updatedInput;
        expect(updated?._hostAttestation).toBeUndefined();
        expect(updated?._sessionBinding).toBeUndefined();
      }
      expect(existsSync(f.database)).toBe(false);
      expect(existsSync(path.join(f.directory, "board.sqlite3"))).toBe(false);
    }, 20_000);
});

// A syntactically valid opaque identifier cannot borrow a configured observation or transport.
it("does not treat an unknown host as Claude attestation or Codex delivery", () => {
  const f = fixture();
  const input = attestationInput(f.directory);
  for (const bundle of ["host-attestation-hook", "session-message-hook"]) {
    const output = hook(bundle, ["--host=unregistered-host"], input, f.env);
    expect(output.hookSpecificOutput?.updatedInput?._hostAttestation).toBeUndefined();
    expect(output.hookSpecificOutput?.updatedInput?._sessionBinding).toBeUndefined();
  }
  expect(existsSync(f.database)).toBe(false);
});

it("reports a closed stdout pipe once without retrying or failing the hook process", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-hook.mjs")], {
    env: f.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic += chunk.toString(); });
  child.stdout.destroy();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "stdout-synthetic-session", agent_id: "",
    tool_name: "mcp__agent_governance_suite__prepare_session_message",
    tool_input: { schemaVersion: "1.0.0", marker: "secret-canary-output" } }));
  // Fail-open (exit 0, no retry, no crash); the failed stdout stage remains visible in its diagnostic.
  expect(await closed).toBe(0);
  expect(diagnostic.match(/"phase":"stdout"/gu)).toHaveLength(1);
  expect(diagnostic).not.toContain("secret-canary-output");
  expect(diagnostic).not.toContain("stdout-synthetic-session");
}, 15_000);

it("distinguishes a missing host adapter from an unexpected hook failure without leaking input", () => {
  const f = fixture();
  const result = spawnSync(process.execPath,
    [path.join(root, "mcp-server/dist/session-message-hook.mjs"), "--host=unregistered-host"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "adapter-failure-session", agent_id: "",
        tool_name: "mcp__agent_governance_suite__prepare_session_message",
        tool_input: { schemaVersion: "1.0.0", marker: "adapter-secret-canary" } }),
      env: { ...f.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
    });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('"phase":"handle","reason":"HOST_ADAPTER_UNAVAILABLE"');
  expect(result.stderr).not.toContain("UNEXPECTED_FAILURE");
  expect(result.stderr).not.toContain("adapter-secret-canary");
  expect(result.stderr).not.toContain("adapter-failure-session");
  expect(existsSync(f.database)).toBe(false);
});

it.each(["empty", "input", "stdin", "broker"] as const)(
  "public message hook keeps exit 0 and distinguishes the %s path with bounded diagnostics", (scenario) => {
    const f = fixture();
    const args = [path.join(root, "mcp-server/dist/session-message-hook.mjs"), "--host=claude-code"];
    let input = "{}";
    if (scenario === "input") input = "{\n";
    if (scenario === "stdin") {
      const preload = path.join(f.directory, "stdin-failure.mjs");
      writeFileSync(preload, [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const original = fs.readFileSync;",
        'fs.readFileSync = (file, ...rest) => { if (file === 0) throw Object.assign(new Error("PRIVATE_STDIN_MESSAGE"), { code: "EIO" }); return original(file, ...rest); };',
        "syncBuiltinESMExports();",
      ].join("\n"), "utf8");
      args.unshift("--import", pathToFileURL(preload).href);
    }
    if (scenario === "broker") {
      // The client fails state-directory preparation before any broker process or DB can start.
      writeFileSync(f.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR, "PRIVATE_STATE_FILE");
      input = JSON.stringify({ hook_event_name: "Stop", session_id: "PRIVATE_SESSION", agent_id: "" });
    }
    const result = spawnSync(process.execPath, args, {
      input, env: { ...f.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const prefix = "[agent-governance-suite] peer-hook-failure ";
    const diagnostics = result.stderr.split(/\r?\n/u).filter(line => line.startsWith(prefix))
      .map(line => JSON.parse(line.slice(prefix.length)));
    if (scenario === "empty") expect(diagnostics).toEqual([]);
    else {
      const [phase, reason] = scenario === "broker" ? ["handle", "BROKER_STATE_DIRECTORY_FAILED"]
        : scenario === "stdin" ? ["stdin", "EIO"] : ["input", "INVALID_JSON"];
      expect(diagnostics).toEqual([expect.objectContaining({ phase, reason })]);
    }
    for (const secret of ["PRIVATE_STDIN_MESSAGE", "PRIVATE_STATE_FILE", "PRIVATE_SESSION", f.directory]) {
      expect(result.stderr).not.toContain(secret);
    }
    expect(existsSync(f.database)).toBe(false);
  }, 15_000);

describe("L3 packaged failure diagnostics", () => {
  it("reports the host selection producer reason in every CLI without leaking input or touching state", () => {
    const f = fixture();
    for (const bundle of ["session-message-hook", "host-attestation-hook", "session-board-hook"]) {
      const result = spawnSync(process.execPath, [path.join(root, "mcp-server/dist", bundle + ".mjs"), "--host=../private-host-marker"], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "private-session-marker", agent_id: "",
          tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { marker: "private-tool-marker" } }),
        env: { ...f.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      expect(result.stderr).toContain('"phase":"host-entry","reason":"INVALID_HOOK_HOST_SELECTION"');
      expect(result.stderr).toContain('"context":');
      for (const marker of ["private-host-marker", "private-session-marker", "private-tool-marker"])
        expect(result.stderr).not.toContain(marker);
      expect(result.stdout).not.toContain("_hostAttestation"); expect(result.stdout).not.toContain("_sessionBinding");
      expect(existsSync(f.database)).toBe(false); expect(existsSync(path.join(f.directory, "board.sqlite3"))).toBe(false);
    }
  });
  it.each(["callback-and-event", "throw", "event"])("reports board stdout %s once without leaking the error", (mode) => {
    const f = fixture();
    const preload = path.join(f.directory, "stdout-failure.mjs");
    writeFileSync(preload, [
      'const failure = Object.assign(new Error("private-stdout-message"), { code: "EPIPE" });',
      'process.stdout.write = (_chunk, callback) => {',
      mode === "throw" ? "throw failure;" :
        mode === "callback-and-event" ? 'callback(failure); process.nextTick(() => process.stdout.emit("error", failure)); return false;' :
          'process.nextTick(() => process.stdout.emit("error", failure)); return false;',
      "};",
    ].join("\n"), "utf8");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href,
      path.join(root, "mcp-server/dist/session-board-hook.mjs"), "--host=codex"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "stdout-fixture", agent_id: "",
        tool_name: "mcp__agent_governance_suite__update_session_status",
        tool_input: { schemaVersion: "1.0.0", summary: "source fixture only" } }),
      env: { ...f.env, NODE_NO_WARNINGS: "1" }, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stderr.split("\n").filter((line) => line.includes('"phase":"stdout"'))).toHaveLength(1);
    expect(result.stderr).not.toContain("private-stdout-message");
  });
});
