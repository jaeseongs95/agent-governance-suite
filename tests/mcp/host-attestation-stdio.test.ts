import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type { ApiResultV1, AttemptLeaseV1, ConvergenceRootV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";
import { SessionActorProofs, withoutSessionProof } from "../../mcp-server/src/session-actor-proof.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
function result<T>(response: unknown): ApiResultV1<T> {
  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Missing MCP response");
  return JSON.parse(text) as ApiResultV1<T>;
}

// Negative model-boundary checks get fresh authentic root proofs, without minting a model observation.
// This synthetic issuer owns only the isolated fixture DB and is not native-host evidence.
function syntheticRootArguments(database: string, tool: string, args: Record<string, unknown>, callId: string): Record<string, unknown> {
  const store = new SqliteWorkflowStore(database);
  try {
    return { ...args, _sessionProof: new SessionActorProofs(store).issue({
      host: "synthetic-root-host", sessionId: "model-negative-fixture", callId,
      kind: "tool-boundary", boundaryPhase: "before",
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_TEST_ROOT_OBSERVATION" },
    }, tool, args) };
  } finally { store.close(); }
}

describe("packaged execution observation fixtures (not native-host evidence)", () => {
  it.each([
    { host: "claude-code", model: "claude-opus-5", ingress: "hook" },
  ])("completes guarded STDIO and keeps restart replay rejection for $host/$ingress/$model", async ({ host, model }) => {
    const isolated = await mkdtemp(path.join(tmpdir(), "ags-attestation-stdio-"));
    const state = path.join(isolated, "state");
    const database = path.join(state, "workflows.sqlite3");
    const environment = { ...getDefaultEnvironment(),
      AGENT_GOVERNANCE_DB_PATH: database,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messaging"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"),
      AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
      AGENT_GOVERNANCE_HOST_ATTESTATION: host,
    };
    let connection: { client: Client; transport: StdioClientTransport } | null = null;
    try {
      await mkdir(path.join(isolated, "mcp-server", "dist"), { recursive: true });
      await mkdir(state, { recursive: true });
      await Promise.all([
        ...["contracts", "skills"].map((directory) => cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })),
        ...["server.mjs", "governance-hook.mjs", "host-attestation-api.mjs"].map((bundle) => cp(path.join(root, "mcp-server", "dist", bundle), path.join(isolated, "mcp-server", "dist", bundle))),
      ]);
      const seed = new SqliteWorkflowStore(database);
      seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION,
        latestVersion: CURRENT_VERSION, latestTag: `v${CURRENT_VERSION}`, latestCommit: "c".repeat(40), etag: "attestation-fixture",
        comparison: "up-to-date", lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(),
        nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null });
      seed.close();
      const api = await import(pathToFileURL(path.join(isolated, "mcp-server", "dist", "host-attestation-api.mjs")).href) as
        typeof import("../../mcp-server/src/host-attestation-api.js");
      expect(Object.keys(api).sort()).toEqual(["claudeCodeExecutionAdapter", "codexExecutionAdapter", "geminiExecutionAdapter", "hostActorId", "openHostAttestation"]);
      const connect = async () => {
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [path.join(isolated, "mcp-server", "dist", "server.mjs")], cwd: isolated, env: environment, stderr: "pipe" });
        const client = new Client({ name: "packaged-attestation-fixture", version: "1.0.0" });
        try {
          await client.connect(transport);
          return { client, transport };
        } catch (error) {
          await client.close();
          await transport.close();
          throw error;
        }
      };
      connection = await connect();
      const rawCall = async <T>(name: string, input: Record<string, unknown>) => result<T>(await connection!.client.callTool({ name, arguments: input }));
      const call = async <T>(name: string, input: Record<string, unknown>) => rawCall<T>(name, Object.hasOwn(input, "_sessionProof") ? input : await signed(name, input));
      let sequence = 0;
      const signed = async (tool: string, input: Record<string, unknown>) => {
        const callId = `fixture-call-${++sequence}`;
        const transcript = path.join(state, "transcript.jsonl");
        const entries = [{ type: "assistant", sessionId: "fixture-session", isSidechain: false, effort: "high",
          message: { model, content: [{ type: "tool_use", id: callId, name: tool, input }] } }];
        await writeFile(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
        const hooked = spawnSync(process.execPath, [path.join(isolated, "mcp-server", "dist", "governance-hook.mjs"), "--host=claude-code"], {
          input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fixture-session", turn_id: "fixture-turn", model,
            tool_use_id: callId, transcript_path: transcript, tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: input, effort: { level: "high" } }),
          env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        expect(hooked.status, hooked.stderr).toBe(0);
        const args = JSON.parse(hooked.stdout).hookSpecificOutput.updatedInput as Record<string, unknown>;
        expect(args._sessionProof).toEqual(expect.any(String));
        return args;
      };
      const task = { schemaVersion: "1.0.0", taskId: "packaged-attestation", objective: "Complete a guarded fixture",
        scope: { included: ["fixture"], excluded: ["deployment"] }, acceptanceCriteria: ["Guarded fixture passes"], riskLevel: "low",
        workUnits: [{ id: "unit", objective: "Inspect fixture", dependencies: [], writeTargets: ["fixture.md"] }],
        requiredCapabilities: ["task-decomposition"], constraints: ["No external services"],
        artifactContracts: [{ capability: "task-decomposition", produced:
          ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map((artifactId) => ({
            artifactId, schemaId: "fixture/v1", targetDigest: `sha256:${"b".repeat(64)}` as const,
          })),
        }],
        authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
        decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
      const planInput = { schemaVersion: "1.0.0", taskEnvelope: task };
      const missing = await rawCall<WorkflowPlanV1>("plan_workflow", planInput);
      expect(missing.error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "ROOT_HOOK_PROOF_REQUIRED" } });
      const forged = await rawCall<WorkflowPlanV1>("plan_workflow", { ...planInput, _sessionBinding: { host, sessionId: "fixture-session" } });
      expect(forged.error).toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "CALLER_SESSION_BINDING_REJECTED" } });
      const missingModel = await rawCall<WorkflowPlanV1>("plan_workflow", syntheticRootArguments(database, "plan_workflow", planInput, "missing-model"));
      expect(missingModel.error).toMatchObject({ code: "BINDING_REQUIRED", details: { observation: { host } } });
      const attestedPlan = await signed("plan_workflow", planInput);
      const planned = await call<WorkflowPlanV1>("plan_workflow", attestedPlan);
      expect(planned.error).toBeNull();
      const plan = planned.data!;
      const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: "packaged-attestation", locator: "fixture:workspace" },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
      const opened = await call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] });
      expect(opened.error).toBeNull();
      const convergence = opened.data!;
      const claimed = await call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: convergence.rootId,
        expectedRevision: convergence.revision, taskEnvelope: task, frame, plan, actorId: api.hostActorId(host, "fixture-session"),
        outputTargets: ["fixture.md"], priorFailure: null });
      expect(claimed.error).toBeNull();
      const lease = claimed.data!;
      const started = await call<WorkflowReceiptV1>("start_guarded_workflow", { schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan });
      expect(started.error).toBeNull();
      const receipt = started.data!;
      const stage = receipt.plan.stages[0]!;
      const recorded = await call<WorkflowReceiptV1>("record_stage_result", await signed("record_stage_result", {
        schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed", responseMode: "full",
        output: { schemaVersion: "1.0.0", kind: "output", output: { completed: true }, artifacts: task.artifactContracts[0]!.produced.map(({ artifactId, schemaId, targetDigest }) => ({
          artifactId, schemaId, locator: `fixture:${artifactId}`, digest: "d".repeat(64), targetDigest, verified: true })), error: null },
        evidence: [{ artifactId: "fixture", kind: "test", locator: "host-attestation-stdio.test.ts", verified: true, note: "Synthetic host fixture, not native-host evidence" }],
        findings: [], blockers: [], error: null,
      }));
      expect(recorded.error).toBeNull();
      expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model, reasoningEffort: "high", actorId: api.hostActorId(host, "fixture-session") });
      const final = await call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision });
      expect(final.data?.state).toBe("passed");
      await connection.client.close();
      await connection.transport.close();
      connection = null;
      connection = await connect();
      const replay = await rawCall<WorkflowPlanV1>("plan_workflow", attestedPlan);
      expect(replay.error).toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "ROOT_PROOF_ALREADY_CONSUMED" } });
      // Preserve model-token replay rejection independently of the consumed root proof.
      const modelReplay = await rawCall<WorkflowPlanV1>("plan_workflow", syntheticRootArguments(database, "plan_workflow", withoutSessionProof(attestedPlan), "fresh-root-for-old-model"));
      expect(modelReplay.error?.code).toBe("BINDING_INVALID");
      expect(modelReplay.error?.details?.reasonCode).not.toBe("ROOT_PROOF_ALREADY_CONSUMED");
    } finally {
      await connection?.client.close();
      await connection?.transport.close();
      await rm(isolated, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    { host: "codex", model: "gpt-6-astra", ingress: "hook", agent: undefined, reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" },
    { host: "codex", model: "gpt-6-sol", ingress: "hook", agent: undefined, reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" },
    { host: "codex", model: "gpt-6-astra", ingress: "wrapper", agent: undefined, reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" },
    { host: "gemini", model: "gemini-2.5-pro", ingress: "wrapper", agent: undefined, reasonCode: "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED" },
    { host: "antigravity", model: "fixture-model", ingress: "hook", agent: undefined, reasonCode: "ANTIGRAVITY_ACTOR_OBSERVATION_UNSUPPORTED" },
    { host: "claude-code", model: "claude-opus-5", ingress: "child", agent: "child-fixture", reasonCode: "CLAUDE_NATIVE_CHILD_AGENT_ID" },
    { host: "claude-code", model: "claude-opus-5", ingress: "empty-id", agent: "", reasonCode: "CLAUDE_NATIVE_AGENT_ID_INVALID" },
  ])("denies unavailable root authority before model attestation for $host/$ingress/$model", async ({ host, model, agent, reasonCode }) => {
    const isolated = await mkdtemp(path.join(tmpdir(), "ags-denied-actor-stdio-"));
    const database = path.join(isolated, "workflows.sqlite3");
    try {
      const hooked = spawnSync(process.execPath, [path.join(root, "mcp-server", "dist", "governance-hook.mjs"), `--host=${host}`], {
        cwd: isolated, env: { ...getDefaultEnvironment(), AGENT_GOVERNANCE_DB_PATH: database },
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fixture-session", tool_use_id: "denied-call", model,
          ...(agent === undefined ? {} : { agent_id: agent }),
          tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { schemaVersion: "1.0.0" } }),
        encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      expect(hooked.status, hooked.stderr).toBe(0);
      const output = JSON.parse(hooked.stdout);
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode } });
      expect(existsSync(database)).toBe(false);
    } finally { await rm(isolated, { recursive: true, force: true }); }
  }, 15_000);
});
