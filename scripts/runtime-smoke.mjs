import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { failureContext, retainFailureCause, retainFailureSecondary } from "../runtime/failure-diagnostics.mjs";
import { SKILL_RUNTIME_ENTRYPOINTS } from "./runtime-entrypoints.mjs";

const MESSAGING_RUNTIME_PROBES = [
  { bundle: "session-message-broker.mjs", expectedExitCode: 2, stdout: "" },
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
  return `error=${errorToken} status=${statusToken} signal=${signalToken} stdout=${formatBoundedStream(result.stdout)} stderr=${formatBoundedStream(result.stderr)}`;
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
      ...["server.mjs", "continuity-hook.mjs", "host-attestation-hook.mjs", "host-attestation-api.mjs", "session-board-hook.mjs", "governance-hook.mjs", ...MESSAGING_RUNTIME_PROBES.map(({ bundle }) => bundle)].map((bundle) => (
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
    const runNode = (script, input, args = []) => spawnSync(process.execPath, [path.join(cleanRoot, ...script.split("/")), ...args], {
      cwd: cleanRoot,
      encoding: "utf8",
      env: environment,
      input,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });

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
          || envelope.error !== "Unsupported session message operation.") {
          throw new Error(`${script} did not reject invalid messaging input.\n${output}`);
        }
      }
      if (probe.stderrDiagnostic) {
        const prefix = "[agent-governance-suite] peer-hook-failure ";
        const line = String(result.stderr ?? "").split(/\r?\n/u).find(value => value.startsWith(prefix));
        const diagnostic = line ? JSON.parse(line.slice(prefix.length)) : null;
        if (diagnostic?.phase !== probe.stderrDiagnostic.phase || diagnostic?.reason !== probe.stderrDiagnostic.reason) {
          throw new Error(`${script} did not emit its invalid-JSON input diagnostic.\n${output}`);
        }
      }
    }

    const results = [];
    for (const entrypoint of SKILL_RUNTIME_ENTRYPOINTS) {
      const result = runNode(entrypoint.path, "{}\n");
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
    const runAttestationHook = (input) => runNode("mcp-server/dist/host-attestation-hook.mjs", `${JSON.stringify(input)}\n`);
    const attestationResult = runAttestationHook(attestationInput);
    const attestationOutput = attestationResult.status === 0 && attestationResult.stdout ? JSON.parse(attestationResult.stdout) : null;
    if (
      attestationResult.error
      || !String(attestationOutput?.hookSpecificOutput?.updatedInput?._hostAttestation ?? "").startsWith("aghs2.")
      || attestationOutput.hookSpecificOutput.updatedInput.taskId !== "clean-room-task"
    ) {
      throw new Error(`host attestation hook failed its node_modules-free smoke check.\n${attestationResult.stderr ?? ""}`);
    }

    // Interactive sessions: the issuing message is not in the transcript yet, so the model
    // recorded by the SessionStart hook must be used.
    const sessionStart = runAttestationHook({ hook_event_name: "SessionStart", session_id: "clean-room-interactive", source: "startup", model: "claude-opus-5" });
    const interactive = runAttestationHook({ ...attestationInput, session_id: "clean-room-interactive", tool_use_id: "toolu_not_written_yet" });
    const interactiveOutput = interactive.status === 0 && interactive.stdout ? JSON.parse(interactive.stdout) : null;
    if (
      sessionStart.error || sessionStart.status !== 0 || sessionStart.stdout !== ""
      || interactive.error
      || !String(interactiveOutput?.hookSpecificOutput?.updatedInput?._hostAttestation ?? "").startsWith("aghs2.")
    ) {
      throw new Error(`host attestation hook failed its interactive-session smoke check.\n${sessionStart.stderr ?? ""}${interactive.stderr ?? ""}`);
    }

    const codexTranscriptPath = path.join(cleanRoot, "state", "codex-rollout.jsonl");
    await writeFile(codexTranscriptPath, [
      { type: "session_meta", payload: { id: "clean-room-codex", source: "cli" } },
      { type: "turn_context", payload: { turn_id: "clean-room-turn", model: "gpt-6-astra", effort: "high" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    const codexHook = runNode("mcp-server/dist/host-attestation-hook.mjs", JSON.stringify({
      ...attestationInput, session_id: "clean-room-codex", turn_id: "clean-room-turn", model: "gpt-6-astra",
      transcript_path: codexTranscriptPath,
    }), ["--host=codex"]);
    const codexOutput = codexHook.status === 0 && codexHook.stdout ? JSON.parse(codexHook.stdout) : null;
    if (codexHook.error || Object.hasOwn(codexOutput?.hookSpecificOutput ?? {}, "permissionDecision")
      || !String(codexOutput?.hookSpecificOutput?.updatedInput?._hostAttestation ?? "").startsWith("aghs2.")) {
      throw new Error(`host attestation hook failed its Codex fixture smoke check.\n${codexHook.stderr ?? ""}`);
    }

    await writeFile(path.join(cleanRoot, "state", "host-wrapper.mjs"), `
import { openHostAttestation, codexExecutionAdapter, hostActorId } from "../mcp-server/dist/host-attestation-api.mjs";
const attestation = openHostAttestation(process.env.AGENT_GOVERNANCE_DB_PATH, codexExecutionAdapter);
try {
  const signed = attestation.runObserved("plan_workflow", { taskId: "wrapper-fixture" },
    () => ({ model: "gpt-6-astra", reasoningEffort: "high", actorId: hostActorId("codex", "wrapper-session"),
      sessionId: "wrapper-session", turnId: "wrapper-turn", toolUseId: "wrapper-call" }),
    (input) => input);
  if (!signed._hostAttestation?.startsWith("aghs2.")) throw new Error("Host wrapper observation missing");
  process.stdout.write("host-wrapper-fixture: ready");
} finally { attestation.close(); }
`, "utf8");
    const wrapper = runNode("state/host-wrapper.mjs", "");
    if (wrapper.error || wrapper.status !== 0 || wrapper.stdout !== "host-wrapper-fixture: ready") {
      throw new Error(`host-owned wrapper API failed its dependency-free fixture check.\n${wrapper.stderr ?? ""}`);
    }

    // Lifecycle events record activity; a missing summary must not gate ordinary tools.
    // Synthetic Claude hook input exercises storage; it is not native capture evidence.
    const boardInput = { session_id: "clean-room-board", cwd: cleanRoot };
    const runBoardHook = (input, host = "claude-code") => runNode("mcp-server/dist/session-board-hook.mjs", `${JSON.stringify({ ...boardInput, ...input })}\n`, [`--host=${host}`]);
    const boardTool = { hook_event_name: "PreToolUse", tool_name: "mcp__agent_governance_suite__update_session_status" };
    const unsupportedStart = runBoardHook({ hook_event_name: "SessionStart", session_id: "clean-room-codex-board", agent_id: "" }, "codex");
    const unsupportedWrite = runBoardHook({ ...boardTool, session_id: "clean-room-codex-board", agent_id: "", tool_input: { summary: "forbidden Codex write" } }, "codex");
    const unsupportedOutput = unsupportedWrite.status === 0 && unsupportedWrite.stdout ? JSON.parse(unsupportedWrite.stdout).hookSpecificOutput : null;
    if (unsupportedStart.error || unsupportedStart.status !== 0 || unsupportedStart.stdout !== ""
      || unsupportedWrite.error || unsupportedWrite.status !== 0 || unsupportedOutput?.permissionDecision !== "deny"
      || Object.hasOwn(unsupportedOutput, "updatedInput")) {
      throw new Error("session board hook accepted unsupported Codex actor input.");
    }
    await assertMissing(environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH);
    await writeFile(path.join(cleanRoot, "state", "read-board.mjs"), `
import { DatabaseSync } from "node:sqlite";
const board = new DatabaseSync(process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH, { readOnly: true });
try {
  process.stdout.write(JSON.stringify(board.prepare("SELECT summary, last_prompt_at FROM sessions WHERE host = ? AND session_id = ?").get("claude-code", "clean-room-board") ?? null));
} finally { board.close(); }
`, "utf8");
    const readBoard = () => {
      const result = runNode("state/read-board.mjs", "");
      if (result.error || result.status !== 0) throw new Error(`session board clean-room read failed.\n${result.stderr ?? ""}`);
      return JSON.parse(result.stdout);
    };
    const boardStart = runBoardHook({ hook_event_name: "SessionStart" });
    const startedBoard = readBoard();
    if (boardStart.error || boardStart.status !== 0 || boardStart.stdout !== ""
      || startedBoard?.summary !== null || startedBoard?.last_prompt_at !== null) {
      throw new Error(`session board hook failed its node_modules-free lifecycle smoke check.\n${boardStart.stderr ?? ""}`);
    }
    const boardPrompt = runBoardHook({ hook_event_name: "UserPromptSubmit", prompt: "clean-room request" });
    const promptedBoard = readBoard();
    if (boardPrompt.error || boardPrompt.status !== 0 || boardPrompt.stdout !== ""
      || typeof promptedBoard?.last_prompt_at !== "string" || !Number.isFinite(Date.parse(promptedBoard.last_prompt_at))) {
      throw new Error(`session board hook failed its node_modules-free activity smoke check.\n${boardPrompt.stderr ?? ""}`);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const edit = runBoardHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} });
      if (edit.error || edit.status !== 0 || edit.stdout !== "") {
        throw new Error(`session board hook gated an ordinary clean-room edit.\n${edit.stderr ?? ""}`);
      }
    }
    const boardUpdate = runBoardHook({ ...boardTool, tool_input: { summary: "clean-room work" } });
    const boardOutput = boardUpdate.status === 0 && boardUpdate.stdout ? JSON.parse(boardUpdate.stdout).hookSpecificOutput : null;
    if (boardUpdate.error || !boardOutput || Object.hasOwn(boardOutput, "permissionDecision")
      || boardOutput.updatedInput?._sessionBinding?.host !== "claude-code"
      || boardOutput.updatedInput?._sessionBinding?.sessionId !== boardInput.session_id) {
      throw new Error(`session board hook failed its clean-room binding smoke check.\n${boardUpdate.stderr ?? ""}`);
    }
    for (const extra of [{ agent_id: "subagent" }, { agent_id: "" }, { agent_id: " " }, { agent_id: null }, { agent_id: 42 }, { tool_input: { summary: "two\nlines" } }]) {
      const denied = runBoardHook({ ...boardTool, tool_input: { summary: "forbidden write" }, ...extra });
      const output = denied.status === 0 && denied.stdout ? JSON.parse(denied.stdout).hookSpecificOutput : null;
      if (denied.error || output?.permissionDecision !== "deny" || Object.hasOwn(output, "updatedInput")) {
        throw new Error(`session board hook failed its clean-room authorization smoke check.\n${denied.stderr ?? ""}`);
      }
    }
    const finalBoard = readBoard();
    if (finalBoard?.summary !== "clean-room work" || finalBoard?.last_prompt_at !== promptedBoard.last_prompt_at) {
      throw new Error("session board hook changed clean-room activity or summary across rejected writes.");
    }

    let proofCall = 0;
    const withRootProof = (name, args) => {
      // Owned synthetic hook events use the built CLI and the server's clean-room workflow DB.
      const issued = runNode("mcp-server/dist/governance-hook.mjs", `${JSON.stringify({
        hook_event_name: "PreToolUse", session_id: "clean-room-mcp-root", cwd: cleanRoot,
        tool_use_id: `clean-room-mcp-call-${++proofCall}`,
        tool_name: `mcp__agent_governance_suite__${name}`, tool_input: args,
      })}\n`, ["--host=claude-code"]);
      if (issued.error || issued.status !== 0 || typeof issued.stdout !== "string" || !issued.stdout.trim()) {
        throw new Error(`governance hook failed its clean-room root proof issuance.\n${formatContinuityHookFailure(issued)}`);
      }
      let output;
      try { output = JSON.parse(issued.stdout); }
      catch (cause) { throw new Error("governance hook returned malformed clean-room JSON.", { cause }); }
      const specific = output?.hookSpecificOutput;
      const updated = specific?.updatedInput;
      if (specific?.hookEventName !== "PreToolUse" || Object.hasOwn(specific, "permissionDecision")
        || !updated || typeof updated !== "object" || Array.isArray(updated)
        || Object.hasOwn(updated, "_sessionBinding")
        || typeof updated._sessionProof !== "string" || !/^ags-root-v3\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(updated._sessionProof)) {
        throw new Error("governance hook did not issue a clean-room root proof.");
      }
      const exactInput = { ...updated };
      delete exactInput._sessionProof;
      if (JSON.stringify(exactInput) !== JSON.stringify(args)) throw new Error("governance hook changed clean-room tool arguments.");
      return updated;
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
      if (message.method === "tools/call") message.params.arguments = withRootProof(message.params.name, message.params.arguments);
      return JSON.stringify(message);
    }).join("\n");
    const serverResult = runNode("mcp-server/dist/server.mjs", `${lookupInput}\n`);
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
