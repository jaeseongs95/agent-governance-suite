import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { failureContext, retainFailureCause, retainFailureSecondary } from "../runtime/failure-diagnostics.mjs";
import { SKILL_RUNTIME_ENTRYPOINTS } from "./runtime-entrypoints.mjs";

const MESSAGING_RUNTIME_PROBES = [
  { bundle: "session-message-relay.mjs", expectedExitCode: 2, stdout: "" },
  { bundle: "session-message-cli.mjs", expectedExitCode: 1 },
  { bundle: "session-message-hook.mjs", expectedExitCode: 0, stdout: "", input: "{\n", stderrDiagnostic: { phase: "input", reason: "INVALID_JSON" } },
];

const MAX_SMOKE_STREAM_CHARS = 512;
const SAFE_POSIX_SIGNALS = new Set([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL",
  "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR",
  "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP",
  "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1", "SIGUSR2",
  "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGINFO", "SIGLOST",
]);

function formatBoundedStream(value) {
  if (typeof value !== "string") {
    return JSON.stringify({
      type: value === null ? "null" : typeof value,
      length: 0,
      prefixCodeUnits: 0,
      truncated: false,
      encoding: "utf16le",
      prefixSha256: null,
    });
  }
  const prefix = value.slice(0, MAX_SMOKE_STREAM_CHARS);
  return JSON.stringify({
    type: "string",
    length: value.length,
    prefixCodeUnits: prefix.length,
    truncated: prefix.length !== value.length,
    encoding: "utf16le",
    prefixSha256: createHash("sha256").update(Buffer.from(prefix, "utf16le")).digest("hex"),
  });
}

function formatContinuityHookFailure(result) {
  const errorToken = result.error ? JSON.stringify(failureContext(result.error)) : "none";
  const statusToken = Number.isInteger(result.status) ? String(result.status) : "null";
  const signalToken = typeof result.signal === "string" && SAFE_POSIX_SIGNALS.has(result.signal) ? result.signal : "null";
  const elapsedToken = Number.isInteger(result.elapsedMs) ? String(result.elapsedMs) : "null";
  const limitToken = Number.isInteger(result.limitMs) ? String(result.limitMs) : "null";
  return `error=${errorToken} status=${statusToken} signal=${signalToken} stdout=${formatBoundedStream(result.stdout)} stderr=${formatBoundedStream(result.stderr)}`
    + ` elapsedMs=${elapsedToken} limitMs=${limitToken} earlierChildren=${JSON.stringify(result.earlierChildren ?? null)}`;
}

// Wall times of the clean-room children run before this one. A timeout then shows whether every child was slow (a slow
// machine) or only this one (AGS3-D-0014: a 10s SessionStart timeout left no other observation).
function summarizeElapsed(elapsed) {
  if (elapsed.length === 0) return { count: 0 };
  const sorted = [...elapsed].sort((left, right) => left - right);
  return { count: sorted.length, medianMs: sorted[Math.floor((sorted.length - 1) / 2)], maxMs: sorted.at(-1) };
}

// A host stops a hook at the timeout its manifest declares, so the hook check runs under that same limit. The codex
// manifest of this checkout starts the bundle exactly as the smoke does (AGS3-D-0014: a 30s limit raised without a
// cause let the check pass a hook that the host would have stopped at 10s).
function declaredHookTimeoutMs(event, bundle) {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "hooks", "hooks.json"), "utf8"));
  const timeouts = new Set((manifest.hooks?.[event] ?? []).flatMap(group => group.hooks ?? [])
    .filter(hook => typeof hook.command === "string" && hook.command.includes(`/mcp-server/dist/${bundle}`))
    .map(hook => hook.timeout));
  const [seconds] = timeouts;
  if (timeouts.size !== 1 || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`hooks/hooks.json must declare one positive timeout for ${bundle} on ${event}.`);
  }
  return seconds * 1000;
}

async function assertMissing(target) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Clean-room dependency leak: ${target} exists.`);
}

async function removeRuntimeCleanRoom(cleanRoot, primaryFailure) {
  try {
    await rm(cleanRoot, { recursive: true, force: true });
  } catch (error) {
    if (primaryFailure === null) throw error;
    retainFailureSecondary(primaryFailure.error, error);
  }
}

export async function runRuntimeSmokeCheck(sourceRoot) {
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "agent-governance-runtime-"));
  let primaryFailure = null;
  try {
    await mkdir(path.join(cleanRoot, "mcp-server", "dist"), { recursive: true });
    const copies = await Promise.allSettled([
      ...["contracts", "runtime", "skills"].map((directory) => cp(path.join(sourceRoot, directory), path.join(cleanRoot, directory), { recursive: true })),
      ...["server.mjs", "continuity-hook.mjs", "host-attestation-hook.mjs", "session-board-hook.mjs", "governance-hook.mjs", ...MESSAGING_RUNTIME_PROBES.map(({ bundle }) => bundle)].map((bundle) => (
        cp(path.join(sourceRoot, "mcp-server", "dist", bundle), path.join(cleanRoot, "mcp-server", "dist", bundle))
      )),
    ]);
    const failedCopy = copies.find(copy => copy.status === "rejected");
    if (failedCopy) throw failedCopy.reason;
    await assertMissing(path.join(cleanRoot, "node_modules"));

    const environment = { ...process.env };
    delete environment.AGENT_GOVERNANCE_ROOT;
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG;
    delete environment.AGENT_GOVERNANCE_HOST_ATTESTATION;
    environment.SKILL_REGISTRY_PATH = path.join(cleanRoot, "skills", "registry.json");
    environment.AGENT_GOVERNANCE_SHARED_STATE_DIR = path.join(cleanRoot, "state");
    environment.PLUGIN_DATA = path.join(cleanRoot, "state");
    environment.AGENT_GOVERNANCE_DB_PATH = path.join(cleanRoot, "state", "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = path.join(cleanRoot, "state", "continuity.sqlite3");
    environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = path.join(cleanRoot, "state", "session-board.sqlite3");
    environment.AGENT_GOVERNANCE_TRUST_DB_PATH = path.join(cleanRoot, "state", "trust.sqlite3");
    environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = path.join(cleanRoot, "state", "messaging");
    // Runs a clean-room script (a path relative to the clean root) with the given stdin text.
    const childElapsedMs = [];
    // Children without a host limit get 30s only so that a hung child cannot hang the smoke.
    const runNode = (script, input, args = [], env = environment, timeout = 30_000) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [path.join(cleanRoot, ...script.split("/")), ...args], {
        cwd: cleanRoot,
        encoding: "utf8",
        env,
        input,
        maxBuffer: 5 * 1024 * 1024,
        timeout,
        windowsHide: true,
      });
      const elapsedMs = Math.round(performance.now() - started);
      const earlierChildren = summarizeElapsed(childElapsedMs);
      childElapsedMs.push(elapsedMs);
      return Object.assign(result, { elapsedMs, limitMs: timeout, earlierChildren });
    };

    // Missing arguments/operation validate startup without starting a broker or relay.
    for (const probe of MESSAGING_RUNTIME_PROBES) {
      const script = `mcp-server/dist/${probe.bundle}`;
      const result = runNode(script, probe.input ?? "{}\n");
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.error || result.status !== probe.expectedExitCode
        || /ERR_MODULE_NOT_FOUND|Cannot find package/u.test(output)) {
        throw new Error(`${script} failed its node_modules-free messaging startup check.\n${result.error?.message ?? output}`);
      }
      if (probe.stdout !== undefined) {
        if (result.stdout !== probe.stdout) throw new Error(`${script} emitted unexpected startup output.\n${output}`);
      } else {
        const envelope = JSON.parse(result.stdout);
        if (envelope?.protocolVersion !== "1.0.0" || envelope.ok !== false
          // The text is in the model locale; the key is the language-independent contract.
          || envelope.messageKey !== "services.sessionMessage.cli.unsupportedOperation" || typeof envelope.error !== "string") {
          throw new Error(`${script} did not reject invalid messaging input.\n${output}`);
        }
      }
      if (probe.stderrDiagnostic) {
        const hasDiagnostic = String(result.stderr ?? "").split(/\r?\n/u).some(line => {
          try {
            const diagnostic = JSON.parse(line);
            return diagnostic?.component === "session-message-hook" && diagnostic?.event === "peer-hook-failure"
              && diagnostic?.phase === probe.stderrDiagnostic.phase && diagnostic?.reason === probe.stderrDiagnostic.reason;
          } catch { return false; }
        });
        if (!hasDiagnostic) {
          throw new Error(`${script} did not emit its invalid-JSON input diagnostic.\n${output}`);
        }
      }
    }

    const results = [];
    // Expected output is a code or a model-locale (en) sentence: the default environment already renders English, so the
    // probe runs in it unchanged.
    for (const entrypoint of SKILL_RUNTIME_ENTRYPOINTS) {
      const result = runNode(entrypoint.path, "{}\n", [], environment);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (result.error) {
        throw new Error(`${entrypoint.path} could not run in the clean room: ${result.error.message}`);
      }
      if (result.status !== entrypoint.expectedExitCode) {
        throw new Error(`${entrypoint.path} exited ${result.status}; expected ${entrypoint.expectedExitCode}.\n${output}`);
      }
      if (!output.includes(entrypoint.outputIncludes)) {
        throw new Error(`${entrypoint.path} did not emit ${JSON.stringify(entrypoint.outputIncludes)}.\n${output}`);
      }
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/u.test(output)) {
        throw new Error(`${entrypoint.path} leaked an unbundled runtime dependency.\n${output}`);
      }
      results.push({ path: entrypoint.path, exitCode: result.status });
    }

    const hookResult = runNode(
      "mcp-server/dist/continuity-hook.mjs",
      `${JSON.stringify({ hook_event_name: "SessionStart", session_id: "clean-room-session", source: "startup" })}\n`,
      [], environment, declaredHookTimeoutMs("SessionStart", "continuity-hook.mjs"),
    );
    if (hookResult.error || hookResult.status !== 0 || hookResult.stdout !== "") {
      const failure = new Error(`continuity hook failed its node_modules-free startup smoke check.\n${formatContinuityHookFailure(hookResult)}`);
      if (hookResult.error) retainFailureCause(failure, hookResult.error);
      throw failure;
    }

    const transcriptPath = path.join(cleanRoot, "state", "transcript.jsonl");
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({
      type: "assistant",
      sessionId: "clean-room-session",
      isSidechain: false,
      effort: "high",
      message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "toolu_clean_room", name: "plan_workflow", input: {} }] },
    })}\n`, "utf8");
    const attestationInput = {
      hook_event_name: "PreToolUse",
      session_id: "clean-room-session",
      transcript_path: transcriptPath,
      tool_name: "mcp__plugin_agent-governance-suite_agent-governance-suite__plan_workflow",
      tool_use_id: "toolu_clean_room",
      tool_input: { taskId: "clean-room-task" },
      effort: { level: "high" },
    };
    // The Claude governance hook records the call under its tool-use ID and prints nothing; it never rewrites arguments.
    const runGovernanceHook = (input) => runNode("mcp-server/dist/governance-hook.mjs", `${JSON.stringify(input)}\n`, ["--host=claude-code"]);
    const admitted = runGovernanceHook(attestationInput);
    if (admitted.error || admitted.status !== 0 || admitted.stdout !== "") {
      throw new Error(`governance hook failed its node_modules-free admission smoke check.\n${admitted.stderr ?? ""}`);
    }
    // Interactive sessions: the issuing message is not in the transcript yet, so the SessionStart model is used.
    const sessionStart = runNode("mcp-server/dist/host-attestation-hook.mjs", `${JSON.stringify({ hook_event_name: "SessionStart", session_id: "clean-room-interactive", source: "startup", model: "claude-opus-5" })}\n`);
    const interactive = runGovernanceHook({ ...attestationInput, session_id: "clean-room-interactive", tool_use_id: "toolu_not_written_yet" });
    if (sessionStart.error || sessionStart.status !== 0 || sessionStart.stdout !== ""
      || interactive.error || interactive.status !== 0 || interactive.stdout !== "") {
      throw new Error(`governance hook failed its interactive-session smoke check.\n${sessionStart.stderr ?? ""}${interactive.stderr ?? ""}`);
    }

    // The board hook records only a main prompt's time and directory; it never binds, gates or denies a tool.
    // Synthetic Claude hook input exercises storage; it is not native capture evidence.
    const boardInput = { session_id: "clean-room-board", cwd: cleanRoot };
    const runBoardHook = (input, host = "claude-code") => runNode("mcp-server/dist/session-board-hook.mjs", `${JSON.stringify({ ...boardInput, ...input })}\n`, [`--host=${host}`]);
    const boardTool = { hook_event_name: "PreToolUse", tool_name: "mcp__agent_governance_suite__update_session_status" };
    const unsupportedPrompt = runBoardHook({ hook_event_name: "UserPromptSubmit", session_id: "clean-room-gemini-board", agent_id: "", prompt: "forbidden Gemini prompt" }, "gemini");
    const unsupportedTool = runBoardHook({ ...boardTool, session_id: "clean-room-gemini-board", agent_id: "", tool_input: { summary: "forbidden Gemini write" } }, "gemini");
    for (const result of [unsupportedPrompt, unsupportedTool]) {
      if (result.error || result.status !== 0 || result.stdout !== "") throw new Error("session board hook accepted unsupported Gemini actor input.");
    }
    await assertMissing(environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH);
    await writeFile(path.join(cleanRoot, "state", "read-board.mjs"), `
import { DatabaseSync } from "node:sqlite";
const board = new DatabaseSync(process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH, { readOnly: true });
try {
  process.stdout.write(JSON.stringify(board.prepare("SELECT summary, last_prompt_at, cwd FROM board_sessions WHERE host = ? AND session_id = ?").get("claude-code", "clean-room-board") ?? null));
} finally { board.close(); }
`, "utf8");
    const readBoard = () => {
      const result = runNode("state/read-board.mjs", "");
      if (result.error || result.status !== 0) throw new Error(`session board clean-room read failed.\n${result.stderr ?? ""}`);
      return JSON.parse(result.stdout);
    };
    const boardPrompt = runBoardHook({ hook_event_name: "UserPromptSubmit", prompt: "clean-room request" });
    const promptedBoard = readBoard();
    if (boardPrompt.error || boardPrompt.status !== 0 || boardPrompt.stdout !== "" || promptedBoard?.summary !== null || promptedBoard?.cwd !== cleanRoot
      || typeof promptedBoard?.last_prompt_at !== "string" || !Number.isFinite(Date.parse(promptedBoard.last_prompt_at))) {
      throw new Error(`session board hook failed its node_modules-free prompt smoke check.\n${boardPrompt.stderr ?? ""}`);
    }
    for (const input of [{ hook_event_name: "SessionStart" }, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} },
      { ...boardTool, tool_input: { summary: "clean-room work" } }, { hook_event_name: "UserPromptSubmit", agent_id: "subagent", prompt: "child request" }]) {
      const result = runBoardHook(input);
      if (result.error || result.status !== 0 || result.stdout !== "") {
        throw new Error(`session board hook bound, gated or wrote outside a main prompt in the clean room.\n${result.stderr ?? ""}`);
      }
    }
    const finalBoard = readBoard();
    if (JSON.stringify(finalBoard) !== JSON.stringify(promptedBoard)) {
      throw new Error("session board hook changed clean-room board state outside a main prompt.");
    }

    let admissionCall = 0;
    const admitCall = (name, args) => {
      // Owned synthetic hook events use the built CLI and the server's clean-room workflow DB.
      const toolUseId = `toolu_clean_room_mcp_${++admissionCall}`;
      const result = runGovernanceHook({ hook_event_name: "PreToolUse", session_id: "clean-room-mcp-root", cwd: cleanRoot,
        transcript_path: transcriptPath, tool_use_id: toolUseId, tool_name: `mcp__agent_governance_suite__${name}`, tool_input: args });
      if (result.error || result.status !== 0 || result.stdout !== "") {
        throw new Error(`governance hook failed its clean-room admission.\n${formatContinuityHookFailure(result)}`);
      }
      return { "claudecode/toolUseId": toolUseId };
    };

    const sourceText = "MCP와 SQLite";
    const lookupInput = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_korean_prose_terms", arguments: { schemaVersion: "1.0.0", sourceText, sourceDigest: createHash("sha256").update(sourceText).digest("hex") } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "validate_collaboration_decision", arguments: { decision: {
        schemaVersion: "1.2.0", sourceOriginKind: "unknown", sourceReceiptId: null,
        authorityEffect: "none", userDirective: "unspecified", auditSeparationRequired: false, route: "direct",
        netBenefitCriteria: { independentlyCompletable: true, parallelBottleneckReduced: true,
          limitedContextSufficient: true, singleWriterOwnership: true, netBenefitAfterOverhead: true },
      } } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_trust_capabilities", arguments: {} } },
    ].map((message) => {
      if (message.method === "tools/call") message.params._meta = admitCall(message.params.name, message.params.arguments);
      return JSON.stringify(message);
    }).join("\n");
    const serverResult = runNode("mcp-server/dist/server.mjs", `${lookupInput}\n`, [], { ...environment, AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code" });
    if (serverResult.error || serverResult.status !== 0) {
      throw new Error(`MCP server failed its node_modules-free glossary lookup.\n${serverResult.stderr ?? ""}`);
    }
    const lookupResponse = String(serverResult.stdout).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
    const lookupEnvelope = lookupResponse?.result?.content?.[0]?.text ? JSON.parse(lookupResponse.result.content[0].text) : null;
    if (lookupEnvelope?.ok !== true || lookupEnvelope.data?.status !== "matched" || lookupEnvelope.data.matches?.length !== 2) {
      throw new Error(`MCP glossary lookup returned an unexpected clean-room result.\n${serverResult.stdout ?? ""}`);
    }
    const validationResponse = String(serverResult.stdout).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 3);
    const validationEnvelope = validationResponse?.result?.content?.[0]?.text ? JSON.parse(validationResponse.result.content[0].text) : null;
    if (validationEnvelope?.ok !== true || validationEnvelope.data?.structuralValidity !== "valid"
      || validationEnvelope.data.receiptFound !== false || validationEnvelope.data.receiptBoundToCaller !== null
      || validationEnvelope.data.authorityCapabilities?.authorityIssuance !== false) {
      throw new Error(`MCP provenance validation failed its node_modules-free smoke check.\n${serverResult.stdout ?? ""}`);
    }

    const capabilitiesResponse = String(serverResult.stdout).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 4);
    const capabilitiesEnvelope = capabilitiesResponse?.result?.content?.[0]?.text ? JSON.parse(capabilitiesResponse.result.content[0].text) : null;
    if (capabilitiesEnvelope?.ok !== true || capabilitiesEnvelope.data?.provenanceRecording !== true
      || capabilitiesEnvelope.data.directUserInputAttestation !== false || capabilitiesEnvelope.data.authorityIssuance !== false
      || capabilitiesEnvelope.data.scopedDelegation !== false) {
      throw new Error(`MCP trust capabilities failed its node_modules-free smoke check.\n${serverResult.stdout ?? ""}`);
    }

    const workspace = path.join(cleanRoot, "resolver-fixture");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "Use the repository validation commands.\n", "utf8");
    const resolverInput = {
      schemaVersion: "1.0.0",
      workspaceRoot: workspace,
      instructionRoots: [{ path: workspace, precedence: 1, authorized: true }],
      targets: [{ path: "src", mayNotExist: false }],
      externalPolicyRefs: [],
    };
    const resolverResult = runNode("skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs", `${JSON.stringify(resolverInput)}\n`);
    if (resolverResult.error || resolverResult.status !== 0) {
      throw new Error(`instruction-scope-resolver valid clean-room smoke failed.\n${resolverResult.stderr ?? ""}`);
    }
    const resolverOutput = JSON.parse(resolverResult.stdout);
    if (resolverOutput.ok !== true || resolverOutput.output?.verdict !== "ANALYSIS_REQUIRED") {
      throw new Error(`instruction-scope-resolver returned an unexpected clean-room result.\n${resolverResult.stdout}`);
    }
    return results;
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    await removeRuntimeCleanRoom(cleanRoot, primaryFailure);
  }
}
