import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactDigest, InputError, reviewRequestDigest, validateRequest, validateReview } from "../../skills/iteration-frame-auditor/scripts/core.mjs";
import { compileAllSchemas } from "../../skills/iteration-frame-auditor/scripts/schema-validation.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "iteration-frame-auditor");
const fixture = async (name) => JSON.parse(await readFile(path.join(testRoot, "fixtures", `${name}.json`), "utf8"));

function hydrateDigests(request) {
  const makeFrame = (control, target) => ({
    schemaVersion: "1.0.0",
    workspace: { workspaceId: "workspace-1", locator: request.root.contract.workspace },
    controlArtifacts: [
      { artifactId: "validator", role: "validator", locator: "artifact://control/validator", digest: artifactDigest(control.verifier) },
      { artifactId: "aggregation", role: "aggregation", locator: "artifact://control/aggregation", digest: artifactDigest(control.aggregation) },
      { artifactId: "pass-condition", role: "pass-condition", locator: "artifact://control/pass-condition", digest: artifactDigest(control.passCondition) },
      { artifactId: "evaluation-inputs", role: "evaluation-input", locator: "artifact://control/evaluation-inputs", digest: artifactDigest(control.evaluationInputs) }
    ],
    targetArtifacts: [
      { artifactId: "candidate", role: "candidate", locator: "artifact://target/candidate", digest: artifactDigest(target.candidate) },
      { artifactId: "files", role: "target", locator: "artifact://target/files", digest: artifactDigest(target.files) }
    ],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 900 }
  });

  request.root.revision = 7;
  request.root.frame = makeFrame(request.root.controlFrame, request.root.targetFrame);
  request.proposal.frame = makeFrame(request.proposal.controlFrame, request.proposal.targetFrame);
  delete request.root.controlFrame;
  delete request.root.targetFrame;
  delete request.proposal.controlFrame;
  delete request.proposal.targetFrame;
  request.root.contractDigest = artifactDigest(request.root.contract);
  request.root.frameDigest = artifactDigest(request.root.frame);
  request.root.controlDigest = artifactDigest(request.root.frame.controlArtifacts);
  request.root.targetDigest = artifactDigest(request.root.frame.targetArtifacts);
  request.proposal.contractDigest = artifactDigest(request.proposal.contract);
  request.proposal.frameDigest = artifactDigest(request.proposal.frame);
  request.proposal.controlDigest = artifactDigest(request.proposal.frame.controlArtifacts);
  request.proposal.targetDigest = artifactDigest(request.proposal.frame.targetArtifacts);
  request.reviewer.freshContextEvidenceRef = "evidence-reviewer";
  request.evidenceInventory.push({
    evidenceRef: "evidence-reviewer",
    artifactDigest: `sha256:${"5".repeat(64)}`,
    locator: "artifact://reviewer/fresh-context-assignment",
    kind: "reviewer-separation",
    verified: true
  });
  return request;
}

function materializeOutputs(template, request) {
  const requestArtifactDigest = reviewRequestDigest(request);
  const comparison = {
    schemaVersion: "1.0.0",
    rootId: template.rootId,
    reviewedEpoch: template.reviewedEpoch,
    requestArtifactDigest,
    reviewer: structuredClone(template.reviewer),
    comparisons: structuredClone(template.comparisons),
    evidenceRefs: [...template.evidenceRefs, "evidence-reviewer"],
    rationale: structuredClone(template.rationale),
    limitations: structuredClone(template.limitations)
  };
  const review = {
    schemaVersion: "1.0.0",
    reviewId: "review-1",
    rootId: template.rootId,
    rootRevision: request.root.revision,
    epoch: request.root.epoch,
    reviewerActorId: template.reviewer.actorId,
    implementationActorIds: [...request.reviewer.implementationActorIds],
    freshContext: { confirmed: true, evidenceRef: "evidence-reviewer" },
    classification: template.classification,
    comparability: {
      comparable: template.comparability === "comparable",
      rationale: template.rationale[0].statement
    },
    route: template.route,
    proposedFrame: structuredClone(request.proposal.frame),
    evidenceRefs: [...template.evidenceRefs, "evidence-reviewer"],
    userApprovalRefs: [],
    reviewedAt: "2026-09-13T00:00:00.000Z"
  };
  return { request, comparison, review };
}

async function loadCase(name) {
  const base = await fixture("normal-target-only");
  if (name === "normal-target-only") {
    hydrateDigests(base.request);
    return materializeOutputs(base.review, base.request);
  }

  const overlay = await fixture(name);
  if (overlay.proposalControlFrame) base.request.proposal.controlFrame = overlay.proposalControlFrame;
  if (overlay.proposalAcceptanceCriteria) base.request.proposal.contract.acceptanceCriteria = overlay.proposalAcceptanceCriteria;
  if (overlay.additionalChange) base.request.proposal.changeSummary.push(overlay.additionalChange);
  if (overlay.contractImpact) base.review.comparisons.contract.impact = overlay.contractImpact;
  if (overlay.contractChangedPaths) base.review.comparisons.contract.changedPaths = overlay.contractChangedPaths;
  if (overlay.controlImpact) base.review.comparisons.control.impact = overlay.controlImpact;
  if (overlay.controlChangedPaths) base.review.comparisons.control.changedPaths = overlay.controlChangedPaths;
  for (const key of ["classification", "comparability", "route", "userValueChange"]) base.review[key] = overlay[key];
  hydrateDigests(base.request);
  return materializeOutputs(base.review, base.request);
}

const boundErrors = (review, comparison, request) => validateReview(review, comparison, request, reviewRequestDigest(request));

test("normal: target-only correction can recommend a new epoch", async () => {
  const { request, review, comparison } = await loadCase("normal-target-only");
  assert.doesNotThrow(() => validateRequest(request));
  assert.deepEqual(boundErrors(review, comparison, request), []);
  assert.equal(review.classification, "semantics-preserving");
  assert.equal(review.route, "resume-new-epoch");
});

test("boundary: a frame change before the first attempt can be independently reviewed", async () => {
  const { request, review, comparison } = await loadCase("failure-user-value-change");
  request.attemptHistory = [];
  request.reviewer.implementationActorIds = [];
  request.evidenceInventory = request.evidenceInventory.filter((item) => item.kind !== "attempt-outcome");
  comparison.evidenceRefs = comparison.evidenceRefs.filter((ref) => ref !== "evidence-attempt");
  comparison.rationale.forEach((item) => {
    item.evidenceRefs = item.evidenceRefs.filter((ref) => ref !== "evidence-attempt");
  });
  review.implementationActorIds = [];
  review.evidenceRefs = review.evidenceRefs.filter((ref) => ref !== "evidence-attempt");
  comparison.requestArtifactDigest = reviewRequestDigest(request);

  assert.doesNotThrow(() => validateRequest(request));
  assert.deepEqual(boundErrors(review, comparison, request), []);
  assert.equal(review.route, "needs-user");
});

test("boundary: evidence-backed control equivalence remains comparable", async () => {
  const { request, review, comparison } = await loadCase("boundary-control-equivalent");
  assert.notEqual(request.root.controlDigest, request.proposal.controlDigest);
  assert.deepEqual(boundErrors(review, comparison, request), []);
  assert.equal(comparison.comparisons.control.impact, "semantics-preserving");
});

test("boundary: uncertain control meaning routes only to the independent panel", async () => {
  const { request, review, comparison } = await loadCase("failure-ambiguous");
  assert.deepEqual(boundErrors(review, comparison, request), []);
  assert.equal(review.classification, "ambiguous");
  assert.equal(review.route, "panel");

  review.route = "resume-new-epoch";
  assert.ok(boundErrors(review, comparison, request).some((item) => item.includes("must route to panel")));
});

test("expected failure: changed user acceptance values route to the user", async () => {
  const { request, review, comparison } = await loadCase("failure-user-value-change");
  assert.notEqual(request.root.contractDigest, request.proposal.contractDigest);
  assert.deepEqual(boundErrors(review, comparison, request), []);
  assert.equal(review.classification, "semantics-changing");
  assert.equal(review.route, "needs-user");

  review.classification = "semantics-preserving";
  review.comparability.comparable = true;
  review.route = "resume-new-epoch";
  const errors = boundErrors(review, comparison, request);
  assert.ok(errors.some((item) => item.includes("semantics-changing")));
  assert.ok(errors.some((item) => item.includes("needs-user")));
});

test("expected failure: reviewer must be fresh and distinct from every implementation actor", async () => {
  const { request } = await loadCase("normal-target-only");
  request.reviewer.actorId = "worker-1";
  assert.throws(() => validateRequest(request), InputError);

  const nonFresh = await loadCase("normal-target-only");
  nonFresh.request.reviewer.freshContext = false;
  assert.throws(() => validateRequest(nonFresh.request), /IterationFrameAuditRequest/u);
});

test("expected failure: implementation actor inventory cannot omit an attempt actor", async () => {
  const { request } = await loadCase("normal-target-only");
  request.attemptHistory.push({
    attemptId: "attempt-2",
    epoch: 1,
    sequence: 2,
    implementationActorIds: ["worker-2"],
    outcome: "failed",
    failureFingerprint: `sha256:${"b".repeat(64)}`,
    evidenceRefs: ["evidence-attempt"]
  });
  assert.throws(() => validateRequest(request), /exactly match implementation actors/u);
});

test("expected failure: every comparison and attempt requires verified, typed evidence", async () => {
  const { request, review, comparison } = await loadCase("normal-target-only");
  comparison.comparisons.control.evidenceRefs = ["evidence-target"];
  assert.ok(boundErrors(review, comparison, request).some((item) => item.includes("control-comparison evidence")));

  request.attemptHistory[0].evidenceRefs = ["evidence-control"];
  assert.throws(() => validateRequest(request), /attempt-outcome evidence/u);
});

test("expected failure: an unchanged target cannot resume a new epoch", async () => {
  const { request, review, comparison } = await loadCase("normal-target-only");
  request.proposal.frame.targetArtifacts = structuredClone(request.root.frame.targetArtifacts);
  request.proposal.targetDigest = artifactDigest(request.proposal.frame.targetArtifacts);
  request.proposal.frameDigest = artifactDigest(request.proposal.frame);
  review.proposedFrame = structuredClone(request.proposal.frame);
  comparison.requestArtifactDigest = reviewRequestDigest(request);
  comparison.comparisons.target = { impact: "unchanged", changedPaths: [], evidenceRefs: ["evidence-target"] };
  const errors = boundErrors(review, comparison, request);
  assert.ok(errors.some((item) => item.includes("incompatible route")));
  assert.ok(errors.some((item) => item.includes("actual target change")));
});

test("review validation rejects a substituted request after its digest was frozen", async () => {
  const { request, review, comparison } = await loadCase("normal-target-only");
  const frozen = reviewRequestDigest(request);
  request.proposal.frame.targetArtifacts[0].digest = artifactDigest("substituted-candidate");
  request.proposal.targetDigest = artifactDigest(request.proposal.frame.targetArtifacts);
  request.proposal.frameDigest = artifactDigest(request.proposal.frame);
  const errors = validateReview(review, comparison, request, frozen);
  assert.ok(errors.some((item) => item.includes("external frozen")));
});

test("JSON CLIs read stdin and write only JSON", async () => {
  const { request, review, comparison } = await loadCase("normal-target-only");
  const digestRun = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "digest-request.mjs")], {
    encoding: "utf8",
    input: JSON.stringify(request)
  });
  assert.equal(digestRun.status, 0, digestRun.stderr || digestRun.stdout);
  const requestArtifactDigest = JSON.parse(digestRun.stdout).requestArtifactDigest;

  const validationRun = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "validate-review.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ request, requestArtifactDigest, review, comparison })
  });
  assert.equal(validationRun.status, 0, validationRun.stderr || validationRun.stdout);
  assert.deepEqual(JSON.parse(validationRun.stdout), { valid: true, errors: [] });
});

test("all skill schemas compile in strict Ajv mode", () => {
  assert.doesNotThrow(() => compileAllSchemas());
});

test("runtime scripts do not import the suite", async () => {
  for (const file of ["core.mjs", "digest-request.mjs", "validate-review.mjs"]) {
    const content = await readFile(path.join(skillRoot, "scripts", file), "utf8");
    assert.equal(content.includes("agent-governance-suite/"), false);
  }
});
