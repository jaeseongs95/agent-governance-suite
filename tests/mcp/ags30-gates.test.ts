import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AttemptLeaseV1, ConvergenceFrameV1, ConvergenceStatusV1, ObservedCallerV1, SkillDescriptorV2, SkillProviderV2,
  StageResultV1, TaskEnvelopeV1, WorkflowPlanV1, WorkflowReceiptV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { validateDecisionRecordSemantics } from "../../mcp-server/src/decision-record-validator.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";

// Regression cases for docs/ags30-gates-design.md §6. Each case failed on 4b2dc571.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const subject = `sha256:${"b".repeat(64)}` as const;
const digest = (bytes: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const root: ObservedCallerV1 = { actor: "host:root-session", parentChain: [], provenance: "unavailable" };
const observed = (actor: string, parentChain: string[] = []): ObservedCallerV1 => ({ actor, parentChain, provenance: "host-observed" });

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags30-gates-"));
  directories.push(directory);
  return directory;
}

function file(content: string, name = "evidence.txt"): string {
  const locator = path.join(scratch(), name);
  writeFileSync(locator, content);
  return locator;
}

function provider(overrides: Partial<SkillProviderV2>): SkillProviderV2 {
  return {
    capabilities: ["fixture-work"], executionClass: "workflow", phase: "execution", phaseOrder: 50,
    requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [],
    outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: ["MISSING_EVIDENCE"] },
    selectionCriteria: ["fixture"], preconditions: [], failureHandling: "Return a structured result.",
    gate: { kind: "none", policy: "none", validator: null }, ...overrides,
  };
}

const auditProvider = provider({
  capabilities: ["independent-audit"], phase: "completion-gate", phaseOrder: 90, producedArtifacts: ["gate-verdict"],
  stateMapping: { selector: "/output/gateVerdict", values: { PASS: { state: "passed", errorRequired: false } }, default: "reject", adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"] },
  gate: { kind: "completion", policy: "mandatory", validator: "independent-audit" },
});

function harness(providers: SkillProviderV2[], store: WorkflowStore = new InMemoryWorkflowStore()) {
  const directory = scratch();
  mkdirSync(path.join(directory, "contracts"));
  mkdirSync(path.join(directory, "skills"));
  for (const name of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json"]) {
    copyFileSync(path.join(repository, "contracts", name), path.join(directory, "contracts", name));
  }
  const skills: SkillDescriptorV2[] = providers.map((item, index) => ({ schemaVersion: "2.0.0", skillId: `gates-fixture-${index}`,
    version: "1.0.0", path: `./gates-fixture-${index}`, priority: 10, enabled: true, providers: [item] }));
  const registryPath = path.join(directory, "skills", "registry.json");
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills }));
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "gates-task", objective: "Exercise the AGS 3.0 gate contract.",
    scope: { included: ["candidate.txt"], excluded: [] }, acceptanceCriteria: ["Gates check what AGS observes."], riskLevel: "low",
    workUnits: [{ id: "work", objective: "Use fixture data.", dependencies: [], writeTargets: ["candidate.txt"] }],
    requiredCapabilities: providers.map((item) => item.capabilities[0]!), constraints: [],
    authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
    artifactContracts: providers.map((item) => ({ capability: item.capabilities[0]!,
      produced: item.producedArtifacts.map((artifactId) => ({ artifactId, schemaId: "fixture/v1", targetDigest: subject })) })),
  };
  return { service, store, task };
}

type Harness = ReturnType<typeof harness>;

function plan(h: Harness, requiredAuditPhase?: "post-execution"): WorkflowPlanV1 {
  const planned = h.service.planWorkflow(requiredAuditPhase
    ? { schemaVersion: "1.0.0", taskEnvelope: h.task, requiredAuditPhase }
    : h.task);
  expect(planned.error).toBeNull();
  return planned.data!;
}

function running(h: Harness, requiredAuditPhase?: "post-execution"): WorkflowReceiptV1 {
  const started = h.service.startWorkflow(plan(h, requiredAuditPhase));
  expect(started.error).toBeNull();
  return started.data!;
}

function stage(receipt: WorkflowReceiptV1, capability: string) {
  return receipt.plan.stages.find((item) => item.satisfiedCapabilities.includes(capability))!;
}

function result(receipt: WorkflowReceiptV1, capability: string, output: Record<string, unknown> = {}): StageResultV1 {
  const target = stage(receipt, capability);
  return {
    schemaVersion: "1.0.0", runId: receipt.runId, expectedRevision: receipt.revision, stageId: target.stageId, state: "passed",
    output: { schemaVersion: "1.0.0", kind: "output", output, error: null,
      artifacts: target.requiredArtifacts.map((artifactId) => ({ artifactId, schemaId: "fixture/v1", locator: `fixture:${artifactId}`,
        digest: "a".repeat(64), targetDigest: subject, verified: true })) },
    evidence: [{ artifactId: "fixture", kind: "test", locator: "fixture:observed", verified: true, note: "Synthetic fixture." }],
    findings: [], blockers: [], error: null,
  };
}

function auditOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { gateVerdict: "PASS", auditorId: "independent-auditor", implementationActorIds: ["implementation-actor"],
    auditTarget: subject, phase: "post-execution", freshContext: true, delegationAllowed: false,
    blockingFindings: [], stale: false, postExecutionVerified: true, ...overrides };
}

function frame(): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0", workspace: { workspaceId: "gates-workspace", locator: "fixture:gates-workspace" },
    controlArtifacts: [{ artifactId: "contract", role: "validator", locator: "fixture:contract", digest: `sha256:${"c".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "candidate.txt", digest: subject }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

function openRoot(h: Harness, parentRootId: string | null = null): string {
  const opened = h.service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId, taskEnvelope: h.task, frame: frame(),
    userApprovalRefs: parentRootId ? ["approval:replace-root"] : [] });
  expect(opened.error).toBeNull();
  return opened.data!.rootId;
}

function status(h: Harness, rootId: string): ConvergenceStatusV1 {
  return h.service.getConvergenceStatus(rootId).data!;
}

function proposal(h: Harness, rootId: string, evidenceRefs: string[] | null): Record<string, unknown> {
  const current = status(h, rootId);
  const fingerprint = current.outcomes.at(-1)?.failureFingerprint;
  return { schemaVersion: "1.0.0", rootId, expectedRevision: current.root.revision, taskEnvelope: h.task, frame: frame(),
    plan: plan(h), outputTargets: ["candidate.txt"],
    priorFailure: evidenceRefs ? { fingerprint, hypothesis: "A new observation distinguishes this retry.",
      changeSummary: "Retry with the new observation.", discriminator: "Compare the observed fixture.", evidenceRefs } : null };
}

function claim(h: Harness, rootId: string, evidenceRefs: string[] | null, caller: ObservedCallerV1 | null = root): AttemptLeaseV1 {
  const leased = h.service.claimWorkflowAttempt(proposal(h, rootId, evidenceRefs), false, caller);
  expect(leased.error).toBeNull();
  return leased.data!;
}

function startLease(h: Harness, lease: AttemptLeaseV1): WorkflowReceiptV1 {
  const started = h.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId,
    expectedRootRevision: lease.rootRevision, plan: plan(h) });
  expect(started.error).toBeNull();
  return started.data!;
}

/** One attempt that records `record` and is then aborted, so the root keeps a failure fingerprint. */
function abortedAttempt(h: Harness, rootId: string, attempt: number,
  record?: (receipt: WorkflowReceiptV1) => WorkflowReceiptV1): void {
  let receipt = startLease(h, claim(h, rootId, attempt === 1 ? null : [file(`observation ${attempt} ${rootId}`)]));
  if (record) receipt = record(receipt);
  expect(h.service.abortWorkflow(receipt.runId, receipt.revision).error).toBeNull();
}

function review(rootId: string, current: ConvergenceStatusV1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: "1.0.0", rootId, expectedRevision: current.root.revision, review: {
    schemaVersion: "1.0.0", reviewId: `review-${current.root.revision}`, rootId, rootRevision: current.root.revision,
    epoch: current.currentEpoch, reviewerActorId: "declared-reviewer",
    freshContext: { confirmed: true, evidenceRef: "fixture:fresh-review" }, classification: "semantics-preserving",
    comparability: { comparable: true, rationale: "Same fixture." }, route: "stop", proposedFrame: null,
    evidenceRefs: ["fixture:review"], userApprovalRefs: [], reviewedAt: new Date().toISOString(), ...extra } };
}

describe("D-0039 retry evidence is checked by bytes", () => {
  it("rejects a retry whose evidence is not a readable local file", () => {
    const h = harness([provider({})]);
    const rootId = openRoot(h);
    abortedAttempt(h, rootId, 1);
    const rejected = h.service.claimWorkflowAttempt(proposal(h, rootId, ["evidence-2"]), false, root);
    expect(rejected.error?.code).toBe("MISSING_EVIDENCE");
  });

  it("rejects the same bytes resubmitted under a different path", () => {
    const h = harness([provider({})]);
    const rootId = openRoot(h);
    abortedAttempt(h, rootId, 1);
    const first = startLease(h, claim(h, rootId, [file("same observation")]));
    expect(h.service.abortWorkflow(first.runId, first.revision).error).toBeNull();
    const rejected = h.service.claimWorkflowAttempt(proposal(h, rootId, [file("same observation", "copy.txt")]), false, root);
    expect(rejected.error?.code).toBe("NEW_EVIDENCE_REQUIRED");
  });
});

describe("D-0048 artifacts and evidence are checked by the server", () => {
  it("rejects a passing stage whose digest contradicts the local file", () => {
    const h = harness([provider({ producedArtifacts: ["report"] })]);
    const receipt = running(h);
    const recorded = result(receipt, "fixture-work");
    recorded.output.artifacts[0]!.locator = file("actual bytes");
    recorded.output.artifacts[0]!.digest = digest("other bytes").slice("sha256:".length);
    const failed = h.service.recordStageResult(recorded);
    expect(failed.error?.code).toBe("BINDING_INVALID");
    expect(failed.error?.details).toMatchObject({ reason: "ARTIFACT_DIGEST_MISMATCH" });
  });

  it("records sha256-matched only for a local file the server hashed", () => {
    const h = harness([provider({ producedArtifacts: ["report"] })]);
    const receipt = running(h);
    const recorded = result(receipt, "fixture-work");
    recorded.output.artifacts[0]!.locator = file("report bytes");
    recorded.output.artifacts[0]!.digest = digest("report bytes");
    const stored = h.service.recordStageResult(recorded).data!.stageResults[0]!;
    expect(stored.artifactChecks).toEqual([
      { source: "artifact", artifactId: "report", locator: recorded.output.artifacts[0]!.locator, check: "sha256-matched" },
      { source: "evidence", artifactId: "fixture", locator: "fixture:observed", check: "not-checked" },
    ]);
  });

  it("requires evidence for a required input no planned stage produces", () => {
    const h = harness([provider({ requiredInputArtifacts: ["external-input"] })]);
    const receipt = running(h);
    const missing = h.service.recordStageResult(result(receipt, "fixture-work"));
    expect(missing.error?.code).toBe("MISSING_EVIDENCE");
    const named = result(receipt, "fixture-work");
    named.evidence.push({ artifactId: "external-input", kind: "file", locator: "fixture:external", verified: true, note: "Named input." });
    const passed = h.service.recordStageResult(named);
    expect(passed.error).toBeNull();
    expect(passed.data!.unverifiedClaims).toContainEqual({ stageId: named.stageId, claim: "evidence-content", artifactId: "external-input" });
  });

  it.each(["artifactChecks", "recordedBy"])("rejects a caller-supplied server field %s", (field) => {
    const h = harness([provider({})]);
    const receipt = running(h);
    const rejected = h.service.recordStageResult({ ...result(receipt, "fixture-work"), [field]: [] });
    expect(rejected.error?.code).toBe("INVALID_INPUT");
    expect(rejected.error?.details).toMatchObject({ reason: "SERVER_OWNED_FIELD" });
  });
});

describe("D-0097 and D-0040 mandatory audit", () => {
  it("rejects a declared auditor that is the observed recorder", () => {
    const h = harness([auditProvider]);
    const receipt = running(h, "post-execution");
    const failed = h.service.recordStageResult(result(receipt, "independent-audit", auditOutput({ auditorId: root.actor, implementationActorIds: ["x"] })), false, root);
    expect(failed.error?.code).toBe("GATE_FAILED");
    expect(failed.error?.details).toMatchObject({ reason: "AUDITOR_IS_OBSERVED_ROOT" });
  });

  it("records what AGS did not observe after a PASS finalizes", () => {
    const h = harness([auditProvider]);
    const receipt = running(h, "post-execution");
    const recorded = h.service.recordStageResult(result(receipt, "independent-audit", auditOutput()), false, root);
    expect(recorded.error).toBeNull();
    const finalized = h.service.finalizeWorkflow(receipt.runId, recorded.data!.revision);
    expect(finalized.data?.state).toBe("passed");
    const stageId = stage(receipt, "independent-audit").stageId;
    for (const claim of ["actor-independence", "fresh-context", "no-redelegation", "post-execution-state"]) {
      expect(finalized.data!.unverifiedClaims).toContainEqual({ stageId, claim });
    }
  });

  it("rejects an audit target that is not the planned gate-verdict target", () => {
    const h = harness([auditProvider]);
    const receipt = running(h, "post-execution");
    const other = `sha256:${"c".repeat(64)}`;
    const failed = h.service.recordStageResult(result(receipt, "independent-audit", auditOutput({ auditTarget: other, currentTarget: other })));
    expect(failed.error?.code).toBe("GATE_FAILED");
    expect(failed.error?.details).toMatchObject({ reason: "AUDIT_TARGET_NOT_PLANNED" });
  });

  it("rejects finalization after an audited file changed", () => {
    const h = harness([auditProvider]);
    const receipt = running(h, "post-execution");
    const audited = result(receipt, "independent-audit", auditOutput());
    const locator = file("audited bytes", "gate-verdict.json");
    audited.output.artifacts[0]!.locator = locator;
    audited.output.artifacts[0]!.digest = digest("audited bytes");
    const recorded = h.service.recordStageResult(audited);
    expect(recorded.error).toBeNull();
    writeFileSync(locator, "changed after the audit");
    const failed = h.service.finalizeWorkflow(receipt.runId, recorded.data!.revision);
    expect(failed.error?.code).toBe("GATE_FAILED");
    expect(failed.error?.details).toMatchObject({ reason: "AUDIT_TARGET_CHANGED" });
  });

  it.each([
    ["the implementer itself", observed("host:impl"), "violated"],
    ["a child the implementer delegated", observed("host:auditor", ["host:root", "host:impl"]), "violated"],
    ["a sibling of the implementer", observed("host:auditor", ["host:root"]), "verified"],
    ["a caller without observed identity", root, "unobserved"],
  ] as const)("compares host-observed actors when the auditor is %s", (_name, auditor, expected) => {
    const h = harness([provider({}), auditProvider]);
    const receipt = running(h, "post-execution");
    const work = h.service.recordStageResult(result(receipt, "fixture-work"), false, observed("host:impl", ["host:root"]));
    expect(work.error).toBeNull();
    const audited = h.service.recordStageResult(result(work.data!, "independent-audit", auditOutput()), false, auditor);
    const stageId = stage(receipt, "independent-audit").stageId;
    if (expected === "violated") {
      expect(audited.error?.code).toBe("GATE_FAILED");
      expect(audited.error?.details).toMatchObject({ reason: "AUDITOR_NOT_INDEPENDENT" });
      return;
    }
    expect(audited.error).toBeNull();
    expect(audited.data!.stageResults.at(-1)!.recordedBy).toEqual(auditor);
    const claims = audited.data!.unverifiedClaims.filter((item) => item.stageId === stageId).map((item) => item.claim);
    expect(claims).toContain("fresh-context");
    if (expected === "verified") expect(claims).not.toContain("actor-independence");
    else expect(claims).toEqual(expect.arrayContaining(["actor-independence", "no-redelegation"]));
  });
});

describe("D-0165 and D-0047 convergence root", () => {
  function gatedRoot(h: Harness, implementer: ObservedCallerV1 | null = null): string {
    const rootId = openRoot(h);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      abortedAttempt(h, rootId, attempt, implementer ? (receipt) => {
        const recorded = h.service.recordStageResult(result(receipt, "fixture-work"), false, implementer);
        expect(recorded.error).toBeNull();
        return recorded.data!;
      } : undefined);
    }
    expect(status(h, rootId).root.state).toBe("needs-review");
    return rootId;
  }

  it("takes the lease actor from the observed caller and rejects a declared one", () => {
    const h = harness([provider({})]);
    const rootId = openRoot(h);
    expect(claim(h, rootId, null, root).actorId).toBe(root.actor);
    const declared = h.service.claimWorkflowAttempt({ ...proposal(h, rootId, null), actorId: "declared-actor" }, false, root);
    expect(declared.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects implementationActorIds and records reviewer claims", () => {
    const h = harness([provider({})]);
    const rootId = gatedRoot(h);
    const declared = h.service.resolveConvergenceGate(review(rootId, status(h, rootId), { implementationActorIds: ["impl"] }), root);
    expect(declared.error?.code).toBe("INVALID_INPUT");
    const resolved = h.service.resolveConvergenceGate(review(rootId, status(h, rootId)), root);
    expect(resolved.error).toBeNull();
    expect(resolved.data!.unverifiedClaims).toEqual(expect.arrayContaining([
      { stageId: null, claim: "reviewer-independence" }, { stageId: null, claim: "fresh-context" },
    ]));
  });

  it("rejects an observed implementer reviewing its own lineage and verifies a separate observed reviewer", () => {
    const h = harness([provider({})]);
    const implementer = observed("host:impl", ["host:root"]);
    const rootId = gatedRoot(h, implementer);
    const own = h.service.resolveConvergenceGate(review(rootId, status(h, rootId)), implementer);
    expect(own.error?.code).toBe("GATE_FAILED");
    expect(own.error?.details).toMatchObject({ reason: "REVIEWER_NOT_INDEPENDENT" });
    const separate = observed("host:reviewer", ["host:root"]);
    const resolved = h.service.resolveConvergenceGate(review(rootId, status(h, rootId)), separate);
    expect(resolved.error).toBeNull();
    expect(resolved.data!.reviews.at(-1)!.observedReviewer).toEqual({ ...separate, independence: "verified" });
    expect(resolved.data!.unverifiedClaims).not.toContainEqual({ stageId: null, claim: "reviewer-independence" });
    expect(resolved.data!.unverifiedClaims).toContainEqual({ stageId: null, claim: "fresh-context" });
  });

  it("records that the approval of a replacement root was not observed", () => {
    const h = harness([provider({})]);
    const parent = gatedRoot(h);
    const replacement = openRoot(h, parent);
    expect(status(h, replacement).unverifiedClaims).toContainEqual({ stageId: null, claim: "user-approval" });
  });
});

describe("D-0339 lineage baseline", () => {
  it("rejects a replacement root that re-captures a different baseline", () => {
    const h = harness([provider({ capabilities: ["change-scope-baseline-capture"] })]);
    const baseline = (manifestSha256: string) => (receipt: WorkflowReceiptV1) => h.service.recordStageResult(
      result(receipt, "change-scope-baseline-capture", { manifestSha256 }), false, root);
    const parent = openRoot(h);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      abortedAttempt(h, parent, attempt, (receipt) => baseline("M1")(receipt).data!);
    }
    const replacement = openRoot(h, parent);
    const receipt = startLease(h, claim(h, replacement, null));
    const rebound = baseline("M2")(receipt);
    expect(rebound.error?.code).toBe("BINDING_INVALID");
    expect(rebound.error?.details).toMatchObject({ reason: "BASELINE_REBOUND" });
    expect(baseline("M1")(receipt).error).toBeNull();
  });
});

describe("D-0049 and D-0141 deliberation", () => {
  const record = JSON.parse(readFileSync(path.join(repository,
    "skills/independent-deliberation-panel/evals/fixtures/valid/rc03_high_fresh_judge.json"), "utf8")) as Record<string, unknown> & {
    cross_examination: { coverage: unknown[]; followups: unknown[] };
  };

  function pythonValid(decisionRecord: unknown): boolean {
    const locator = file(JSON.stringify(decisionRecord), "record.json");
    const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const run = spawnSync(python, ["-B",
      path.join(repository, "skills/independent-deliberation-panel/scripts/validate_decision_record.py"), locator, "--json"], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(run.error, run.stderr).toBeUndefined();
    return (JSON.parse(run.stdout) as { valid: boolean }).valid;
  }

  it("rejects coverage whose non-origin reviewer has no follow-up, as the Python validator does", () => {
    const defective = structuredClone(record);
    defective.cross_examination.coverage = [{ item_id: "T1", reviewer_ids: ["r1", "r2"] }];
    defective.cross_examination.followups = [{ reviewer_id: "r1", item_ids: ["T1"] }];
    expect(validateDecisionRecordSemantics(defective)).toContain("cross coverage must have a matching follow-up");
    expect(pythonValid(defective)).toBe(false);
    expect(validateDecisionRecordSemantics(record)).toEqual([]);
    expect(pythonValid(record)).toBe(true);
  });
});

describe("workflow DB v6 migration", () => {
  it("closes an open pre-v6 run as blocked and recomputes the lease proposal digest", () => {
    const databasePath = path.join(scratch(), "workflows.sqlite3");
    let store = new SqliteWorkflowStore(databasePath);
    const h = harness([provider({})], store);
    const rootId = openRoot(h);
    const lease = claim(h, rootId, null);
    const receipt = startLease(h, lease);
    store.close();

    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT proposal_json FROM convergence_leases WHERE lease_id = ?").get(lease.leaseId) as { proposal_json: string };
    const legacy = { ...JSON.parse(row.proposal_json), actorId: "declared-actor" };
    database.prepare("UPDATE convergence_leases SET proposal_json = ? WHERE lease_id = ?").run(JSON.stringify(legacy), lease.leaseId);
    database.exec("PRAGMA user_version = 5;");
    database.close();

    store = new SqliteWorkflowStore(databasePath);
    try {
      const migrated = store.getRun(receipt.runId)!;
      expect(migrated).toMatchObject({ state: "blocked", unverifiedClaims: [] });
      expect(migrated.blockers).toContain("pre-3.0-gate-contract");
      const snapshot = store.getConvergenceSnapshot(rootId)!;
      const proposal: Record<string, unknown> = { ...legacy };
      delete proposal.actorId;
      expect(snapshot.leases[0]).toMatchObject({ actorId: null, priorEvidenceDigests: [], proposalDigest: convergenceDigest(proposal) });
      expect(snapshot.outcomes.at(-1)).toMatchObject({ workflowRunId: receipt.runId, state: "aborted" });
      expect(snapshot.root.state).toBe("open");
    } finally {
      store.close();
    }
  });
});
