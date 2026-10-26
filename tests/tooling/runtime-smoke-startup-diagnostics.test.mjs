import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  access: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  spawnSync: vi.fn(),
  realSpawnSync: null,
}));
vi.mock("node:fs/promises", () => ({
  access: boundary.access,
  cp: boundary.cp,
  mkdir: boundary.mkdir,
  mkdtemp: boundary.mkdtemp,
  rm: boundary.rm,
  writeFile: boundary.writeFile,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  boundary.realSpawnSync = actual.spawnSync;
  return {
    ...actual,
    spawnSync: boundary.spawnSync,
  };
});

import { failureContext } from "../../runtime/failure-diagnostics.mjs";
import { SKILL_RUNTIME_ENTRYPOINTS } from "../../scripts/runtime-entrypoints.mjs";
import { runRuntimeSmokeCheck } from "../../scripts/runtime-smoke.mjs";

const cleanRoot = path.join(tmpdir(), "agent-governance-runtime-startup-diagnostics-fixture");
const sourceRoot = "fixture-source";
const entrypointByName = new Map(SKILL_RUNTIME_ENTRYPOINTS.map((entrypoint) => [path.normalize(entrypoint.path), entrypoint]));
const MAX_SMOKE_STREAM_CHARS = 512;

function expectedStreamDescriptor(value) {
  if (typeof value !== "string") {
    return {
      type: value === null ? "null" : typeof value,
      length: 0,
      prefixCodeUnits: 0,
      truncated: false,
      encoding: "utf16le",
      prefixSha256: null,
    };
  }
  const prefix = value.slice(0, MAX_SMOKE_STREAM_CHARS);
  return {
    type: "string",
    length: value.length,
    prefixCodeUnits: prefix.length,
    truncated: prefix.length !== value.length,
    encoding: "utf16le",
    prefixSha256: createHash("sha256").update(Buffer.from(prefix, "utf16le")).digest("hex"),
  };
}

function defaultSpawnResponse(scriptPath, args, options) {
  const relative = path.relative(cleanRoot, scriptPath);
  const base = path.basename(scriptPath);
  if (base === "session-message-broker.mjs" || base === "session-message-relay.mjs") {
    return { status: 2, signal: null, stdout: "", stderr: "" };
  }
  if (base === "session-message-cli.mjs") {
    return {
      status: 1,
      signal: null,
      stdout: JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: "Unsupported session message operation." }),
      stderr: "",
    };
  }
  if (base === "session-message-hook.mjs") {
    return {
      status: 0,
      signal: null,
      stdout: "",
      stderr: `[agent-governance-suite] peer-hook-failure ${JSON.stringify({ phase: "input", reason: "INVALID_JSON" })}\n`,
    };
  }
  const skillEntry = entrypointByName.get(path.normalize(relative));
  if (skillEntry) {
    if (base === "resolve-instruction-files.mjs" && options.input !== "{}\n") {
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ ok: true, output: { verdict: "ANALYSIS_REQUIRED" } }),
        stderr: "",
      };
    }
    return {
      status: skillEntry.expectedExitCode,
      signal: null,
      stdout: `${skillEntry.outputIncludes}\n`,
      stderr: "",
    };
  }
  if (base === "continuity-hook.mjs") {
    return { status: 0, signal: null, stdout: "", stderr: "" };
  }
  if (base === "host-attestation-hook.mjs") {
    const parsed = JSON.parse(options.input);
    if (parsed.hook_event_name === "SessionStart") {
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          updatedInput: {
            ...parsed.tool_input,
            _hostAttestation: "aghs2.fixture",
          },
        },
      }),
      stderr: "",
    };
  }
  if (base === "host-wrapper.mjs") {
    return { status: 0, signal: null, stdout: "host-wrapper-fixture: ready", stderr: "" };
  }
  if (base === "session-board-hook.mjs") {
    const input = JSON.parse(options.input);
    const boardTool = input.tool_name?.endsWith("__update_session_status");
    // Synthetic CLI responses model the explicit host contract, never native evidence.
    if (args.includes("--host=codex")) {
      return { status: 0, signal: null, stdout: boardTool ? JSON.stringify({
        hookSpecificOutput: { permissionDecision: "deny" },
      }) : "", stderr: "" };
    }
    expect(args).toEqual(["--host=claude-code"]);
    if (input.hook_event_name === "UserPromptSubmit") defaultSpawnResponse.boardPromptAt = "2026-10-26T00:00:00.000Z";
    const denied = boardTool && (Object.hasOwn(input, "agent_id") || input.tool_input.summary.includes("\n"));
    if (boardTool && !denied) defaultSpawnResponse.boardSummary = input.tool_input.summary;
    return {
      status: 0,
      signal: null,
      stdout: boardTool ? JSON.stringify({ hookSpecificOutput: denied ? { permissionDecision: "deny" } : {
        updatedInput: { ...input.tool_input, _sessionBinding: { host: "claude-code", sessionId: input.session_id } },
      } }) : "",
      stderr: "",
    };
  }
  if (base === "read-board.mjs") {
    return { status: 0, signal: null, stdout: JSON.stringify({ summary: defaultSpawnResponse.boardSummary, last_prompt_at: defaultSpawnResponse.boardPromptAt }), stderr: "" };
  }
  if (base === "governance-hook.mjs") {
    const input = JSON.parse(options.input);
    expect(args).toEqual(["--host=claude-code"]);
    expect(input).toMatchObject({ hook_event_name: "PreToolUse", session_id: "clean-room-mcp-root", cwd: cleanRoot });
    expect(input).not.toHaveProperty("agent_id");
    return { status: 0, signal: null, stdout: JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input.tool_input, _sessionProof: `ags-root-v3.fixture-${input.tool_use_id}.signature` },
    } }), stderr: "" };
  }
  if (base === "server.mjs") {
    const toolCalls = String(options.input).trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "tools/call");
    expect(toolCalls.map(message => message.params.name)).toEqual(["lookup_korean_prose_terms", "validate_collaboration_decision", "get_trust_capabilities"]);
    for (const message of toolCalls) {
      expect(message.params.arguments._sessionProof).toMatch(/^ags-root-v3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
      expect(message.params.arguments).not.toHaveProperty("_sessionBinding");
    }
    const lookupEnvelope = { ok: true, data: { status: "matched", matches: [{ term: "MCP" }, { term: "SQLite" }] } };
    const validationEnvelope = {
      ok: true,
      data: {
        structuralValidity: "valid",
        receiptFound: false,
        receiptBoundToCaller: null,
        authorityCapabilities: { authorityIssuance: false },
      },
    };
    return {
      status: 0,
      signal: null,
      stdout: [
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ text: JSON.stringify(lookupEnvelope) }] } }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ text: JSON.stringify(validationEnvelope) }] } }),
        JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [{ text: JSON.stringify({ ok: true, data: {
          provenanceRecording: true, directUserInputAttestation: false, authorityIssuance: false, scopedDelegation: false,
        } }) }] } }),
      ].join("\n") + "\n",
      stderr: "",
    };
  }
  if (base === "resolve-instruction-files.mjs") {
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ok: true, output: { verdict: "ANALYSIS_REQUIRED" } }),
      stderr: "",
    };
  }
  throw new Error(`Unexpected script in fixture: ${relative} (${args.join(" ")})`);
}

function mockContinuityHook(result) {
  boundary.spawnSync.mockImplementation((_execPath, [scriptPath, ...args], options) => {
    if (path.basename(scriptPath) === "continuity-hook.mjs") {
      expect(options.timeout).toBe(10_000);
      return result;
    }
    return defaultSpawnResponse(scriptPath, args, options);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  defaultSpawnResponse.boardPromptAt = null;
  defaultSpawnResponse.boardSummary = null;
  boundary.mkdtemp.mockResolvedValue(cleanRoot);
  boundary.mkdir.mockResolvedValue(undefined);
  boundary.cp.mockResolvedValue(undefined);
  boundary.rm.mockResolvedValue(undefined);
  boundary.writeFile.mockResolvedValue(undefined);
  boundary.access.mockRejectedValue(Object.assign(new Error("Missing node_modules"), { code: "ENOENT" }));
  boundary.spawnSync.mockImplementation((_execPath, [scriptPath, ...args], options) => (
    defaultSpawnResponse(scriptPath, args, options)
  ));
});

describe("continuity-hook runtime startup smoke diagnostics", () => {
  it("spawn error: preserves closed failureContext error and stream descriptors without exposing raw code/name/cause or dumping input/env/paths", async () => {
    const hookScriptPath = path.join(cleanRoot, "mcp-server", "dist", "continuity-hook.mjs");
    const spawnError = Object.assign(new Error(`spawnSync ${process.execPath} ETIMEDOUT PRIVATE_ERROR_MARKER`), {
      code: "PRIVATE_CODE_MARKER",
      name: "PRIVATE_NAME_MARKER",
      errno: -110,
      syscall: `spawnSync ${process.execPath}`,
      path: process.execPath,
      spawnargs: [hookScriptPath, "PRIVATE_SPAWNARG_MARKER"],
    });
    mockContinuityHook({
      error: spawnError,
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });

    let failure;
    try {
      await runRuntimeSmokeCheck(sourceRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("continuity hook failed its node_modules-free startup smoke check.");
    expect(failure.message).toContain(`error=${JSON.stringify(failureContext(spawnError))}`);
    expect(failure.message).toContain("status=null");
    expect(failure.message).toContain("signal=SIGTERM");
    expect(failure.message).toContain(`stdout=${JSON.stringify(expectedStreamDescriptor(""))}`);
    expect(failure.message).toContain(`stderr=${JSON.stringify(expectedStreamDescriptor(""))}`);
    const renderedPublicOutput = `${failure.message}\n${inspect(failure)}`;
    expect(renderedPublicOutput).not.toContain("PRIVATE_ERROR_MARKER");
    expect(renderedPublicOutput).not.toContain("PRIVATE_CODE_MARKER");
    expect(renderedPublicOutput).not.toContain("PRIVATE_NAME_MARKER");
    expect(renderedPublicOutput).not.toContain("PRIVATE_SPAWNARG_MARKER");
    expect(renderedPublicOutput).not.toContain(cleanRoot);
    expect(renderedPublicOutput).not.toContain("clean-room-session");
    expect(renderedPublicOutput).not.toContain("AGENT_GOVERNANCE_CONTINUITY_DB_PATH");
    expect(failure.cause).toBeUndefined();
    expect(failureContext(failure).producerCause).toEqual(failureContext(spawnError));
    const hookCalls = boundary.spawnSync.mock.calls.filter(([, [scriptPath]]) => path.basename(scriptPath) === "continuity-hook.mjs");
    expect(hookCalls).toHaveLength(1);
  });

  it("nonzero status: preserves nonzero exit status and closed empty stream descriptors even when stderr is empty", async () => {
    mockContinuityHook({
      error: undefined,
      status: 2,
      signal: null,
      stdout: "",
      stderr: "",
    });

    let failure;
    try {
      await runRuntimeSmokeCheck(sourceRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("continuity hook failed its node_modules-free startup smoke check.");
    expect(failure.message).toContain("error=none");
    expect(failure.message).toContain("status=2");
    expect(failure.message).toContain("signal=null");
    expect(failure.message).toContain(`stdout=${JSON.stringify(expectedStreamDescriptor(""))}`);
    expect(failure.message).toContain(`stderr=${JSON.stringify(expectedStreamDescriptor(""))}`);
  });

  it("signal: preserves allowlisted termination signal and closed stderr descriptor without emitting raw stderr prefix", async () => {
    const rawStderr = "PRIVATE_STREAM_STDERR_PREFIX_MARKER terminated early\n";
    mockContinuityHook({
      error: undefined,
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: rawStderr,
    });

    let failure;
    try {
      await runRuntimeSmokeCheck(sourceRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("error=none");
    expect(failure.message).toContain("status=null");
    expect(failure.message).toContain("signal=SIGKILL");
    expect(failure.message).toContain(`stderr=${JSON.stringify(expectedStreamDescriptor(rawStderr))}`);
    const renderedPublicOutput = `${failure.message}\n${inspect(failure)}`;
    expect(renderedPublicOutput).not.toContain("PRIVATE_STREAM_STDERR_PREFIX_MARKER");
    expect(renderedPublicOutput).not.toContain("terminated early");
  });

  it("unexpected stdout: rejects non-empty stdout under the stdout-empty oracle with closed truncated length/hash descriptor and no raw stream preview", async () => {
    const noisyStdout = `PRIVATE_STREAM_STDOUT_PREFIX_MARKER ${"unexpected-stdout-".repeat(40)}TAIL_MARKER_BEYOND_BOUND`;
    mockContinuityHook({
      error: undefined,
      status: 0,
      signal: null,
      stdout: noisyStdout,
      stderr: "",
    });

    let failure;
    try {
      await runRuntimeSmokeCheck(sourceRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const descriptor = expectedStreamDescriptor(noisyStdout);
    expect(descriptor.truncated).toBe(true);
    expect(descriptor.prefixCodeUnits).toBe(MAX_SMOKE_STREAM_CHARS);
    expect(failure.message).toContain("continuity hook failed its node_modules-free startup smoke check.");
    expect(failure.message).toContain("error=none");
    expect(failure.message).toContain("status=0");
    expect(failure.message).toContain("signal=null");
    expect(failure.message).toContain(`stdout=${JSON.stringify(descriptor)}`);
    const renderedPublicOutput = `${failure.message}\n${inspect(failure)}`;
    expect(renderedPublicOutput).not.toContain("PRIVATE_STREAM_STDOUT_PREFIX_MARKER");
    expect(renderedPublicOutput).not.toContain("unexpected-stdout-");
    expect(renderedPublicOutput).not.toContain("TAIL_MARKER_BEYOND_BOUND");
  });

  it("normal empty stdout: accepts status 0 with empty stdout and completes runtime smoke check", async () => {
    mockContinuityHook({
      error: undefined,
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });

    const results = await runRuntimeSmokeCheck(sourceRoot);
    expect(results).toHaveLength(SKILL_RUNTIME_ENTRYPOINTS.length);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });

  it("cleanup secondary does not replace primary: retains both private producerCause and secondary rm failure without public cause or raw code exposure", async () => {
    const spawnError = Object.assign(new Error("spawn EPERM PRIVATE_PRIMARY_MARKER"), { code: "EPERM" });
    const cleanupError = Object.assign(new Error("EBUSY cleanup failure PRIVATE_CLEANUP_MARKER"), { code: "EBUSY" });
    mockContinuityHook({
      error: spawnError,
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
    });
    boundary.rm.mockRejectedValueOnce(cleanupError);

    let failure;
    try {
      await runRuntimeSmokeCheck(sourceRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(cleanupError);
    expect(failure.message).toContain("continuity hook failed its node_modules-free startup smoke check.");
    expect(failure.message).toContain(`error=${JSON.stringify(failureContext(spawnError))}`);
    const renderedPublicOutput = `${failure.message}\n${inspect(failure)}`;
    expect(renderedPublicOutput).not.toContain("PRIVATE_PRIMARY_MARKER");
    expect(renderedPublicOutput).not.toContain("PRIVATE_CLEANUP_MARKER");
    expect(failure.cause).toBeUndefined();
    expect(failureContext(failure).producerCause).toEqual(failureContext(spawnError));
    expect(failureContext(failure).secondary).toEqual([failureContext(cleanupError)]);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });

  it("real uncaught Node child boundary: emits only closed descriptors on top-level uncaught failure without leaking stream-start PRIVATE_STREAM/PATH/INPUT/ENV or raw cause", () => {
    const rawStdout = "PRIVATE_STREAM_STDOUT_START /private/PRIVATE_PATH_MARKER PRIVATE_INPUT_MARKER PRIVATE_ENV_MARKER\n";
    const rawStderr = "PRIVATE_STREAM_STDERR_START /private/PRIVATE_PATH_MARKER PRIVATE_INPUT_MARKER PRIVATE_ENV_MARKER\n";
    const expectedOutDesc = expectedStreamDescriptor(rawStdout);
    const expectedErrDesc = expectedStreamDescriptor(rawStderr);

    const childScript = `
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      import path from "node:path";

      const smokeUrl = pathToFileURL(path.resolve("scripts/runtime-smoke.mjs")).href;
      const entrypointsUrl = pathToFileURL(path.resolve("scripts/runtime-entrypoints.mjs")).href;

      registerHooks({
        load(url, context, nextLoad) {
          if (url === entrypointsUrl) {
            return { format: "module", shortCircuit: true, source: "export const SKILL_RUNTIME_ENTRYPOINTS = [];" };
          }
          if (url === "node:fs/promises") {
            return {
              format: "module",
              shortCircuit: true,
              source: [
                'export async function access() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }',
                'export async function cp() {}',
                'export async function mkdir() {}',
                'export async function mkdtemp() { return "/private/PRIVATE_PATH_MARKER/clean-room"; }',
                'export async function rm() {}',
                'export async function writeFile() {}',
              ].join("\\n"),
            };
          }
          if (url === "node:child_process") {
            return {
              format: "module",
              shortCircuit: true,
              source: [
                'export function spawnSync(_exec, [scriptPath]) {',
                '  if (scriptPath.endsWith("session-message-broker.mjs") || scriptPath.endsWith("session-message-relay.mjs")) {',
                '    return { status: 2, signal: null, stdout: "", stderr: "" };',
                '  }',
                '  if (scriptPath.endsWith("session-message-cli.mjs")) {',
                '    return { status: 1, signal: null, stdout: JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: "Unsupported session message operation." }), stderr: "" };',
                '  }',
                '  if (scriptPath.endsWith("session-message-hook.mjs")) {',
                '    return { status: 0, signal: null, stdout: "", stderr: "[agent-governance-suite] peer-hook-failure " + JSON.stringify({ phase: "input", reason: "INVALID_JSON" }) + "\\\\n" };',
                '  }',
                '  if (scriptPath.endsWith("continuity-hook.mjs")) {',
                '    const err = Object.assign(new Error("spawnSync PRIVATE_CAUSE_MARKER /private/PRIVATE_PATH_MARKER PRIVATE_INPUT_MARKER PRIVATE_ENV_MARKER"), {',
                '      code: "PRIVATE_CODE_MARKER",',
                '      name: "PRIVATE_NAME_MARKER",',
                '      path: "/private/PRIVATE_PATH_MARKER",',
                '      spawnargs: ["PRIVATE_INPUT_MARKER", "PRIVATE_ENV_MARKER"],',
                '    });',
                '    return {',
                '      error: err,',
                '      status: 1,',
                '      signal: "PRIVATE_SIGNAL_MARKER",',
                '      stdout: "PRIVATE_STREAM_STDOUT_START /private/PRIVATE_PATH_MARKER PRIVATE_INPUT_MARKER PRIVATE_ENV_MARKER\\\\n",',
                '      stderr: "PRIVATE_STREAM_STDERR_START /private/PRIVATE_PATH_MARKER PRIVATE_INPUT_MARKER PRIVATE_ENV_MARKER\\\\n",',
                '    };',
                '  }',
                '  return { status: 0, signal: null, stdout: "", stderr: "" };',
                '}',
              ].join("\\n"),
            };
          }
          return nextLoad(url, context);
        },
      });

      const { runRuntimeSmokeCheck } = await import(smokeUrl);
      await runRuntimeSmokeCheck("fixture-source");
    `;

    const child = boundary.realSpawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const publicOutput = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    expect(publicOutput).toContain("continuity hook failed its node_modules-free startup smoke check.");
    expect(publicOutput).not.toContain("PRIVATE_STREAM");
    expect(publicOutput).not.toContain("PRIVATE_PATH_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_INPUT_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_ENV_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_CAUSE_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_CODE_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_NAME_MARKER");
    expect(publicOutput).not.toContain("PRIVATE_SIGNAL_MARKER");
    expect(publicOutput).toContain(`stdout=${JSON.stringify(expectedOutDesc)}`);
    expect(publicOutput).toContain(`stderr=${JSON.stringify(expectedErrDesc)}`);
  });
});

describe("runtime smoke synthetic actor and proof fixture contracts", () => {
  it("runs explicit Claude positives and unsupported Codex negatives inside the same dependency-free clean room", async () => {
    await runRuntimeSmokeCheck(sourceRoot);
    const calls = boundary.spawnSync.mock.calls;
    const governance = calls.filter(([, [script]]) => path.basename(script) === "governance-hook.mjs");
    const server = calls.filter(([, [script]]) => path.basename(script) === "server.mjs");
    expect(governance).toHaveLength(3);
    expect(server).toHaveLength(1);
    expect(boundary.cp).toHaveBeenCalledWith(
      path.join(sourceRoot, "mcp-server", "dist", "governance-hook.mjs"),
      path.join(cleanRoot, "mcp-server", "dist", "governance-hook.mjs"),
    );
    for (const [executable, [script], options] of governance) {
      expect(executable).toBe(process.execPath);
      expect(script).toBe(path.join(cleanRoot, "mcp-server", "dist", "governance-hook.mjs"));
      expect(options).toMatchObject({ cwd: cleanRoot, timeout: 10_000, windowsHide: true, env: {
        AGENT_GOVERNANCE_DB_PATH: path.join(cleanRoot, "state", "workflows.sqlite3"),
        AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(cleanRoot, "state", "continuity.sqlite3"),
      } });
      expect(options.env).not.toHaveProperty("NODE_OPTIONS");
      expect(options.env).not.toHaveProperty("NODE_PATH");
      expect(options.env).not.toHaveProperty("AGENT_GOVERNANCE_ROOT");
    }
    const issued = governance.map(([, , options]) => JSON.parse(options.input));
    expect(issued.map(input => input.tool_use_id)).toEqual([
      "clean-room-mcp-call-1", "clean-room-mcp-call-2", "clean-room-mcp-call-3",
    ]);
    const outgoing = server[0][2].input.trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "tools/call");
    for (let index = 0; index < issued.length; index++) {
      const { _sessionProof, ...args } = outgoing[index].params.arguments;
      expect(outgoing[index].params.name).toBe(issued[index].tool_name.replace("mcp__agent_governance_suite__", ""));
      expect(args).toEqual(issued[index].tool_input);
      expect(_sessionProof).toBe(`ags-root-v3.fixture-${issued[index].tool_use_id}.signature`);
    }
    const boardCalls = calls.filter(([, [script]]) => path.basename(script) === "session-board-hook.mjs");
    expect(boardCalls.slice(0, 2).map(([, [, ...args]]) => args)).toEqual([["--host=codex"], ["--host=codex"]]);
    for (const [, [, ...args]] of boardCalls.slice(2)) expect(args).toEqual(["--host=claude-code"]);
    expect(boundary.access).toHaveBeenCalledWith(path.join(cleanRoot, "state", "session-board.sqlite3"));
    expect(boundary.access).toHaveBeenCalledWith(path.join(cleanRoot, "node_modules"));
    const boardReadSource = boundary.writeFile.mock.calls.find(([file]) => path.basename(file) === "read-board.mjs")[1];
    expect(boardReadSource).toContain('.get("claude-code", "clean-room-board")');
    expect(boardReadSource).not.toContain('.get("codex",');
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });

  it.each([
    ["spawn error", response => ({ ...response, error: Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" }) }), "governance hook failed its clean-room root proof issuance."],
    ["nonzero exit", response => ({ ...response, status: 2 }), "governance hook failed its clean-room root proof issuance."],
    ["empty stdout", response => ({ ...response, stdout: "" }), "governance hook failed its clean-room root proof issuance."],
    ["malformed JSON", response => ({ ...response, stdout: "{" }), "governance hook returned malformed clean-room JSON."],
    ["missing proof", response => {
      const value = JSON.parse(response.stdout);
      delete value.hookSpecificOutput.updatedInput._sessionProof;
      return { ...response, stdout: JSON.stringify(value) };
    }, "governance hook did not issue a clean-room root proof."],
    ["deny output", response => {
      const value = JSON.parse(response.stdout);
      value.hookSpecificOutput.permissionDecision = "deny";
      return { ...response, stdout: JSON.stringify(value) };
    }, "governance hook did not issue a clean-room root proof."],
    ["caller binding", response => {
      const value = JSON.parse(response.stdout);
      value.hookSpecificOutput.updatedInput._sessionBinding = { host: "forged", sessionId: "forged" };
      return { ...response, stdout: JSON.stringify(value) };
    }, "governance hook did not issue a clean-room root proof."],
    ["malformed proof token", response => {
      const value = JSON.parse(response.stdout);
      value.hookSpecificOutput.updatedInput._sessionProof = "not-a-proof";
      return { ...response, stdout: JSON.stringify(value) };
    }, "governance hook did not issue a clean-room root proof."],
    ["altered tool arguments", response => {
      const value = JSON.parse(response.stdout);
      value.hookSpecificOutput.updatedInput.changed = true;
      return { ...response, stdout: JSON.stringify(value) };
    }, "governance hook changed clean-room tool arguments."],
  ])("rejects governance CLI %s before sending any MCP call", async (_label, change, expectedMessage) => {
    boundary.spawnSync.mockImplementation((_executable, [script, ...args], options) => {
      const response = defaultSpawnResponse(script, args, options);
      return path.basename(script) === "governance-hook.mjs" ? change(response) : response;
    });
    await expect(runRuntimeSmokeCheck(sourceRoot)).rejects.toThrow(expectedMessage);
    expect(boundary.spawnSync.mock.calls.filter(([, [script]]) => path.basename(script) === "governance-hook.mjs")).toHaveLength(1);
    expect(boundary.spawnSync.mock.calls.filter(([, [script]]) => path.basename(script) === "server.mjs")).toHaveLength(0);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });

  it("does not replace the unsupported Codex denial with a successful caller binding", async () => {
    boundary.spawnSync.mockImplementation((_executable, [script, ...args], options) => {
      if (path.basename(script) === "session-board-hook.mjs" && args.includes("--host=codex")
        && JSON.parse(options.input).hook_event_name === "PreToolUse") {
        return { status: 0, signal: null, stdout: JSON.stringify({ hookSpecificOutput: {
          updatedInput: { _sessionBinding: { host: "codex", sessionId: "forged" } },
        } }), stderr: "" };
      }
      return defaultSpawnResponse(script, args, options);
    });
    await expect(runRuntimeSmokeCheck(sourceRoot)).rejects.toThrow("session board hook accepted unsupported Codex actor input.");
    expect(boundary.spawnSync.mock.calls.filter(([, [script]]) => path.basename(script) === "governance-hook.mjs")).toHaveLength(0);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });

  it("rejects board state created by unsupported input before starting Claude positive fixtures", async () => {
    const boardPath = path.join(cleanRoot, "state", "session-board.sqlite3");
    boundary.access.mockImplementation(async target => {
      if (target === boardPath) return;
      throw Object.assign(new Error("synthetic missing dependency"), { code: "ENOENT" });
    });
    await expect(runRuntimeSmokeCheck(sourceRoot)).rejects.toThrow(`Clean-room dependency leak: ${boardPath} exists.`);
    const boardCalls = boundary.spawnSync.mock.calls.filter(([, [script]]) => path.basename(script) === "session-board-hook.mjs");
    expect(boardCalls).toHaveLength(2);
    for (const [, [, ...args]] of boardCalls) expect(args).toEqual(["--host=codex"]);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
  });
});
