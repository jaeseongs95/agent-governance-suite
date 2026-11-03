import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiResultV1 } from "../../contracts/types.js";
import { codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { HostAttestationProvider } from "../../mcp-server/src/host-attestation.js";
import { codexExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { openBoard, recordInput } from "../../skills/session-board/scripts/board-store.mjs";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService, type MinimalWorkflowStartV1 } from "../../mcp-server/src/workflow-service.js";
import { codexCallMeta } from "../helpers/caller.js";

// Design docs/ags30-phase-check-design.md 7.5-7.6: start_workflow plans, opens, claims and starts in one transaction.
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const SESSION = "minimal-start-session";
const repo = path.resolve(process.platform === "win32" ? "C:\\work\\minimal-repo" : "/work/minimal-repo");
// The gate counts only files under version control (design 7.3): the edits go to a synthetic path in this checkout.
const productDir = fileURLToPath(new URL("../../.phase-fixture/minimal-repo", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "minimal-start-"));
  const workflowPath = path.join(directory, "workflow.sqlite3");
  const boardPath = path.join(directory, "session-board.sqlite3");
  const validator = new ContractValidator();
  const store = new SqliteWorkflowStore(workflowPath);
  const continuityStore = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
  const continuity = new ContinuityService(continuityStore, validator, store);
  // One provider: the server sets the current call on it and the workflow service observes through it.
  const provider = new HostAttestationProvider(codexExecutionAdapter);
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), continuity, undefined, undefined, validator,
    "default", provider, boardPath, undefined, null, null, codexMetaIngress());
  const client = new Client({ name: "minimal-start", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => { store.close(); continuityStore.close(); });
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = async <T>(args: Record<string, unknown>, observed = true): Promise<ApiResultV1<T>> => {
    const response = await client.callTool({ name: "start_workflow", arguments: args, _meta: codexCallMeta(SESSION, observed ? {} : { model: null }) });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
    return JSON.parse(text!) as ApiResultV1<T>;
  };
  const counts = () => {
    const database = new DatabaseSync(workflowPath, { readOnly: true });
    try {
      return Object.fromEntries(["convergence_roots", "convergence_leases", "workflow_runs", "execution_observation_claims"].map(table =>
        [table, (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    } finally { database.close(); }
  };
  /** The hook side: the same continuity and workflow stores the edit gate reads. */
  const hookService = () => new ContinuityService(continuityStore, null, store);
  const writeFile = (name: string) => handleContinuityHook({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: productDir,
    tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${name}\n*** End Patch` } }, hookService(), "codex", {});
  const stop = () => handleContinuityHook({ hook_event_name: "Stop", session_id: SESSION, cwd: repo }, hookService(), "codex", {});
  /** The session-board row the host's own hook writes from its input cwd. */
  const reportCwd = (cwd: string) => {
    const board = openBoard(boardPath);
    try { recordInput(board, { host: "codex", sessionId: SESSION, cwd, now: new Date().toISOString() }, { prompt: true }); } finally { board.close(); }
  };
  const rootWorkspaces = () => {
    const database = new DatabaseSync(workflowPath, { readOnly: true });
    try {
      return (database.prepare("SELECT workspace_id FROM convergence_roots").all() as Array<{ workspace_id: string }>).map(row => row.workspace_id);
    } finally { database.close(); }
  };
  return { service, continuity, call, counts, writeFile, stop, reportCwd, rootWorkspaces };
}

const minimal = { goal: "Change three files.", stages: ["minimal-implementation"], acceptanceCriteria: ["The change works."], workspace: repo };
const isDeny = (output: Record<string, unknown>) => (output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";

describe("start_workflow minimal start", () => {
  it("starts a guarded run in one call, lists the defaults and lifts the edit gate", async () => {
    const { call, counts, writeFile } = await harness();
    const started = await call<MinimalWorkflowStartV1>(minimal);
    expect(started.error).toBeNull();
    expect(started.data).toMatchObject({ state: "running", lateAdoption: null,
      stages: [{ capability: "minimal-implementation" }] });
    expect(started.data!.defaultsUsed).toEqual(expect.arrayContaining(["taskId", "riskLevel", "authorization", "frame", "writeTargets"]));
    expect(started.data!.defaultsUsed).not.toContain("workspace");
    expect(counts()).toEqual({ convergence_roots: 1, convergence_leases: 1, workflow_runs: 1, execution_observation_claims: 1 });
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) expect(writeFile(name)).toEqual({});
  });

  it("marks edits made earlier in the window as late adoption and lifts the lock", async () => {
    const { call, writeFile } = await harness();
    for (const name of ["a.ts", "b.ts"]) expect(writeFile(name)).toEqual({});
    expect(isDeny(writeFile("c.ts"))).toBe(true);
    const started = await call<MinimalWorkflowStartV1>(minimal);
    expect(started.data?.lateAdoption).toEqual({ label: "사후 편입·근거 미검증", priorFileCount: 2 });
    expect(writeFile("c.ts")).toEqual({});
  });

  it("still marks the refused window's edits as late adoption after a turn end, which keeps the lock", async () => {
    const { call, writeFile, stop } = await harness();
    for (const name of ["a.ts", "b.ts"]) expect(writeFile(name)).toEqual({});
    expect(isDeny(writeFile("c.ts"))).toBe(true);
    expect(stop()).toEqual({});
    expect(isDeny(writeFile("a.ts"))).toBe(true);
    const started = await call<MinimalWorkflowStartV1>(minimal);
    expect(started.data?.lateAdoption).toEqual({ label: "사후 편입·근거 미검증", priorFileCount: 2 });
    expect(writeFile("c.ts")).toEqual({});
  });

  it("defaults the workspace to the session's reported working directory, never the server's", async () => {
    const { call, counts, reportCwd, rootWorkspaces } = await harness();
    const unnamed = { goal: minimal.goal, stages: minimal.stages, acceptanceCriteria: minimal.acceptanceCriteria };
    const refused = await call<MinimalWorkflowStartV1>(unnamed);
    expect(refused.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "workspace" } });
    expect(counts()).toEqual({ convergence_roots: 0, convergence_leases: 0, workflow_runs: 0, execution_observation_claims: 0 });
    reportCwd(repo);
    const started = await call<MinimalWorkflowStartV1>(unnamed);
    expect(started.error).toBeNull();
    expect(started.data!.defaultsUsed).toContain("workspace");
    expect(rootWorkspaces()).toEqual([path.basename(repo)]);
  });

  it("leaves no root, lease, run or consumed observation when a later step fails, and keeps the step's own code", async () => {
    const { continuity, call, counts, writeFile } = await harness();
    // Fail after the root opened and the lease was claimed: the run start's correlation step.
    vi.spyOn(continuity, "prepareWorkflowStart").mockImplementation(() => { throw new Error("injected correlation failure"); });
    const failed = await call<MinimalWorkflowStartV1>(minimal);
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("MCP_UNAVAILABLE");
    expect(counts()).toEqual({ convergence_roots: 0, convergence_leases: 0, workflow_runs: 0, execution_observation_claims: 0 });
    // The injected failure is an infrastructure code: this window's edits pass.
    for (const name of ["a.ts", "b.ts", "c.ts"]) expect(writeFile(name)).toEqual({});
  });

  it("rolls back a failed claim step, keeps its own code, and keeps a non-infrastructure failure enforced", async () => {
    const { service, call, counts, writeFile } = await harness();
    // Fail at the claim step, after the root opened, with its own contract code.
    const claim = vi.spyOn(service, "claimWorkflowAttempt").mockReturnValue({ schemaVersion: "1.0.0", ok: false, data: null,
      error: { code: "LEASE_CONFLICT", message: "injected", details: { reasonCode: "INJECTED" } } });
    const conflicted = await call<MinimalWorkflowStartV1>(minimal);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(conflicted.error).toMatchObject({ code: "LEASE_CONFLICT", details: { reasonCode: "INJECTED" } });
    expect(counts()).toEqual({ convergence_roots: 0, convergence_leases: 0, workflow_runs: 0, execution_observation_claims: 0 });
    // A LEASE_CONFLICT is not an infrastructure failure: the session stays enforced.
    for (const name of ["a.ts", "b.ts"]) writeFile(name);
    expect(isDeny(writeFile("c.ts"))).toBe(true);
  });

  it("3.2.1 refuses stages whose passed record needs an artifact target it cannot fix, and leaves nothing behind", async () => {
    const { call, counts } = await harness();
    const refused = await call({ ...minimal, stages: ["minimal-implementation", "test-sensitivity-review", "change-code-review"] });
    expect(refused.error).toMatchObject({ code: "INVALID_INPUT",
      details: { field: "stages", capabilities: ["test-sensitivity-review", "change-code-review"] } });
    expect(refused.error?.message).toContain("plan_workflow and taskEnvelope.artifactContracts");
    expect(counts()).toEqual({ convergence_roots: 0, convergence_leases: 0, workflow_runs: 0, execution_observation_claims: 0 });
  });

  it("rejects invalid input without recording a pass, and passes the window after an infrastructure failure", async () => {
    const { call, counts, writeFile } = await harness();
    expect((await call({ goal: "x", acceptanceCriteria: ["y"] })).error).toMatchObject({ code: "INVALID_INPUT", details: { field: "stages" } });
    expect((await call({ ...minimal, stages: ["no-such-capability"] })).error?.code).toBe("GATE_FAILED");
    for (const name of ["a.ts", "b.ts"]) writeFile(name);
    expect(isDeny(writeFile("c.ts"))).toBe(true);
    // The host reported no model for this call: the start cannot be attested, which the AGENT cannot fix.
    const unobserved = await call(minimal, false);
    expect(unobserved.ok).toBe(false);
    expect(["BINDING_REQUIRED", "BINDING_INVALID", "MCP_UNAVAILABLE"]).toContain(unobserved.error?.code);
    expect(counts().convergence_roots).toBe(0);
    expect(writeFile("c.ts")).toEqual({});
  });
});
