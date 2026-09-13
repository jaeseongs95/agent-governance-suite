import { createHash } from "node:crypto";

import { validateComparisonSchema, validateRequestSchema, validateReviewSchema } from "./schema-validation.mjs";

export class InputError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "InputError";
    this.details = details;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new InputError("Input contains a non-JSON value.");
}

export function artifactDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function reviewRequestDigest(request) {
  return artifactDigest(request);
}

function schemaErrors(validator) {
  return structuredClone(validator.errors ?? []);
}

function requireDigest(actual, value, label) {
  if (actual !== artifactDigest(value)) throw new InputError(`${label} does not match its canonical artifact.`);
}

function requireKnownEvidence(refs, inventory, label) {
  const known = new Set(inventory.map((item) => item.evidenceRef));
  for (const ref of refs) {
    if (!known.has(ref)) throw new InputError(`${label} references evidence outside evidenceInventory: ${ref}.`);
  }
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new InputError(`${label} must not contain duplicates.`);
}

export function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new InputError("Request must be an object.");
  if (!validateRequestSchema(request)) {
    throw new InputError("IterationFrameAuditRequest.v1 validation failed.", { errors: schemaErrors(validateRequestSchema) });
  }

  requireDigest(request.root.contractDigest, request.root.contract, "root.contractDigest");
  requireDigest(request.root.frameDigest, request.root.frame, "root.frameDigest");
  requireDigest(request.root.controlDigest, request.root.frame.controlArtifacts, "root.controlDigest");
  requireDigest(request.root.targetDigest, request.root.frame.targetArtifacts, "root.targetDigest");
  requireDigest(request.proposal.contractDigest, request.proposal.contract, "proposal.contractDigest");
  requireDigest(request.proposal.frameDigest, request.proposal.frame, "proposal.frameDigest");
  requireDigest(request.proposal.controlDigest, request.proposal.frame.controlArtifacts, "proposal.controlDigest");
  requireDigest(request.proposal.targetDigest, request.proposal.frame.targetArtifacts, "proposal.targetDigest");

  const evidenceIds = request.evidenceInventory.map((item) => item.evidenceRef);
  unique(evidenceIds, "evidenceInventory.evidenceRef");
  const requiredKinds = new Set(["contract-comparison", "control-comparison", "target-comparison", "reviewer-separation"]);
  if (request.attemptHistory.length > 0) requiredKinds.add("attempt-outcome");
  for (const item of request.evidenceInventory) requiredKinds.delete(item.kind);
  if (requiredKinds.size > 0) throw new InputError(`evidenceInventory is missing required evidence kinds: ${[...requiredKinds].join(", ")}.`);

  const attemptIds = [];
  const sequenceKeys = [];
  const implementationActors = new Set();
  for (const attempt of request.attemptHistory) {
    attemptIds.push(attempt.attemptId);
    sequenceKeys.push(`${attempt.epoch}:${attempt.sequence}`);
    if (attempt.epoch > request.root.epoch) throw new InputError(`attempt ${attempt.attemptId} belongs to a future epoch.`);
    for (const actorId of attempt.implementationActorIds) implementationActors.add(actorId);
    requireKnownEvidence(attempt.evidenceRefs, request.evidenceInventory, `attempt ${attempt.attemptId}`);
    if (!attempt.evidenceRefs.some((ref) => request.evidenceInventory.find((item) => item.evidenceRef === ref)?.kind === "attempt-outcome")) {
      throw new InputError(`attempt ${attempt.attemptId} requires attempt-outcome evidence.`);
    }
  }
  unique(attemptIds, "attemptHistory.attemptId");
  unique(sequenceKeys, "attemptHistory epoch/sequence");

  const assignedActors = new Set(request.reviewer.implementationActorIds);
  if (assignedActors.size !== implementationActors.size || [...implementationActors].some((actorId) => !assignedActors.has(actorId))) {
    throw new InputError("reviewer.implementationActorIds must exactly match implementation actors in attemptHistory.");
  }
  if (implementationActors.has(request.reviewer.actorId)) {
    throw new InputError("reviewer.actorId must be distinct from every implementation actor.");
  }
  requireKnownEvidence([request.reviewer.freshContextEvidenceRef], request.evidenceInventory, "reviewer assignment");
  if (request.evidenceInventory.find((item) => item.evidenceRef === request.reviewer.freshContextEvidenceRef)?.kind !== "reviewer-separation") {
    throw new InputError("reviewer.freshContextEvidenceRef must identify reviewer-separation evidence.");
  }

  requireKnownEvidence(request.proposal.evidenceRefs, request.evidenceInventory, "proposal");
  const changedRoles = new Set(request.proposal.changeSummary.map((item) => item.claimedRole));
  const differences = [
    ["contract", request.root.contractDigest !== request.proposal.contractDigest],
    ["control", request.root.controlDigest !== request.proposal.controlDigest],
    ["target", request.root.targetDigest !== request.proposal.targetDigest]
  ];
  for (const [role, changed] of differences) {
    if (changed && !changedRoles.has(role) && !changedRoles.has("unknown")) {
      throw new InputError(`proposal.changeSummary does not account for the changed ${role} artifact.`);
    }
  }
}

function push(errors, condition, message) {
  if (!condition) errors.push(message);
}

function evidenceKindMatches(refs, kind, inventory) {
  const byId = new Map(inventory.map((item) => [item.evidenceRef, item]));
  return refs.some((ref) => byId.get(ref)?.kind === kind);
}

function checkComparisonShape(errors, comparison, expectedChanged, label) {
  const unchanged = comparison.impact === "unchanged";
  push(errors, unchanged === !expectedChanged, `${label}.impact conflicts with canonical artifact equality`);
  push(errors, unchanged ? comparison.changedPaths.length === 0 : comparison.changedPaths.length > 0, `${label}.changedPaths conflicts with impact`);
}

export function validateReview(review, comparison = null, request = null, frozenRequestArtifactDigest = null) {
  const errors = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) return ["review must be an object"];
  if (!validateReviewSchema(review)) return [`review schema validation failed: ${JSON.stringify(schemaErrors(validateReviewSchema))}`];
  if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) return ["iteration frame comparison is required"];
  if (!validateComparisonSchema(comparison)) return [`comparison schema validation failed: ${JSON.stringify(schemaErrors(validateComparisonSchema))}`];
  if (!request) errors.push("the original audit request is required");
  if (typeof frozenRequestArtifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(frozenRequestArtifactDigest)) {
    errors.push("a valid external frozen request artifact digest is required");
  }
  if (!request) return errors;

  try {
    validateRequest(request);
  } catch (error) {
    errors.push(`request cannot substantiate review: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }

  const computedRequestDigest = reviewRequestDigest(request);
  if (computedRequestDigest !== frozenRequestArtifactDigest) errors.push("the request does not match the external frozen request artifact digest");
  if (comparison.requestArtifactDigest !== frozenRequestArtifactDigest) errors.push("comparison.requestArtifactDigest does not match the external frozen request artifact digest");
  if (review.rootId !== request.root.rootId) errors.push("review.rootId does not match request.root.rootId");
  if (review.rootRevision !== request.root.revision) errors.push("review.rootRevision does not match request.root.revision");
  if (review.epoch !== request.root.epoch) errors.push("review.epoch does not match request.root.epoch");
  if (review.reviewerActorId !== request.reviewer.actorId) errors.push("review.reviewerActorId does not match the assigned reviewer");
  if (review.freshContext.confirmed !== true) errors.push("reviewer must attest freshContext.confirmed true");
  if (review.freshContext.evidenceRef !== request.reviewer.freshContextEvidenceRef) errors.push("review fresh-context evidence does not match the reviewer assignment");
  if (request.reviewer.implementationActorIds.includes(review.reviewerActorId)) errors.push("reviewer must be distinct from implementation actors");
  const expectedActors = [...request.reviewer.implementationActorIds].sort();
  if (canonicalJson([...review.implementationActorIds].sort()) !== canonicalJson(expectedActors)) errors.push("review.implementationActorIds must match the frozen implementation actor inventory");
  if (review.proposedFrame === null || artifactDigest(review.proposedFrame) !== request.proposal.frameDigest) errors.push("review.proposedFrame does not match the proposed frame artifact");

  if (comparison.rootId !== request.root.rootId) errors.push("comparison.rootId does not match request.root.rootId");
  if (comparison.reviewedEpoch !== request.root.epoch) errors.push("comparison.reviewedEpoch does not match request.root.epoch");
  if (comparison.reviewer.actorId !== request.reviewer.actorId || comparison.reviewer.freshContext !== true) errors.push("comparison reviewer does not match the fresh reviewer assignment");

  const comparisons = comparison.comparisons;
  const contractChanged = request.root.contractDigest !== request.proposal.contractDigest;
  const controlChanged = request.root.controlDigest !== request.proposal.controlDigest;
  const targetChanged = request.root.targetDigest !== request.proposal.targetDigest;
  checkComparisonShape(errors, comparisons.contract, contractChanged, "comparisons.contract");
  checkComparisonShape(errors, comparisons.control, controlChanged, "comparisons.control");
  checkComparisonShape(errors, comparisons.target, targetChanged, "comparisons.target");

  if (contractChanged && comparisons.contract.impact !== "semantics-changing") {
    errors.push("a changed immutable contract must be classified as semantics-changing");
  }
  if (!controlChanged && comparisons.control.impact !== "unchanged") errors.push("an identical control frame must be classified as unchanged");
  if (!targetChanged && comparisons.target.impact !== "unchanged") errors.push("an identical target frame must be classified as unchanged");

  const inventory = request.evidenceInventory;
  const evidenceGroups = [
    [comparisons.contract.evidenceRefs, "contract-comparison", "contract comparison"],
    [comparisons.control.evidenceRefs, "control-comparison", "control comparison"],
    [comparisons.target.evidenceRefs, "target-comparison", "target comparison"]
  ];
  for (const [refs, kind, label] of evidenceGroups) {
    try {
      requireKnownEvidence(refs, inventory, label);
      if (!evidenceKindMatches(refs, kind, inventory)) errors.push(`${label} requires ${kind} evidence`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [label, refs] of [
    ["review", review.evidenceRefs ?? []],
    ["comparison", comparison.evidenceRefs ?? []],
    ["rationale", (comparison.rationale ?? []).flatMap((item) => item.evidenceRefs ?? [])]
  ]) {
    try {
      requireKnownEvidence(refs, inventory, label);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (request.attemptHistory.length > 0 && !evidenceKindMatches(review.evidenceRefs ?? [], "attempt-outcome", inventory)) {
    errors.push("review evidence must include attempt-outcome evidence when attempt history is non-empty");
  }
  if (!evidenceKindMatches(review.evidenceRefs ?? [], "reviewer-separation", inventory)) errors.push("review evidence must include reviewer-separation evidence");
  for (const ref of comparison.evidenceRefs) {
    if (!review.evidenceRefs.includes(ref)) errors.push(`review.evidenceRefs does not include comparison evidence ${ref}`);
  }

  const unknownRole = request.proposal.changeSummary.some((item) => item.claimedRole === "unknown");
  const uncertain = unknownRole || comparisons.contract.impact === "uncertain" || comparisons.control.impact === "uncertain" || comparisons.target.impact === "uncertain";
  const semanticChange = comparisons.contract.impact === "semantics-changing" || comparisons.control.impact === "semantics-changing";

  if (uncertain) {
    push(errors, review.classification === "ambiguous", "uncertain or unknown changes require classification ambiguous");
    push(errors, review.comparability.comparable === false, "ambiguous changes must be non-comparable");
    push(errors, review.route === "panel", "ambiguous changes must route to panel");
  } else if (semanticChange) {
    push(errors, review.classification === "semantics-changing", "semantic frame changes require classification semantics-changing");
    push(errors, review.comparability.comparable === false, "semantics-changing review must be non-comparable");
    push(errors, review.route === "needs-user", "semantics-changing review must route to needs-user");
  } else {
    push(errors, review.classification === "semantics-preserving", "stable contract and control semantics require classification semantics-preserving");
    push(errors, review.comparability.comparable === true, "semantics-preserving review must be comparable");
    const allowedRoutes = targetChanged ? ["resume-new-epoch", "diagnose", "stop"] : ["diagnose", "stop"];
    push(errors, allowedRoutes.includes(review.route), `semantics-preserving ${targetChanged ? "changed" : "unchanged"} target has incompatible route`);
  }

  if (review.route === "resume-new-epoch") {
    push(errors, targetChanged, "resume-new-epoch requires an actual target change");
    push(errors, comparisons.target.impact === "changed", "resume-new-epoch requires target impact changed");
  }
  return errors;
}
