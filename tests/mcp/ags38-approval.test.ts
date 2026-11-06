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
// Structural embedding port: no import from the new implementation, so the same test runs on the defect revision.
interface Decision {
  reference: string; source: "user"; decision: "approve"; actions: Array<"replace-root" | "release-root">;
  rootIds: string[]; actorIds: string[]; expiresAt?: string; revoked?: boolean;
}
type ApprovalAccess = RootAccess & { resolveUserApproval(reference: string): Decision | null };
const approvalRef = "existing-user-decision";

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

function approvedAccess(f: ReturnType<typeof fixture>, changes: Partial<Decision> = {}): ApprovalAccess {
  return { ...f.access, resolveUserApproval: reference => reference === approvalRef ? {
    reference, source: "user", decision: "approve", actions: ["replace-root", "release-root"],
    rootIds: [f.root.rootId], actorIds: [f.access.actorId!], ...changes,
  } : null };
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
  for (const action of ["replace-root", "release-root"] as const) {
    const call = (f: ReturnType<typeof fixture>, references: string[], access: RootAccess) => action === "replace-root"
      ? f.replace(references, access) : f.release(references, access);
    const setup = () => fixture(action === "replace-root" ? "needs-review" : "open");
    it(`AP03 rejects unresolved refs for ${action}`, () => {
      const f = setup();
      expect(call(f, ["unknown-user-decision"], approvedAccess(f)).ok).toBe(false);
      expect(f.stored()).toEqual(f.root);
    });
    for (const [dimension, mismatch] of [
      ["reference", { reference: "different-ref" }], ["root", { rootIds: ["different-root"] }],
      ["actor", { actorIds: ["different-actor"] }],
      ["action", { actions: [action === "replace-root" ? "release-root" : "replace-root"] }],
      ["revoked", { revoked: true }],
    ] as Array<[string, Partial<Decision>]>) {
      it(`AP04 rejects a mismatched ${dimension} for ${action}`, () => {
        const f = setup();
        expect(call(f, [approvalRef], approvedAccess(f, mismatch)).ok).toBe(false);
        expect(f.stored()).toEqual(f.root);
      });
    }
    for (const expiresAt of ["2000-01-01T00:00:00.000Z", "invalid-time"]) {
      it(`AP05 rejects expired or malformed stated expiry ${expiresAt} for ${action}`, () => {
        const f = setup();
        expect(call(f, [approvalRef], approvedAccess(f, { expiresAt })).ok).toBe(false);
        expect(f.stored()).toEqual(f.root);
      });
    }
    for (const expiresAt of [undefined, "2999-01-01T00:00:00.000Z"]) {
      it(`AP06 accepts an existing bound decision with expiry ${expiresAt ?? "not stated"} for ${action}`, () => {
        const f = setup();
        const decision = expiresAt === undefined ? {} : { expiresAt };
        const result = call(f, [approvalRef], approvedAccess(f, decision));
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({ state: action === "replace-root" ? "open" : "abandoned" });
      });
    }
    it(`AP07 rejects duplicate refs for ${action}`, () => {
      const f = setup();
      expect(call(f, [approvalRef, approvalRef], approvedAccess(f)).ok).toBe(false);
      expect(f.stored()).toEqual(f.root);
    });
  }
  it("AP08 reuses one existing decision covering two roots without consuming it", () => {
    const first = fixture();
    const second = fixture();
    const access = approvedAccess(first, { rootIds: [first.root.rootId, second.root.rootId] });
    expect(first.release([approvalRef], access).error).toBeNull();
    expect(second.release([approvalRef], access).error).toBeNull();
  });
  it("AP10 keeps the online owner protected even with a valid decision", () => {
    const f = fixture();
    const access = approvedAccess(f);
    expect(f.release([approvalRef], { ...access, ownerPresence: rootId => ({ ...access.ownerPresence(rootId), state: "online" }) }).error?.details)
      .toMatchObject({ reason: "OWNER_SESSION_ONLINE" });
    expect(f.stored()).toEqual(f.root);
  });
  it("AP11 preserves replacement ownership checks even with a valid decision", () => {
    const f = fixture("needs-review");
    expect(f.replace([approvalRef], { ...approvedAccess(f), ownedByOtherSession: () => true }).error?.details).toMatchObject({ reason: "ROOT_NOT_OWNED" });
    expect(f.stored()).toEqual(f.root);
  });
});
