import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowContractError, type ConvergenceRootV1, type TaskEnvelopeV1 } from "../../contracts/types.js";
import { applyPatchTargets } from "../../mcp-server/src/builtin-hook-host-adapters.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook, underVersionControl } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService, minimalWorkflowStartExample, WORKFLOW_FILE_LIMIT } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { msg } from "../../mcp-server/src/i18n.js";

// Design docs/ags30-phase-check-design.md 7 (enforcement, 3.1.0). Synthetic hook inputs and stores; no real host run.
// Product paths are synthetic paths inside this checkout (under version control, outside the OS temporary directory,
// which the gate exempts); they are never created. A file outside any checkout is not a product file (7.3).
const session = "enforce-session";
const at = "2026-11-02T09:00:00.000Z";
const repo = fileURLToPath(new URL("../../.phase-fixture/repo", import.meta.url));
const outsideCheckout = path.resolve(process.platform === "win32" ? "C:\\ags-phase-no-vcs" : "/ags-phase-no-vcs");
const file = (name: string) => path.join(repo, name);
const stores = new Set<SqliteContinuityStore>();
const NO_ENV: NodeJS.ProcessEnv = {};
const EN_ENV: NodeJS.ProcessEnv = { AGENT_GOVERNANCE_LOCALE: "en" };
// The start example every refusal names, byte for byte, in each shipped locale.
const KO_EXAMPLE = 'start_workflow {"goal":"<목표>","stages":["minimal-implementation"],"acceptanceCriteria":["<수용 기준>"],"writeTargets":["<바꿀 경로>"]}';
const EN_EXAMPLE = 'start_workflow {"goal":"<goal>","stages":["minimal-implementation"],"acceptanceCriteria":["<acceptance criterion>"],"writeTargets":["<path to change>"]}';

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
});

function root(state: ConvergenceRootV1["state"], rootId = "enforce-root", scope = "src", workspace = repo): ConvergenceRootV1 {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "enforce-task", objective: `Enforcement fixture ${rootId}.`,
    scope: { included: [scope], excluded: [] }, acceptanceCriteria: ["Tests pass."], riskLevel: "low",
    workUnits: [{ id: "work", objective: "Work.", dependencies: [], writeTargets: [scope] }],
    requiredCapabilities: [], constraints: [], authorization: { allowedActions: [], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame = {
    schemaVersion: "1.0.0" as const, workspace: { workspaceId: "repo", locator: workspace }, controlArtifacts: [], targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 },
  };
  return {
    schemaVersion: "1.0.0", rootId, parentRootId: null, revision: 1, state, currentEpoch: 1, taskEnvelope: task, frame,
    taskDigest: convergenceDigest(task), frameDigest: convergenceDigest(frame), workspaceDigest: convergenceDigest(frame.workspace),
    controlDigest: convergenceDigest(frame.controlArtifacts), targetDigest: convergenceDigest(frame.targetArtifacts),
    operationalDigest: convergenceDigest(frame.operationalSettings), userApprovalRefs: [], createdAt: at, updatedAt: at,
  };
}

/** A workflow store whose roots (write scope `scope`, default src) have one run each in `runState` (null: no run). */
function workflowWith(roots: Array<{ state: ConvergenceRootV1["state"]; rootId: string; runState: string | null; scope?: string; workspace?: string }>) {
  const workflow = new InMemoryWorkflowStore();
  for (const item of roots) expect(workflow.insertConvergenceRoot(root(item.state, item.rootId, item.scope, item.workspace))).toBeNull();
  const snapshot = workflow.getConvergenceSnapshot.bind(workflow);
  vi.spyOn(workflow, "getConvergenceSnapshot").mockImplementation(rootId => {
    const current = snapshot(rootId);
    const item = roots.find(entry => entry.rootId === rootId);
    return current ? { ...current, workflowRunIds: item?.runState ? [`run-${rootId}`] : [] } : null;
  });
  vi.spyOn(workflow, "getRun").mockImplementation(runId => {
    const item = roots.find(entry => `run-${entry.rootId}` === runId);
    return item?.runState ? { state: item.runState, plan: { stages: [{ stageId: "stage-01-testing" }] }, stageResults: [] } as never : null;
  });
  return workflow;
}

function service(workflow: InMemoryWorkflowStore | null = null, failure: string | null = null) {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, null, workflow, () => new Date(at), failure);
}

function events(target: ContinuityService): string[] {
  const database = (target.store as unknown as { database: DatabaseSync }).database;
  return database.prepare("SELECT event FROM continuity_observations ORDER BY observation_id").all().map(row => String(row.event));
}

const edit = (host: string, tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_name: tool, tool_input: toolInput, ...extra });
const write = (name: string, extra: Record<string, unknown> = {}) => edit("claude-code", "Write", { file_path: file(name), content: "x" }, extra);
const stop = (extra: Record<string, unknown> = {}) => ({ hook_event_name: "Stop", session_id: session, ...extra });
const isDeny = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";
const reason = (output: Record<string, unknown>) => String((output.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason);

describe("edit target extraction", () => {
  it("reads every file of a multi-file apply_patch, including moves and CRLF patches", () => {
    const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+x", "*** Update File: src/old.ts", "*** Move to: src/moved.ts",
      "@@", "-a", "+b", "*** Delete File: docs/gone.md", "*** End Patch"].join("\r\n");
    expect(applyPatchTargets(patch)).toEqual(["src/new.ts", "src/old.ts", "src/moved.ts", "docs/gone.md"]);
    expect(applyPatchTargets(42)).toEqual([]);
  });

  it("resolves relative patch paths against the hook's cwd and names each host's own target key", () => {
    const codex = adaptHostInput(edit("codex", "apply_patch", { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: /abs/b.ts\n*** End Patch" }), "codex");
    expect(codex.observation.editTargets).toEqual([file(path.join("src", "a.ts")), path.resolve(repo, "/abs/b.ts")]);
    expect(adaptHostInput(edit("claude-code", "NotebookEdit", { notebook_path: "nb.ipynb" }), "claude-code").observation.editTargets).toEqual([file("nb.ipynb")]);
    expect(adaptHostInput(edit("claude-code", "Edit", { file_path: file("x.ts") }), "claude-code").observation.editTargets).toEqual([file("x.ts")]);
    expect(adaptHostInput(edit("antigravity", "Write", { TargetFile: file("y.ts") }), "antigravity").observation.editTargets).toEqual([file("y.ts")]);
    // agy 1.4.12 CLI hook input (test server capture): write_file and edit_file, mapped to Write and Edit, name Path.
    expect(adaptHostInput(edit("antigravity", "Write", { Path: file("p.ts"), Content: "x", Overwrite: true }), "antigravity").observation.editTargets).toEqual([file("p.ts")]);
    expect(adaptHostInput(edit("antigravity", "Edit", { Path: file("p.ts"), Target: "x", Replacement: "y" }), "antigravity").observation.editTargets).toEqual([file("p.ts")]);
    // Shell, delegation and read tools are not edits; an edit tool without a readable target is still an edit.
    expect(adaptHostInput(edit("claude-code", "Bash", { command: "sed -i s/a/b/ x" }), "claude-code").observation.editTargets).toBeUndefined();
    expect(adaptHostInput(edit("codex", "apply_patch", {}), "codex").observation.editTargets).toEqual([]);
  });
});

describe("workflow gate", () => {
  it(`refuses the ${WORKFLOW_FILE_LIMIT}rd distinct product file without a workflow and keeps the counted files editable`, () => {
    const target = service();
    expect(handleContinuityHook(write("a.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(write("b.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(write("a.ts"), target, "claude-code", NO_ENV)).toEqual({});
    const denied = handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV);
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `[AGS] workflow 없이 제품 파일 3개째 변경: ${file("c.ts")} (앞서 바꾼 제품 파일 2개 포함). 먼저 workflow를 시작하라(최소 시작 호출 예: ${KO_EXAMPLE}).` } });
    // Only refusals and distinct files are rows; the refused file is not counted.
    expect(events(target).filter(event => event === "phase-file")).toHaveLength(2);
    expect(events(target).filter(event => event === "phase-deny")).toHaveLength(1);
  });

  it("renders the refusal and its start example in the host locale (AGENT_GOVERNANCE_LOCALE=en)", () => {
    expect(minimalWorkflowStartExample("ko")).toBe(KO_EXAMPLE);
    expect(minimalWorkflowStartExample("en")).toBe(EN_EXAMPLE);
    const target = service();
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", EN_ENV)).toEqual({});
    expect(reason(handleContinuityHook(write("c.ts"), target, "claude-code", EN_ENV))).toBe(
      `[AGS] Changing a 3rd product file without a workflow: ${file("c.ts")} (including 2 product files changed earlier). Start a workflow first (minimal start call: ${EN_EXAMPLE}).`);
    // An unreadable target is shown in the same locale; the locale changes only the text, never the count.
    const unread = service();
    const patch = (name: string) => edit("codex", "apply_patch", { command: `*** Begin Patch\n*** Update File: ${name}\n*** End Patch` });
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(patch(name), unread, "codex", EN_ENV)).toEqual({});
    expect(reason(handleContinuityHook(edit("codex", "apply_patch", {}), unread, "codex", EN_ENV)))
      .toMatch(/^\[AGS\] Changing a 3rd product file without a workflow: \(path unknown: apply_patch\) \(including 2 product files changed earlier\)\./u);
  });

  it("refuses the third agy CLI write_file by its Path", () => {
    const target = service();
    const agy = (name: string) => edit("antigravity", "Write", { Path: file(name), Content: "x", Overwrite: true });
    expect(handleContinuityHook(agy("a.ts"), target, "antigravity", NO_ENV)).toEqual({});
    expect(handleContinuityHook(agy("b.ts"), target, "antigravity", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(agy("c.ts"), target, "antigravity", NO_ENV))).toBe(true);
  });

  it("counts each edit call whose target could not be read as its own file", () => {
    const target = service();
    const unread = () => edit("claude-code", "Write", { content: "x" });
    expect(handleContinuityHook(unread(), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(unread(), target, "claude-code", NO_ENV)).toEqual({});
    const denied = handleContinuityHook(unread(), target, "claude-code", NO_ENV);
    expect(reason(denied)).toContain("(경로 미확인: Write)");
  });

  it("refuses one patch that adds three files at once, and Codex gets the same deny shape", () => {
    const target = service();
    const patch = ["*** Begin Patch", "*** Add File: a.ts", "*** Add File: b.ts", "*** Add File: c.ts", "*** End Patch"].join("\n");
    const output = handleContinuityHook(edit("codex", "apply_patch", { command: patch }), target, "codex", NO_ENV);
    expect(isDeny(output)).toBe(true);
    expect(reason(output)).toContain("workflow 없이 제품 파일 3개째 변경");
  });

  it("does not count the OS temporary directory, the host's memory folder or a configured exempt path", () => {
    const target = service();
    const home = path.resolve(repo, "..", "home");
    const environment = { HOME: home, USERPROFILE: home, AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS: path.join(repo, "notes") };
    const paths = [path.join(tmpdir(), "scratch.md"),
      path.join(home, ".claude", "projects", "D--proj", "memory", "MEMORY.md"), path.join(repo, "notes", "n1.md"), path.join(repo, "notes", "n2.md")];
    for (const value of paths) expect(handleContinuityHook(edit("claude-code", "Write", { file_path: value }), target, "claude-code", environment)).toEqual({});
    expect(events(target)).not.toContain("phase-file");
    // Positive control: the same environment still counts product files.
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", environment)).toEqual({});
    expect(isDeny(handleContinuityHook(write("c.ts"), target, "claude-code", environment))).toBe(true);
  });

  it("does not count notes and documents outside any checkout, so they never lock the gate", () => {
    const target = service();
    for (const name of ["inquiry.md", "guide.md", "report.md", "notes.md"]) {
      expect(handleContinuityHook(edit("codex", "apply_patch", { command: `*** Begin Patch\n*** Add File: ${path.join(outsideCheckout, name)}\n*** End Patch` }),
        target, "codex", NO_ENV)).toEqual({});
    }
    expect(events(target)).not.toContain("phase-file");
    expect(events(target)).not.toContain("phase-deny");
  });

  // Defect N8 (3.4.0): a path outside version control was dropped before the gated check, so the files of a gated root
  // whose write scope lies outside any checkout could be changed with an edit tool.
  it("refuses a gated root's scope outside any checkout and still neither counts nor records other such files", () => {
    const target = service(workflowWith([{ state: "needs-review", rootId: "gated-outside", runState: "failed", workspace: outsideCheckout }]));
    const outside = (name: string) => edit("claude-code", "Write", { file_path: path.join(outsideCheckout, name), content: "x" });
    expect(reason(handleContinuityHook(outside("src/x.ts"), target, "claude-code", NO_ENV))).toContain("gated-outside");
    for (const name of ["notes.md", "report.md", "guide.md"]) expect(handleContinuityHook(outside(name), target, "claude-code", NO_ENV)).toEqual({});
    expect(events(target).filter(event => ["phase-edit", "phase-file", "phase-deny"].includes(event))).toEqual([]);
  });

  it("finds the checkout of a new file in new folders, a worktree's .git file and another version control's root", () => {
    const base = mkdtempSync(path.join(tmpdir(), "ags-vcs-"));
    try {
      mkdirSync(path.join(base, "git", ".git"), { recursive: true });
      mkdirSync(path.join(base, "worktree"));
      writeFileSync(path.join(base, "worktree", ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
      mkdirSync(path.join(base, "hg", ".hg"), { recursive: true });
      mkdirSync(path.join(base, "plain"));
      expect(underVersionControl(path.join(base, "git", "new", "deeper", "a.ts"))).toBe(true);
      expect(underVersionControl(path.join(base, "worktree", "src", "b.ts"))).toBe(true);
      expect(underVersionControl(path.join(base, "hg", "c.ts"))).toBe(true);
      expect(underVersionControl(path.join(base, "plain", "d.md"))).toBe(false);
      expect(underVersionControl(path.join(base, "missing", "e.md"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("compares Windows paths without case or separator differences", () => {
    if (process.platform !== "win32") return;
    const target = service();
    expect(handleContinuityHook(write("A.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(edit("claude-code", "Edit", { file_path: file("a.TS").replaceAll("\\", "/") }), target, "claude-code", NO_ENV)).toEqual({});
    expect(events(target).filter(event => event === "phase-file")).toHaveLength(1);
  });

  it("keeps the lock across phase checks until a workflow starts, then counts a new window", () => {
    const workflow = workflowWith([{ state: "open", rootId: "enforce-root", runState: "running" }]);
    const target = service(workflow);
    for (const name of ["a.ts", "b.ts"]) handleContinuityHook(write(name), target, "claude-code", NO_ENV);
    expect(isDeny(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV))).toBe(true);
    // A turn end resets the file window but not the lock: even a counted file is refused now.
    expect(handleContinuityHook(stop(), target, "claude-code", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(write("a.ts"), target, "claude-code", NO_ENV))).toBe(true);
    target.prepareWorkflowStart(session, "enforce-root");
    expect(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(write("d.ts"), target, "claude-code", NO_ENV)).toEqual({});
    // The start after a refusal is recorded as such (success = 1) for the deny-then-start rate.
    const database = (target.store as unknown as { database: DatabaseSync }).database;
    expect(database.prepare("SELECT success FROM continuity_observations WHERE event = 'phase-workflow-start'").all().map(row => row.success)).toEqual([1]);
  });

  it("treats an abandoned root, a finished run and a root without a run as no workflow", () => {
    for (const item of [
      { state: "abandoned" as const, rootId: "enforce-root", runState: "running" },
      { state: "completed" as const, rootId: "enforce-root", runState: "passed" },
      { state: "open" as const, rootId: "enforce-root", runState: "blocked" },
      { state: "open" as const, rootId: "enforce-root", runState: null },
    ]) {
      const target = service(workflowWith([item]));
      const correlation = target.correlateSession(session);
      target.store.ensureTask(correlation, at);
      expect(target.store.bindRoot(correlation, 1, "enforce-root", at)).toBe(true);
      for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
      expect(isDeny(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV))).toBe(true);
    }
  });

  it("counts edits inside an active workflow's write scope in no window, so a finished workflow starts a new count", () => {
    const roots = [{ state: "open" as const, rootId: "enforce-root", runState: "running" as string | null }];
    const target = service(workflowWith(roots));
    handleContinuityHook(write("a.ts"), target, "claude-code", NO_ENV);
    target.prepareWorkflowStart(session, "enforce-root");
    for (const name of ["b.ts", "c.ts", "d.ts"]) expect(handleContinuityHook(write(path.join("src", name)), target, "claude-code", NO_ENV)).toEqual({});
    roots[0]!.runState = "passed";
    for (const name of ["e.ts", "f.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(write("g.ts"), target, "claude-code", NO_ENV))).toBe(true);
  });

  it("adds a subagent's edits to its parent session's window", () => {
    const target = service();
    expect(handleContinuityHook(write("a.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(write("b.ts", { agent_id: "child-1", agent_type: "general-purpose" }), target, "claude-code", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(write("c.ts", { agent_id: "child-2", agent_type: "general-purpose" }), target, "claude-code", NO_ENV))).toBe(true);
    // A Codex child (agent_id with the parent's session_id) counts the same way.
    const codex = service();
    const patch = (name: string) => edit("codex", "apply_patch", { command: `*** Begin Patch\n*** Add File: ${name}\n*** End Patch` }, { agent_id: "codex-child" });
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(patch(name), codex, "codex", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(patch("c.ts"), codex, "codex", NO_ENV))).toBe(true);
  });
});

describe("infrastructure failures fail open with their cause", () => {
  it("passes edits when the workflow store did not open, and names the open failure's own code once at Stop", () => {
    const target = service(null, "WORKFLOW_MCP_UNAVAILABLE");
    const correlation = target.correlateSession(session);
    target.store.ensureTask(correlation, at);
    expect(target.store.bindRoot(correlation, 1, "enforce-root", at)).toBe(true);
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    const output = handleContinuityHook(stop(), target, "claude-code", NO_ENV);
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "Stop",
      additionalContext: "[AGS] workflow 상태를 확인하지 못해 이번 구간의 제품 파일 변경을 막지 않았다. 원인 코드: phase-gate-unavailable:WORKFLOW_MCP_UNAVAILABLE." } });
    expect(handleContinuityHook(stop(), target, "claude-code", NO_ENV)).toEqual({});
  });

  it("passes the window after a workflow start infrastructure failure and names its code, not a generic one", () => {
    const target = service();
    for (const name of ["a.ts", "b.ts"]) handleContinuityHook(write(name), target, "claude-code", NO_ENV);
    target.recordWorkflowStartFailure(session, new WorkflowContractError("BINDING_REQUIRED", msg("workflow.service.unkeyedFailure", { message: "No host observation." }), { reasonCode: "TRANSCRIPT_LIMIT_EXCEEDED" }));
    expect(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(stop(), target, "claude-code", NO_ENV)).toMatchObject({ hookSpecificOutput: {
      additionalContext: expect.stringContaining("원인 코드: workflow-start-failed:BINDING_REQUIRED:TRANSCRIPT_LIMIT_EXCEEDED.") } });
    // The pass ends with the window: the next window is enforced again.
    for (const name of ["d.ts", "e.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(write("f.ts"), target, "claude-code", NO_ENV))).toBe(true);
  });

  it("names a start failure without claiming edits were let through when every edit stayed inside an active root", () => {
    const target = service(workflowWith([{ state: "open", rootId: "root-alpha", runState: "running", scope: "alpha" }]));
    target.prepareWorkflowStart(session, "root-alpha");
    target.recordWorkflowStartFailure(session, new WorkflowContractError("BINDING_REQUIRED", msg("workflow.service.unkeyedFailure", { message: "No host observation." }), { reasonCode: "TRANSCRIPT_LIMIT_EXCEEDED" }));
    expect(handleContinuityHook(write("alpha/1.ts"), target, "claude-code", NO_ENV)).toEqual({});
    const text = String((handleContinuityHook(stop(), target, "claude-code", NO_ENV).hookSpecificOutput as Record<string, unknown>).additionalContext);
    expect(text).toContain("[AGS] 이번 구간에 workflow 시작이 실패했다. 원인 코드: workflow-start-failed:BINDING_REQUIRED:TRANSCRIPT_LIMIT_EXCEEDED. 편집 관문은 평소대로 판정했다.");
    expect(text).not.toContain("막지 않았다");
  });
});

describe("Stop output", () => {
  it("gives no output for a window below the limit without a workflow", () => {
    const target = service();
    for (const name of ["a.ts", "b.ts"]) handleContinuityHook(write(name), target, "claude-code", NO_ENV);
    expect(handleContinuityHook(stop(), target, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(stop(), target, "codex", NO_ENV)).toEqual({});
  });

  it("Codex: a turn already continued by Stop (stop_hook_active) gets no second continuation, and the check is recorded", () => {
    const target = service(workflowWith([{ state: "open", rootId: "enforce-root", runState: "running" }]));
    target.prepareWorkflowStart(session, "enforce-root");
    handleContinuityHook(edit("codex", "apply_patch", { command: "*** Begin Patch\n*** Add File: a.ts\n*** End Patch" }), target, "codex", NO_ENV);
    expect(handleContinuityHook(stop({ stop_hook_active: true }), target, "codex", NO_ENV)).toEqual({});
    expect(events(target).at(-1)).toBe("phase-check");
    handleContinuityHook(edit("codex", "apply_patch", { command: "*** Begin Patch\n*** Add File: b.ts\n*** End Patch" }), target, "codex", NO_ENV);
    expect(handleContinuityHook(stop({ stop_hook_active: false }), target, "codex", NO_ENV)).toMatchObject({ decision: "block" });
  });
});

// Several workflows per session (3.3.0): each bound root's write scope passes, a gated scope refuses everyone.
describe("several workflows in one session", () => {
  it("passes edits inside each of two active roots of one session and still counts the paths outside both", () => {
    const target = service(workflowWith([
      { state: "open", rootId: "root-alpha", runState: "running", scope: "alpha" },
      { state: "open", rootId: "root-beta", runState: "running", scope: "beta" },
    ]));
    target.prepareWorkflowStart(session, "root-alpha");
    target.prepareWorkflowStart(session, "root-beta");
    for (const name of ["alpha/1.ts", "alpha/2.ts", "beta/1.ts", "beta/2.ts"]) {
      expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    }
    expect(events(target).filter(event => event === "phase-file")).toHaveLength(0);
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    expect(isDeny(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV))).toBe(true);
  });

  it("refuses an edit outside a running workflow's write scope as outside that scope and names a second workflow", () => {
    const target = service(workflowWith([{ state: "open", rootId: "root-alpha", runState: "running", scope: "alpha" }]));
    target.prepareWorkflowStart(session, "root-alpha");
    for (const name of ["alpha/1.ts", "a.ts", "b.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
    expect(reason(handleContinuityHook(write("c.ts"), target, "claude-code", NO_ENV))).toBe(`[AGS] 진행 중인 workflow의 writeTargets 밖 제품 파일 3개째 변경: ${file("c.ts")} (앞서 바꾼 범위 밖 제품 파일 2개 포함). `
      + `진행 중인 작업과 다른 작업이면 겹치지 않는 writeTargets로 workflow를 하나 더 시작하라. 한 세션은 workflow 여러 개를 함께 진행할 수 있다(최소 시작 호출 예: ${KO_EXAMPLE}).`);
    expect(reason(handleContinuityHook(write("d.ts"), target, "claude-code", EN_ENV))).toBe(`[AGS] Changing a 3rd product file outside the writeTargets of the running workflows: ${file("d.ts")} `
      + `(including 2 product files changed earlier outside them). If this is a different task from the running work, start another workflow with writeTargets that do not overlap. `
      + `One session can run several workflows together (minimal start call: ${EN_EXAMPLE}).`);
  });

  it("shows the pending stages and goal of every active root at Stop", () => {
    const target = service(workflowWith([
      { state: "open", rootId: "root-alpha", runState: "running", scope: "alpha" },
      { state: "open", rootId: "root-beta", runState: "running", scope: "beta" },
    ]));
    target.prepareWorkflowStart(session, "root-alpha");
    target.prepareWorkflowStart(session, "root-beta");
    handleContinuityHook(write("alpha/1.ts"), target, "claude-code", EN_ENV);
    const text = String((handleContinuityHook(stop(), target, "claude-code", EN_ENV).hookSpecificOutput as Record<string, unknown>).additionalContext);
    expect(text).toContain("Workflow goal: Enforcement fixture root-alpha.");
    expect(text).toContain("Workflow goal: Enforcement fixture root-beta.");
  });

  it.each(["needs-review", "needs-user"] as const)("refuses a %s root's scope for its own session, another session and another checkout, even after a failed start", state => {
    const target = service(workflowWith([{ state, rootId: "gated-root", runState: "failed" }]));
    target.prepareWorkflowStart(session, "gated-root");
    // A recorded start failure lets the window pass, but never a gated scope.
    target.recordWorkflowStartFailure(session, new WorkflowContractError("BINDING_INVALID", msg("continuity.binding.stale", {})));
    const own = handleContinuityHook(write("src/x.ts"), target, "claude-code", EN_ENV);
    expect(reason(own)).toBe(`[AGS] ${file("src/x.ts")} is in the write scope of workflow root gated-root (${state}), which awaits a decision, so it cannot be changed. Change it after that root is decided with resolve_convergence_gate, and keep working on parts that do not overlap.`);
    expect(isDeny(handleContinuityHook({ ...write("src/y.ts"), session_id: "another-session" }, target, "claude-code", NO_ENV))).toBe(true);
    // Outside the gated scope the start failure still lets this window pass.
    for (const name of ["a.ts", "b.ts", "c.ts"]) expect(handleContinuityHook(write(name), target, "claude-code", NO_ENV)).toEqual({});
  });

  it("refuses the same checkout-relative path of a gated root in another checkout of its repository", () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ags-gated-")));
    try {
      const main = path.join(base, "main"), linked = path.join(base, "linked");
      mkdirSync(path.join(main, ".git", "worktrees", "linked"), { recursive: true });
      writeFileSync(path.join(main, ".git", "worktrees", "linked", "commondir"), "../..\n");
      mkdirSync(linked);
      writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "linked")}\n`);
      const target = service(workflowWith([{ state: "needs-review", rootId: "gated-root", runState: "failed", workspace: main }]));
      expect(target.gateEditForSession("another-session", [path.join(linked, "src", "x.ts")])).toMatchObject({ key: "hooks.editGate.gatedRoot" });
      expect(target.gateEditForSession("another-session", [path.join(linked, "docs", "x.md")])).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("moves the epoch on only when every bound root has settled", () => {
    const roots = [
      { state: "open" as const, rootId: "root-alpha", runState: "passed" as string | null, scope: "alpha" },
      { state: "open" as const, rootId: "root-beta", runState: "running" as string | null, scope: "beta" },
    ];
    const target = service(workflowWith(roots));
    target.prepareWorkflowStart(session, "root-alpha");
    target.prepareWorkflowStart(session, "root-beta");
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: "root-beta" });
    roots[1]!.runState = "failed";
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
    // Ownership outlives the epoch, so a settled open root can still be continued by this session only.
    expect(target.ownsRoot(session, "root-alpha")).toBe(true);
    expect(target.ownsRoot("another-session", "root-alpha")).toBe(false);
  });

  it("does not move the epoch while an older root runs, even when the newest (primary) root has settled", () => {
    const roots = [
      { state: "open" as const, rootId: "root-alpha", runState: "running" as string | null, scope: "alpha" },
      { state: "open" as const, rootId: "root-beta", runState: "passed" as string | null, scope: "beta" },
    ];
    const target = service(workflowWith(roots));
    target.prepareWorkflowStart(session, "root-alpha");
    target.prepareWorkflowStart(session, "root-beta");
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: "root-beta" });
    roots[0]!.runState = "blocked";
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
  });

  it("refuses to bind a root another session already bound, and lets its own session bind it again", () => {
    const target = service(workflowWith([{ state: "open", rootId: "root-alpha", runState: "running", scope: "alpha" }]));
    target.prepareWorkflowStart(session, "root-alpha");
    expect(() => target.prepareWorkflowStart("another-session", "root-alpha"))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT", details: { reason: "ROOT_NOT_OWNED", rootId: "root-alpha" } }));
    expect(target.ownsRoot("another-session", "root-alpha")).toBe(false);
    expect(() => target.prepareWorkflowStart(session, "root-alpha")).not.toThrow();
  });

  it("keeps refusing a gated scope and keeps ROOT_CONFLICT after the machine is renamed", () => {
    const workflow = workflowWith([{ state: "needs-review", rootId: "gated-root", runState: "failed" }]);
    const target = service(workflow);
    const hostname = vi.spyOn(os, "hostname").mockReturnValue("renamed-machine");
    expect(target.gateEditForSession("another-session", [file("src/x.ts")])).toMatchObject({ key: "hooks.editGate.gatedRoot" });
    expect(workflow.insertConvergenceRoot(root("open", "overlapping-root", "src/inner"))).toMatchObject({ kind: "physical" });
    hostname.mockRestore();
  });

  it("checks gated scopes first when a bound root cannot be read, and names a failed store open at Stop", () => {
    const workflow = workflowWith([
      { state: "needs-review", rootId: "gated-root", runState: "failed" },
      { state: "open", rootId: "broken-root", runState: "running", scope: "alpha" },
    ]);
    const target = service(workflow);
    target.prepareWorkflowStart(session, "broken-root");
    const read = vi.mocked(workflow.getConvergenceSnapshot).getMockImplementation()!;
    vi.spyOn(workflow, "getConvergenceSnapshot").mockImplementation(rootId => {
      if (rootId === "broken-root") throw new Error("synthetic unreadable root");
      return read(rootId);
    });
    expect(target.gateEditForSession(session, [file("src/x.ts")])).toMatchObject({ key: "hooks.editGate.gatedRoot" });
    expect(target.gateEditForSession(session, [file("alpha/x.ts")])).toBeNull();
    // A store that failed to open cannot check gated roots even for a session without a workflow: Stop says so.
    const unopened = service(null, "WORKFLOW_MCP_UNAVAILABLE");
    expect(handleContinuityHook(write("a.ts"), unopened, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(stop(), unopened, "claude-code", NO_ENV)).toMatchObject({ hookSpecificOutput: {
      additionalContext: expect.stringContaining("phase-gate-unavailable:WORKFLOW_MCP_UNAVAILABLE") } });
    // A store that was never configured is not a failure.
    const unconfigured = service(null);
    expect(handleContinuityHook(write("a.ts"), unconfigured, "claude-code", NO_ENV)).toEqual({});
    expect(handleContinuityHook(stop(), unconfigured, "claude-code", NO_ENV)).toEqual({});
  });
});
