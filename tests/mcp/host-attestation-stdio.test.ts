import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type { ApiResultV1, AttemptLeaseV1, ConvergenceRootV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";
import { stdioServerTests } from "../helpers/stdio-server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
function result<T>(response: unknown): ApiResultV1<T> {
  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Missing MCP response");
  return JSON.parse(text) as ApiResultV1<T>;
}

describe("packaged execution observation fixtures (not native-host evidence)", () => {
  const serverTest = stdioServerTests();
  // The first server of each case starts before the case's time limit starts (stdioServerTests); the limit measures the
  // calls. The restart in the body is the behavior under test (admission replay across a restart), so it stays inside.
  for (const { host, model, ingress, catalogAlias, modelClass } of [
    { host: "claude-code", model: "claude-opus-5", ingress: "hook", catalogAlias: "opus", modelClass: "deep" },
    { host: "claude-code", model: "claude-opus-5-default-entry-fixture-20261027", ingress: "hook", catalogAlias: null, modelClass: null },
  ]) serverTest(`completes guarded STDIO and keeps restart replay rejection for ${host}/${ingress}/${model}`, async ({ defer, connect }) => {
    const isolated = await mkdtemp(path.join(tmpdir(), "ags-attestation-stdio-"));
    defer(() => rm(isolated, { recursive: true, force: true }));
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
    await mkdir(path.join(isolated, "mcp-server", "dist"), { recursive: true });
    await mkdir(state, { recursive: true });
    await Promise.all([
      ...["contracts", "skills"].map((directory) => cp(path.join(root, directory), path.join(isolated, directory), { recursive: true })),
      ...["server.mjs", "governance-hook.mjs"].map((bundle) => cp(path.join(root, "mcp-server", "dist", bundle), path.join(isolated, "mcp-server", "dist", bundle))),
    ]);
    const seed = new SqliteWorkflowStore(database);
    seed.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION,
      latestVersion: STABLE_VERSION, latestTag: `v${STABLE_VERSION}`, latestCommit: "c".repeat(40), etag: "attestation-fixture",
      comparison: "up-to-date", lastAttemptAt: new Date().toISOString(), lastSuccessfulCheckAt: new Date().toISOString(),
      nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null });
    seed.close();
    const parameters = { command: process.execPath, args: [path.join(isolated, "mcp-server", "dist", "server.mjs")], cwd: isolated, env: environment };
    return { isolated, state, environment, parameters, server: await connect("packaged-attestation-fixture", parameters) };
  }, async ({ isolated, state, environment, parameters, server }, { restartInTest }) => {
    const catalogRelative = "runtime/model-routing-presets.json";
    const catalogBefore = await readFile(path.join(root, catalogRelative));
    const catalog = JSON.parse(catalogBefore.toString("utf8"));
    const providerCatalog = catalog.providers["anthropic-claude-code"].catalog;
    expect(providerCatalog.matching).toBe("exact-only");
    expect(Object.hasOwn(providerCatalog.models, model)).toBe(false);
    if (catalogAlias === null) {
      // A name resembling a registered alias is still opaque without an exact catalog entry.
      expect(Object.hasOwn(providerCatalog.aliases ?? {}, model)).toBe(false);
    } else {
      expect(providerCatalog.aliases[model]).toBe(catalogAlias);
      expect(providerCatalog.models[catalogAlias].model_class).toBe(modelClass);
    }
    let connection = server;
    // Claude's tools/call _meta names only the tool-use ID; the governance hook recorded the caller under it.
    const rawCall = async <T>(name: string, input: Record<string, unknown>, callId?: string) => result<T>(await connection.client.callTool({
      name, arguments: input, ...(callId === undefined ? {} : { _meta: { "claudecode/toolUseId": callId } }) }));
    const call = async <T>(name: string, input: Record<string, unknown>) => rawCall<T>(name, input, await admitted(name, input));
    let sequence = 0;
    // A null model writes no issuing message, so the hook records the call with its execution unobserved.
    const admitted = async (tool: string, input: Record<string, unknown>, observedModel: string | null = model,
      callId = `fixture-call-${++sequence}`) => {
      const transcript = path.join(state, "transcript.jsonl");
      const entries = observedModel === null ? [] : [{ type: "assistant", sessionId: "fixture-session", isSidechain: false, effort: "high",
        message: { model: observedModel, content: [{ type: "tool_use", id: callId, name: tool, input }] } }];
      await writeFile(transcript, entries.map((entry) => JSON.stringify(entry) + "\n").join(""), "utf8");
      const hooked = spawnSync(process.execPath, [path.join(isolated, "mcp-server", "dist", "governance-hook.mjs"), "--host=claude-code"], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fixture-session", turn_id: "fixture-turn",
          tool_use_id: callId, transcript_path: transcript, tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: input, effort: { level: "high" } }),
        env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      expect(hooked.status, hooked.stderr).toBe(0);
      expect(hooked.stdout).toBe("");
      return callId;
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
    expect(missing.error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } });
    const forged = await rawCall<WorkflowPlanV1>("plan_workflow", { ...planInput, _sessionBinding: { host, sessionId: "fixture-session" } },
      await admitted("plan_workflow", planInput));
    expect(forged.error).toMatchObject({ code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD" } });
    const missingModel = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, await admitted("plan_workflow", planInput, null));
    expect(missingModel.error, JSON.stringify(missingModel)).toMatchObject({ code: "BINDING_REQUIRED", details: { observation: { host } } });
    // Both observations use the shipped default CLI/server registration, not an injected adapter or catalog.
    const knownPlan = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, await admitted("plan_workflow", planInput, "claude-opus-5"));
    expect(knownPlan.error).toBeNull();
    expect(knownPlan.data!.bootstrapExecution!.context).toMatchObject({ model: "claude-opus-5", modelClass: "deep", reasoningEffort: "high" });
    const attestedCall = await admitted("plan_workflow", planInput);
    const planned = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, attestedCall);
    expect(planned.error).toBeNull();
    const plan = planned.data!;
    expect(plan.bootstrapExecution?.context).toMatchObject({
      model, modelClass,
      reasoningEffort: knownPlan.data!.bootstrapExecution!.context.reasoningEffort,
    });
    if (catalogAlias === null) {
      expect(plan.bootstrapExecution?.context.policyNotes).toEqual(["MODEL_NOT_IN_CATALOG"]);
    } else {
      expect(plan.bootstrapExecution?.context.policyNotes).toBeUndefined();
    }

    const opaque = await rawCall<WorkflowPlanV1>("plan_workflow", planInput,
      await admitted("plan_workflow", planInput, "opaque-unapproved-default-entry-fixture"));
    // AGS 3.1.1: a model the catalog does not name still runs; its class stays unknown and the plan says why.
    expect(opaque.error).toBeNull();
    expect(opaque.data!.bootstrapExecution!.context).toMatchObject({
      model: "opaque-unapproved-default-entry-fixture", modelClass: null, policyNotes: ["MODEL_NOT_IN_CATALOG"],
    });

    const belowFloor = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, await admitted("plan_workflow", planInput, "claude-haiku-5"));
    expect(belowFloor.ok).toBe(true);
    expect(belowFloor.data?.bootstrapExecution?.context.modelClass).toBe("lightweight");
    const frame = { schemaVersion: "1.0.0", workspace: { workspaceId: "packaged-attestation", locator: "fixture:workspace" },
      controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
      targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
      operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
    const opened = await call<ConvergenceRootV1>("open_convergence_root", { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] });
    expect(opened.error).toBeNull();
    const convergence = opened.data!;
    const claimed = await call<AttemptLeaseV1>("claim_workflow_attempt", { schemaVersion: "1.0.0", rootId: convergence.rootId,
      expectedRevision: convergence.revision, taskEnvelope: task, frame, plan,
      outputTargets: ["fixture.md"], priorFailure: null });
    expect(claimed.error).toBeNull();
    const lease = claimed.data!;
    const started = await call<WorkflowReceiptV1>("start_guarded_workflow", { schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan });
    expect(started.error).toBeNull();
    const receipt = started.data!;
    const stage = receipt.plan.stages[0]!;
    const recorded = await call<WorkflowReceiptV1>("record_stage_result", {
      schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed", responseMode: "full",
      output: { schemaVersion: "1.0.0", kind: "output", output: { completed: true }, artifacts: task.artifactContracts[0]!.produced.map(({ artifactId, schemaId, targetDigest }) => ({
        artifactId, schemaId, locator: `fixture:${artifactId}`, digest: "d".repeat(64), targetDigest, verified: true })), error: null },
      evidence: [{ artifactId: "fixture", kind: "test", locator: "host-attestation-stdio.test.ts", verified: true, note: "Synthetic host fixture, not native-host evidence" }],
      findings: [], blockers: [], error: null,
    });
    expect(recorded.error).toBeNull();
    expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model, modelClass, reasoningEffort: "high", actorId: hostActorId(host, "fixture-session") });
    const final = await call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision });
    expect(final.data?.state).toBe("passed");
    await connection.close();
    connection = await restartInTest("packaged-attestation-fixture", parameters);
    // The server claimed the admission row once; after a restart the same tool-use ID finds nothing.
    const replay = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, attestedCall);
    expect(replay.error).toMatchObject({ code: "BINDING_REQUIRED",
      details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CALL_ADMISSION_MISSING" } });
    // Re-admitting the same host call yields the same observation, which the store consumed before the restart.
    const modelReplay = await rawCall<WorkflowPlanV1>("plan_workflow", planInput, await admitted("plan_workflow", planInput, model, attestedCall));
    expect(modelReplay.error?.code).toBe("BINDING_INVALID");
    expect(modelReplay.error?.message).toContain("already consumed");
    expect(await readFile(path.join(root, catalogRelative))).toEqual(catalogBefore);
    expect(await readFile(path.join(isolated, catalogRelative))).toEqual(catalogBefore);
  }, 20_000);

  it.each([
    { host: "claude-code", model: "claude-opus-5", ingress: "empty-id", agent: "", reasonCode: "HOOK_AGENT_ID_INVALID" },
  ])("denies a malformed caller before recording the call for $host/$ingress/$model", async ({ host, model, agent, reasonCode }) => {
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
      expect(hooked.status, hooked.stderr).toBe(2);
      const output = JSON.parse(hooked.stdout);
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode } });
      expect(existsSync(database)).toBe(false);
    } finally { await rm(isolated, { recursive: true, force: true }); }
  }, 15_000);
});
