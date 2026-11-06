import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ConvergenceFrameV1, ConvergenceRootV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { WorkflowService, type RootAccess } from "../../mcp-server/src/workflow-service.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

function fixture(state: "open" | "needs-review" = "open") {
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-approval-"));
  directories.push(directory);
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "approval-task", objective: "Repair the authorized target.",
    scope: { included: ["target.ts"], excluded: [] }, acceptanceCriteria: ["The target is repaired."], riskLevel: "low",
    workUnits: [{ id: "edit", objective: "Repair target.", dependencies: [], writeTargets: ["target.ts"] }],
    requiredCapabilities: ["minimal-implementation"], constraints: [],
    authorization: { allowedActions: ["write"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame: ConvergenceFrameV1 = {
    schemaVersion: "1.0.0", workspace: { workspaceId: directory, locator: directory },
    controlArtifacts: [{ artifactId: "validator", role: "validator", locator: "test.ts", digest: convergenceDigest("validator") }],
    targetArtifacts: [{ artifactId: "target", role: "target", locator: "target.ts", digest: convergenceDigest("target") }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
  const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] });
  expect(opened.error).toBeNull();
  const root = opened.data!;
  if (state !== root.state) expect(store.updateConvergenceRoot({ ...root, state, revision: root.revision + 1 }, root.revision)).toBe(true);
  const stored = (): ConvergenceRootV1 => store.getConvergenceSnapshot(root.rootId)!.root;
  const access: RootAccess = {
    actorId: "actor:caller", ownsRoot: () => false, ownedByOtherSession: () => false,
    ownerPresence: () => ({ state: "ended", self: false, ownerBound: true, sessions: [], unavailable: null, observedAt: new Date().toISOString() }),
  };
  const replace = (userApprovalRefs: string[], caller: RootAccess = access) => service.openConvergenceRoot({ schemaVersion: "1.0.0",
    parentRootId: root.rootId, taskEnvelope: { ...task, taskId: "replacement-task" }, frame, userApprovalRefs }, caller);
  const release = (userApprovalRefs: string[], caller: RootAccess = access) => service.releaseConvergenceRoot({ rootId: root.rootId,
    expectedRevision: stored().revision, reason: "The user approved this root operation.", userApprovalRefs }, caller);
  return { root: stored(), stored, replace, release, access };
}

describe("AGS3-D-0008 root approval binding", () => {
  it("AP01 rejects an arbitrary replacement approval string without mutating the parent", () => {
    const f = fixture("needs-review");
    expect(f.replace(["anything"]).ok).toBe(false);
    expect(f.stored()).toEqual(f.root);
  });
  it("AP02 rejects an arbitrary foreign release approval string without mutating the root", () => {
    const f = fixture();
    expect(f.release(["anything"]).ok).toBe(false);
    expect(f.stored()).toEqual(f.root);
  });
  it("AP09 preserves the owner's approval-free release", () => {
    const f = fixture();
    expect(f.release([], { ...f.access, ownsRoot: () => true }).data).toMatchObject({ state: "abandoned" });
  });
});
