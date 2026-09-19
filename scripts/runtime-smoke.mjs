import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SKILL_RUNTIME_ENTRYPOINTS } from "./runtime-entrypoints.mjs";

async function assertMissing(target) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Clean-room dependency leak: ${target} exists.`);
}

export async function runRuntimeSmokeCheck(sourceRoot) {
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "agent-governance-runtime-"));
  try {
    await mkdir(path.join(cleanRoot, "mcp-server", "dist"), { recursive: true });
    await Promise.all([
      ...["contracts", "runtime", "skills"].map((directory) => cp(path.join(sourceRoot, directory), path.join(cleanRoot, directory), { recursive: true })),
      ...["server.mjs", "continuity-hook.mjs", "host-attestation-hook.mjs"].map((bundle) => (
        cp(path.join(sourceRoot, "mcp-server", "dist", bundle), path.join(cleanRoot, "mcp-server", "dist", bundle))
      )),
    ]);
    await assertMissing(path.join(cleanRoot, "node_modules"));

    const environment = { ...process.env };
    delete environment.AGENT_GOVERNANCE_ROOT;
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    environment.AGENT_GOVERNANCE_DB_PATH = path.join(cleanRoot, "state", "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = path.join(cleanRoot, "state", "continuity.sqlite3");
    // Runs a clean-room script (a path relative to the clean root) with the given stdin text.
    const runNode = (script, input) => spawnSync(process.execPath, [path.join(cleanRoot, ...script.split("/"))], {
      cwd: cleanRoot,
      encoding: "utf8",
      env: environment,
      input,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });

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
      throw new Error(`continuity hook failed its node_modules-free startup smoke check.\n${hookResult.stderr ?? ""}`);
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
      || !String(attestationOutput?.hookSpecificOutput?.updatedInput?._hostAttestation ?? "").startsWith("aghs1.")
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
      || !String(interactiveOutput?.hookSpecificOutput?.updatedInput?._hostAttestation ?? "").startsWith("aghs1.")
    ) {
      throw new Error(`host attestation hook failed its interactive-session smoke check.\n${sessionStart.stderr ?? ""}${interactive.stderr ?? ""}`);
    }

    const sourceText = "MCP와 SQLite";
    const lookupInput = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_korean_prose_terms", arguments: { schemaVersion: "1.0.0", sourceText, sourceDigest: createHash("sha256").update(sourceText).digest("hex") } } },
    ].map((message) => JSON.stringify(message)).join("\n");
    const serverResult = runNode("mcp-server/dist/server.mjs", `${lookupInput}\n`);
    if (serverResult.error || serverResult.status !== 0) {
      throw new Error(`MCP server failed its node_modules-free glossary lookup.\n${serverResult.stderr ?? ""}`);
    }
    const lookupResponse = String(serverResult.stdout).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
    const lookupEnvelope = lookupResponse?.result?.content?.[0]?.text ? JSON.parse(lookupResponse.result.content[0].text) : null;
    if (lookupEnvelope?.ok !== true || lookupEnvelope.data?.status !== "matched" || lookupEnvelope.data.matches?.length !== 2) {
      throw new Error(`MCP glossary lookup returned an unexpected clean-room result.\n${serverResult.stdout ?? ""}`);
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
  } finally {
    await rm(cleanRoot, { recursive: true, force: true });
  }
}
